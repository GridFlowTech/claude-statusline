#!/usr/bin/env node
'use strict';
/* ============================================================================
 * Claude Code statusline  —  Node.js implementation (Windows-first)
 * ----------------------------------------------------------------------------
 * WHY NODE AND NOT POWERSHELL
 *   Claude Code re-runs the statusline command on every assistant message,
 *   /compact, permission-mode change and vim-mode toggle, debounced at 300ms.
 *   `powershell.exe` costs ~600-900ms of boot before a single byte is printed,
 *   which makes the bar visibly stutter. `node` cold-starts in ~35-50ms and we
 *   only ever require() built-ins (fs / path / os) -- no module resolution walk
 *   and no network on the render path. One synchronous stdout write at the end.
 *   `https` and `crypto` are required lazily, inside the detached self-update
 *   child only, so a normal render never pays for loading them.
 *
 * CONTRACT
 *   stdin  : one JSON object (schema: https://code.claude.com/docs/en/statusline)
 *   stdout : 4 lines, plus an optional 5th when a named agent is active.
 *              1. model and mode flags
 *              2. runway   -- context, cache, LngCtx, both rate-limit windows
 *              3. money    -- session / day / week / month, and burn rate
 *              4. place    -- repo, branch and working-tree state, session name
 *
 *   The optional 5th row reads `agent.name`, which is the SESSION's own agent
 *   (--agent flag or agent settings), not a Task-tool subagent. Per-subagent
 *   rows are a separate `subagentStatusLine` setting entirely.
 *   Nothing is ever thrown out of this file. A crash would blank the user's
 *   status bar, so every stage is individually guarded and the top level has a
 *   last-resort catch that still prints something useful.
 *
 * NULL SAFETY
 *   Per the docs, `context_window.current_usage` is null before the first API
 *   call of a session AND again after /compact until the next response.
 *   `used_percentage` / `remaining_percentage` may be null early on, and the
 *   whole `rate_limits` object is absent on API/enterprise billing. Therefore
 *   every single field read below goes through `?.` + `??` or a numeric
 *   coercion helper. Never assume an object exists just because its parent did.
 * ========================================================================== */

const fs = require('fs');
const path = require('path');
const os = require('os');

// Windows resolves a bare executable name against the CHILD's cwd before PATH,
// so a hostile repo could ship its own git.exe and have it spawned on every
// render. This env var (honoured by CreateProcess, and by libuv on Node 18+)
// removes cwd from that search. Meaningless elsewhere, so set unconditionally.
if (process.platform === 'win32') process.env.NoDefaultCurrentDirectoryInExePath = '1';

/* ---------------------------------------------------------------------------
 * Tunables. Edit these; everything below reads from here.
 * ------------------------------------------------------------------------ */

// Prefix each cost amount with a dim S / D / W / M key (session, day, week,
// month). Set false for bare amounts ("$0.12 · $3.40 · ..."), which is 8
// columns narrower but relies on you remembering the order.
const SHOW_COST_LABELS = true;

// Some Windows console fonts (raster "Terminal", older Consolas fallbacks)
// render U+2191/2192/2193 as boxes. Set CC_STATUSLINE_ASCII=1 to get ^ = v.
const ASCII_ARROWS = process.env.CC_STATUSLINE_ASCII === '1';

// Sessions older than this drop out of the ledger so the file stays small and
// the monthly roll-up stays fast. 45d covers "current month" from any day.
const LEDGER_RETENTION_DAYS = 45;

// Hard cap on transcript bytes parsed in a single render. A first render
// against a pathologically large transcript would otherwise block the bar and
// balloon memory. Skipping ahead undercounts tokens once, on files that
// should not exist in practice.
const TRANSCRIPT_MAX_READ_BYTES = 32 * 1024 * 1024;

// Rate-limit window lengths, in seconds. Fixed by the product, not by payload.
const FIVE_HOUR_SECONDS = 18000;   // 5 * 3600
const SEVEN_DAY_SECONDS = 604800;  // 7 * 86400

// Pace arrows are meaningless in the first sliver of a window: with `elapsed`
// near zero the expected% is ~0, so any usage at all reads as "burning fast"
// and projects an absurd exhaustion time. Suppress until 2% of the window has
// passed (6 min into a 5h window, ~3.4h into a 7d window). Same guard as the
// reference bash implementation.
const PACE_MIN_ELAPSED_FRACTION = 1 / 50;

// On-pace band, expressed as the projected end-of-window percentage:
//   projected% = used% * duration / elapsed
// i.e. "if I keep burning at this rate, where do I land when the window
// resets". Above 115 is burning fast, below 85 is under-consuming, between is
// on pace. This is a RATIO band, not a fixed point spread, which is what makes
// it behave sensibly at both ends of a window -- a 5-point spread is far too
// tight at hour 4 of 5 and far too loose at hour 1.
const PACE_FAST_PROJECTED = 115;
const PACE_SLOW_PROJECTED = 85;

/* ---------------------------------------------------------------------------
 * Budget. API keys, Bedrock, Vertex and Enterprise deployments are billed, not
 * rate-limited, so the host never sends `rate_limits` for them and the 5h/7d
 * cells have nothing to show. Configure a dollar allocation and those two slots
 * become a spend gauge against it instead. All optional; unset means the cell
 * simply collapses.
 *
 *   CC_STATUSLINE_BUDGET=250            the allocation, in dollars
 *   CC_STATUSLINE_BUDGET_PERIOD=month   day | week | month   (default month)
 *   CC_STATUSLINE_BUDGET_RESET=17:00    local time of day the period rolls over
 *   CC_STATUSLINE_BUDGET_OFFSET=12.40   spend that predates the local ledger
 * ------------------------------------------------------------------------ */

// Parsed once here rather than per render: none of it can change without a new
// process, and every render pays for anything left in the hot path.
const BUDGET_TOTAL = (() => {
  const n = Number(process.env.CC_STATUSLINE_BUDGET);
  return Number.isFinite(n) && n > 0 ? n : null;
})();

const BUDGET_PERIOD = /^(day|week|month)$/.test(process.env.CC_STATUSLINE_BUDGET_PERIOD || '')
  ? process.env.CC_STATUSLINE_BUDGET_PERIOD
  : 'month';

// [hour, minute], or null for the plain calendar boundary (midnight).
//
// With a reset time set, a `month` period closes on the LAST DAY of the month
// at that time -- not on the 1st -- because that is where the Console billing
// period actually ends. `day` and `week` close at that time on the day itself.
const BUDGET_RESET = (() => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(process.env.CC_STATUSLINE_BUDGET_RESET || '');
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h < 24 && min < 60 ? [h, min] : null;
})();

// The local ledger only knows the sessions it saw. Installed mid-period, or
// billed for work done on another machine, it under-reports -- this adds the
// missing dollars back so the gauge lines up with the Console.
const BUDGET_OFFSET = (() => {
  const n = Number(process.env.CC_STATUSLINE_BUDGET_OFFSET);
  return Number.isFinite(n) && n > 0 ? n : 0;
})();

/* ---------------------------------------------------------------------------
 * Git. One subprocess per render, and only when we are actually inside a repo.
 * ------------------------------------------------------------------------ */

// A hung git (network filesystem, index.lock contention) must never freeze the
// status bar. spawnSync kills the child at this deadline.
const GIT_TIMEOUT_MS = 800;

// Background `git fetch` debounce, per branch. Matches the reference.
const FETCH_DEBOUNCE_SECONDS = 600;

// Set CC_STATUSLINE_NOGIT=1 to skip the git subprocess entirely.
const GIT_ENABLED = process.env.CC_STATUSLINE_NOGIT !== '1';

/* ---------------------------------------------------------------------------
 * ANSI. Honors the NO_COLOR convention (https://no-color.org) and skips colour
 * when the output is being captured by something that asked for plain text.
 * ------------------------------------------------------------------------ */

const USE_COLOR = !process.env.NO_COLOR && process.env.CC_STATUSLINE_NOCOLOR !== '1';
const E = '\u001b[';   // CSI as an escape, not a raw 0x1B byte
const paint = (code, s) => (USE_COLOR && s !== '' ? `${E}${code}m${s}${E}0m` : s);

const dim = (s) => paint('2', s);
const bold = (s) => paint('1', s);
const red = (s) => paint('38;5;203', s);
const yellow = (s) => paint('38;5;179', s);
const green = (s) => paint('38;5;108', s);
const cyan = (s) => paint('38;5;110', s);
const orange = (s) => paint('38;5;172', s);   // caveman plugin's own colour
const sage = (s) => paint('38;5;108', s);     // ponytail plugin's own colour
const magenta = (s) => paint('38;5;176', s);  // git branch

const SEP = dim(' · ');                   // " · "

/* ---------------------------------------------------------------------------
 * stdin
 * ------------------------------------------------------------------------ */

/** Block the thread for `ms` without spinning the CPU or the event loop. */
function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    /* SharedArrayBuffer unavailable (hardened runtime) -- fall through hot. */
  }
}

/**
 * Read all of stdin synchronously.
 *
 * `fs.readFileSync(0)` is the usual one-liner but it throws EAGAIN when the
 * parent handed us a non-blocking pipe, which does happen on Windows depending
 * on how the host spawns us. So: loop on readSync, tolerate EAGAIN with a short
 * backoff, treat EOF/0-bytes as end of stream, and hard-cap the total wait so a
 * parent that never closes the pipe can't hang the status bar forever.
 */
function readStdin() {
  const CHUNK = 65536;
  const MAX_STDIN_BYTES = 8 * 1024 * 1024;   // a parent that streams forever must not OOM us
  const buf = Buffer.alloc(CHUNK);
  const parts = [];
  const deadline = Date.now() + 500;
  let total = 0;

  for (;;) {
    let bytes;
    try {
      bytes = fs.readSync(0, buf, 0, CHUNK, null);
    } catch (err) {
      if (err && err.code === 'EAGAIN' && Date.now() < deadline) {
        sleepSync(2);
        continue;
      }
      // EOF is how Windows signals end-of-pipe on some handles; anything else
      // is unrecoverable and we just use whatever we already collected.
      break;
    }
    if (!bytes) break;
    total += bytes;
    parts.push(Buffer.from(buf.subarray(0, bytes)));
    if (total >= MAX_STDIN_BYTES) break;
  }

  return Buffer.concat(parts).toString('utf8');
}

/* ---------------------------------------------------------------------------
 * Small helpers
 * ------------------------------------------------------------------------ */

/** Coerce to a finite number, else null. Guards against null/""/NaN/"abc". */
function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 8500 -> "8,500". Purely cosmetic grouping; the value is unchanged. */
function group(n) {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function money(n) {
  return '$' + (Number.isFinite(n) ? n : 0).toFixed(2);
}

/** Epoch seconds -> local "HH:MM", 24-hour, zero-padded. */
function clock(epochSeconds) {
  const d = new Date(epochSeconds * 1000);
  if (Number.isNaN(d.getTime())) return '';
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

/** Colour a 0-100 percentage by how alarming it is. */
function pctColor(p) {
  if (p >= 90) return red;
  if (p >= 70) return yellow;
  return green;
}

/** Strip C0 AND C1 control bytes. Payload text lands in a terminal on every
 *  keystroke, and a stray ESC -- or an 8-bit CSI (U+009B), which some
 *  terminals honour just the same -- would let it inject escape sequences. */
const CONTROL_RE = /[\x00-\x1f\x7f-\x9f]/g;
const cleanText = (s) => (typeof s === 'string' ? s.replace(CONTROL_RE, '').trim() : '');

/** Honors CLAUDE_CONFIG_DIR the same way Claude Code and both plugins do. */
function claudeDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

/* ---------------------------------------------------------------------------
 * Width-aware layout
 * ----------------------------------------------------------------------------
 * Claude Code captures our stdout instead of attaching it to the terminal, so
 * `tput cols` and process.stdout.columns both read as undefined from in here.
 * The host instead exports COLUMNS/LINES before running us (v2.1.153+). If a
 * line would wrap, wrapping costs a whole extra terminal row and shuffles the
 * bar -- far worse than quietly dropping the least useful cell. So each line is
 * assembled as prioritised cells and trimmed to fit.
 *
 * cell.rank: 0 = never drop. Higher = dropped sooner.
 * ------------------------------------------------------------------------ */

const ANSI_RE = /\u001b\[[0-9;]*m/g;

/** Printable width, ignoring SGR sequences. All glyphs we emit are 1 column. */
function visibleWidth(s) {
  return String(s).replace(ANSI_RE, '').length;
}

/** Terminal width reported by the host, minus a safety column. null = unknown. */
function terminalWidth() {
  const cols = num(process.env.COLUMNS);
  if (cols === null || cols < 20) return null;   // absurd value: don't trim
  return Math.floor(cols) - 2;
}

const cell = (text, rank) => (text ? { text, rank } : null);

/** Join cells with `sep`, dropping the highest-ranked ones until it fits. */
function fit(cells, sep, maxWidth) {
  const list = cells.filter((c) => c && c.text);
  const sepW = visibleWidth(sep);
  const widthOf = (l) =>
    l.reduce((sum, c) => sum + visibleWidth(c.text), 0) + Math.max(0, l.length - 1) * sepW;

  if (maxWidth !== null) {
    while (list.length > 1 && widthOf(list) > maxWidth) {
      let victim = -1;
      let worstRank = 0;
      for (let i = 0; i < list.length; i++) {
        // `>=` so an equal-rank tie drops the RIGHTMOST cell. Trailing detail
        // disappearing before leading detail preserves reading order.
        if (list[i].rank >= worstRank && list[i].rank > 0) { worstRank = list[i].rank; victim = i; }
      }
      if (victim < 0) break;   // everything left is rank 0
      list.splice(victim, 1);
    }
  }

  return list.map((c) => c.text).join(sep);
}

/** Clip to `max` printable chars. Only ever applied to colour-free text. */
function clip(s, max) {
  const str = String(s);
  return str.length <= max ? str : str.slice(0, Math.max(1, max - 2)) + '..';
}

/* ---------------------------------------------------------------------------
 * Token-efficiency plugin detection (caveman / ponytail)
 * ----------------------------------------------------------------------------
 * Both plugins share a design: a tiny flag file under ~/.claude holding the
 * live mode string, an env var holding the *default* mode, and an optional
 * config.json. The flag file is the runtime source of truth -- the env var only
 * says what a fresh session starts as -- so it is checked first.
 *
 * Hardening (mirrors the plugins' own statusline scripts): the flag contents
 * land in a terminal, so refuse symlinks/junctions and oversized files, strip
 * everything outside [a-z0-9-], then whitelist. Without this, anything that can
 * write that path could emit escape sequences into the user's terminal on every
 * keystroke.
 * ------------------------------------------------------------------------ */

const VALID_MODES = new Set([
  'off', 'lite', 'full', 'ultra', 'review', 'commit', 'compress',
  'wenyan', 'wenyan-lite', 'wenyan-full', 'wenyan-ultra',
]);

function sanitizeMode(raw) {
  if (typeof raw !== 'string') return null;
  const m = raw.split(/\r?\n/, 1)[0].trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
  if (!m || !VALID_MODES.has(m)) return null;
  return m === 'off' ? null : m;   // "off" means installed-but-inactive
}

function readFlagFile(file) {
  try {
    const st = fs.lstatSync(file);
    if (st.isSymbolicLink() || !st.isFile() || st.size > 64) return null;
    return sanitizeMode(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;   // absent == not active; never a reason to fail a render
  }
}

function readConfigMode(pluginName) {
  const dirs = [];
  if (process.env.XDG_CONFIG_HOME) dirs.push(path.join(process.env.XDG_CONFIG_HOME, pluginName));
  if (process.platform === 'win32') {
    dirs.push(path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), pluginName));
  }
  dirs.push(path.join(os.homedir(), '.config', pluginName));

  for (const dir of dirs) {
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
      const mode = sanitizeMode(cfg && cfg.defaultMode);
      if (mode) return mode;
    } catch {
      /* missing or malformed -- try the next location */
    }
  }
  return null;
}

/**
 * @returns uppercase level string, or null when the plugin is not active.
 * Resolution order: live flag file > env default > config.json default.
 */
function detectPlugin(pluginName, envVar) {
  const mode =
    readFlagFile(path.join(claudeDir(), `.${pluginName}-active`)) ||
    sanitizeMode(process.env[envVar]) ||
    readConfigMode(pluginName);
  return mode ? mode.toUpperCase() : null;
}

/* ---------------------------------------------------------------------------
 * Git state
 * ----------------------------------------------------------------------------
 * The reference bash implementation shells out four times per render: symbolic-
 * ref, status --porcelain, and two rev-list calls for ahead/behind. On Windows
 * each process spawn costs 30-60ms, so four of them would triple the render
 * budget on their own.
 *
 * `status --porcelain=v1 --branch` returns all four answers in ONE process: the
 * branch name, the upstream tracking gap, and every file's staged/worktree
 * state. Repo root is found by walking up for `.git` in pure JS rather than
 * spending a fifth process on rev-parse --show-toplevel.
 * ------------------------------------------------------------------------ */

/** Walk up from `startDir` looking for `.git` (a dir normally, a file in a
 *  linked worktree). Returns the repo root, or null. */
function findRepoRoot(startDir) {
  let dir = startDir;
  for (let hops = 0; hops < 64; hops++) {
    try {
      if (fs.existsSync(path.join(dir, '.git'))) return dir;
    } catch {
      return null;
    }
    const parent = path.dirname(dir);
    if (!parent || parent === dir) return null;   // hit the drive root
    dir = parent;
  }
  return null;
}

/**
 * Parse `git status --porcelain=v1 --branch` into a flat summary.
 * @returns {{branch,detached,ahead,behind,staged,modified,untracked}|null}
 */
function gitStatus(cwd) {
  let res;
  try {
    const { spawnSync } = require('child_process');
    res = spawnSync(
      'git',
      ['--no-optional-locks', 'status', '--porcelain=v1', '--branch', '--untracked-files=normal'],
      { cwd, encoding: 'utf8', timeout: GIT_TIMEOUT_MS, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }
    );
  } catch {
    return null;
  }
  if (!res || res.error || res.status !== 0 || typeof res.stdout !== 'string') return null;

  const lines = res.stdout.split('\n');
  const out = { branch: '', detached: false, ahead: 0, behind: 0, staged: 0, modified: 0, untracked: 0 };

  // Header forms:
  //   ## main...origin/main [ahead 1, behind 2]
  //   ## main...origin/main [gone]
  //   ## main
  //   ## HEAD (no branch)
  //   ## No commits yet on main
  const head = lines[0] || '';
  if (head.startsWith('## ')) {
    let rest = head.slice(3);
    if (rest === 'HEAD (no branch)') {
      out.detached = true;
      out.branch = 'detached';
    } else {
      rest = rest.replace(/^(?:No commits yet on |Initial commit on )/, '');
      const gap = rest.match(/ \[(.+)\]$/);
      if (gap) {
        rest = rest.slice(0, gap.index);
        const a = gap[1].match(/ahead (\d+)/);
        const b = gap[1].match(/behind (\d+)/);
        if (a) out.ahead = Number(a[1]);
        if (b) out.behind = Number(b[1]);
      }
      // Strip the ...upstream half. Branch names may legally contain dots, so
      // split on the last occurrence rather than the first.
      const sep = rest.lastIndexOf('...');
      out.branch = sep === -1 ? rest : rest.slice(0, sep);
    }
  }

  // XY status codes. X = index/staged, Y = worktree.
  for (let i = 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.length < 2) continue;
    if (l[0] === '?' && l[1] === '?') { out.untracked++; continue; }
    if ('MADRC'.includes(l[0])) out.staged++;
    if (l[1] === 'M' || l[1] === 'D') out.modified++;
  }

  return out;
}

/**
 * Kick off a detached `git fetch` so ahead/behind counts stay meaningful.
 *
 * Deliberately narrow, matching the reference: only repos that have a `local/`
 * directory opt in, and at most once per 600s per branch. A fetch on every
 * render would hammer the remote and stall on any repo behind a slow network.
 *
 * The timestamp is stamped BEFORE spawning, so a fetch that fails still
 * debounces -- otherwise a broken remote means a fetch attempt every render.
 */
function maybeBackgroundFetch(repoRoot, branch, nowSeconds) {
  try {
    const localDir = path.join(repoRoot, 'local');
    // lstat, not stat: a repo that ships `local` as a symlink or junction must
    // not trick this into writing the lock file somewhere outside the repo.
    if (!fs.lstatSync(localDir, { throwIfNoEntry: false })?.isDirectory()) return;

    const lockPath = path.join(localDir, '.fetch-lock');

    // TSV: "<branch>\t<epoch seconds>" per line.
    const entries = new Map();
    try {
      for (const line of fs.readFileSync(lockPath, 'utf8').split('\n')) {
        const tab = line.indexOf('\t');
        if (tab > 0) entries.set(line.slice(0, tab), num(line.slice(tab + 1)) ?? 0);
      }
    } catch {
      /* first run for this repo */
    }

    const last = entries.get(branch);
    if (last && nowSeconds - last <= FETCH_DEBOUNCE_SECONDS) return;

    entries.set(branch, nowSeconds);
    const tmp = `${lockPath}.${process.pid}.tmp`;
    const body = [...entries].map(([b, t]) => `${b}\t${t}`).join('\n') + '\n';
    fs.writeFileSync(tmp, body, 'utf8');
    fs.renameSync(tmp, lockPath);

    const { spawn } = require('child_process');
    const child = spawn('git', ['--no-optional-locks', 'fetch', '--quiet', '--prune'], {
      cwd: repoRoot,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();   // let this process exit while the fetch continues
  } catch {
    /* fetch is best-effort; never let it affect the render */
  }
}

/* ---------------------------------------------------------------------------
 * Cost ledger
 * ----------------------------------------------------------------------------
 * The payload only ever exposes `cost.total_cost_usd` for the *current* session
 * and it resets to $0 on /clear. To get day/week/month totals we keep our own
 * append-and-max ledger at ~/.claude/cost_ledger.json:
 *
 *   { "v": 1, "sessions": { "<session_id>": { first, last, cost } } }
 *
 *   first : epoch ms the session was first observed -- the bucketing anchor
 *   last  : epoch ms of the most recent render -- drives retention pruning
 *   cost  : the highest total_cost_usd ever seen for that id
 *
 * Why max-observed rather than last-observed: total_cost_usd is monotonic
 * within a session, but a resumed/forked session can briefly report a lower
 * figure before the first API call repopulates it. Taking the max makes the
 * ledger immune to that without needing to understand why it happened.
 *
 * Why bucket on `first` and not `last`: a session that spans midnight would
 * otherwise migrate its whole accumulated cost into the new day, making
 * yesterday's total silently shrink. Anchoring on first-seen keeps every
 * historical bucket stable once written.
 * ------------------------------------------------------------------------ */

function ledgerPath() {
  return path.join(claudeDir(), 'cost_ledger.json');
}

/**
 * Accumulate this session's REAL token totals by tailing its transcript.
 *
 * Why this exists: the payload has no cumulative output count. Both
 * `context_window.total_output_tokens` and `current_usage.output_tokens` are
 * the most recent response only, so "Out" would sit at a few hundred forever
 * while "In" grew all session -- which is exactly the asymmetry that reads as
 * broken. The transcript is the only place the full history lives.
 *
 * Two things make this cheap and correct:
 *
 *   1. INCREMENTAL. The byte offset already consumed is kept in the ledger, so
 *      each render parses only the bytes appended since the last one. Only the
 *      first render of a pre-existing session pays for a full scan (~9ms for a
 *      1.3MB transcript, and most lines are skipped without parsing at all).
 *
 *   2. DEDUPED. One assistant response is written to the transcript several
 *      times as it streams, every copy carrying the SAME usage object. Summing
 *      naively overcounts by ~1.8x. Records for a given message id are always
 *      contiguous (verified across a full session: zero non-contiguous
 *      repeats), so tracking the last counted id is sufficient -- and that id
 *      is persisted too, so a run that straddles a read boundary is handled.
 *
 * @returns {{out:number,input:number,cacheCreate:number,cacheRead:number}|null}
 */
function accumulateTranscript(rec, transcriptPath) {
  if (!rec || typeof transcriptPath !== 'string' || !transcriptPath) return null;

  let size;
  try {
    const st = fs.statSync(transcriptPath, { throwIfNoEntry: false });
    if (!st || !st.isFile()) return null;
    size = st.size;
  } catch {
    return null;
  }

  // A shrunk file means it was replaced or rewritten (session fork, resume,
  // manual edit). Anything we accumulated no longer describes it.
  if (rec.tPath !== transcriptPath || num(rec.tOff) === null || rec.tOff > size) {
    rec.tPath = transcriptPath;
    rec.tOff = 0;
    rec.tId = '';
    rec.tOut = 0;
    rec.tIn = 0;
    rec.tCc = 0;
    rec.tCr = 0;
  }

  if (size - rec.tOff > TRANSCRIPT_MAX_READ_BYTES) {
    rec.tOff = size - TRANSCRIPT_MAX_READ_BYTES;   // partial first line is skipped by the parser
  }

  if (size > rec.tOff) {
    let chunk = '';
    try {
      const fd = fs.openSync(transcriptPath, 'r');
      try {
        const len = size - rec.tOff;
        const buf = Buffer.alloc(len);
        const read = fs.readSync(fd, buf, 0, len, rec.tOff);
        chunk = buf.subarray(0, read).toString('utf8');
        rec.tOff += read;
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return tokenTotals(rec);
    }

    // The writer may be mid-append: rewind to the last complete line so no
    // partial JSON is parsed and no bytes are skipped next time.
    const lastNewline = chunk.lastIndexOf('\n');
    if (lastNewline === -1) {
      rec.tOff -= Buffer.byteLength(chunk, 'utf8');
      return tokenTotals(rec);
    }
    const tail = chunk.slice(lastNewline + 1);
    if (tail) rec.tOff -= Buffer.byteLength(tail, 'utf8');

    for (const line of chunk.slice(0, lastNewline).split('\n')) {
      // Cheap pre-filter: most lines are user turns and tool results with no
      // usage block at all, and skipping JSON.parse on those is most of the
      // speed. Note the transcript writes `"usage"` unspaced.
      if (!line || line.indexOf('"usage"') === -1) continue;

      let o;
      try {
        o = JSON.parse(line);
      } catch {
        continue;   // truncated or malformed line: skip, never throw
      }

      const u = o?.message?.usage;
      if (!u) continue;

      const id = o.message.id || o.requestId || '';
      if (id && id === rec.tId) continue;   // same response, streamed again
      rec.tId = id;

      rec.tOut += num(u.output_tokens) ?? 0;
      rec.tIn += num(u.input_tokens) ?? 0;
      rec.tCc += num(u.cache_creation_input_tokens) ?? 0;
      rec.tCr += num(u.cache_read_input_tokens) ?? 0;
    }
  }

  return tokenTotals(rec);
}

function tokenTotals(rec) {
  return {
    out: num(rec.tOut) ?? 0,
    input: num(rec.tIn) ?? 0,
    cacheCreate: num(rec.tCc) ?? 0,
    cacheRead: num(rec.tCr) ?? 0,
  };
}

function loadLedger(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed && typeof parsed === 'object' && parsed.sessions && typeof parsed.sessions === 'object') {
      return parsed;
    }
  } catch {
    /* absent on first run, or corrupt after a hard kill -- start clean */
  }
  return { v: 1, sessions: {} };
}

/**
 * Write via temp-file + rename so a render that dies mid-write (Claude Code
 * cancels in-flight statusline processes when a new update arrives) can never
 * leave a truncated JSON file behind. rename() replaces atomically on Win32.
 */
function saveLedger(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
    fs.renameSync(tmp, file);
  } catch {
    try { fs.unlinkSync(tmp); } catch { /* nothing else to do */ }
  }
}

/**
 * Record this render's session cost and roll up the historical buckets.
 * @returns {{session:number, day:number, week:number, month:number,
 *            period:number|null, periodEnd:number|null}}
 */
/**
 * The budget period containing `nowMs`, as `{ start, end }` epoch milliseconds.
 * null when no budget is configured -- the roll-up below skips the extra pass.
 *
 * Boundaries are built from local date COMPONENTS, never from arithmetic on a
 * timestamp, so a DST shift inside the period cannot slide the edges by an
 * hour. Indexing the boundary function means start and end always come from
 * the same series and cannot disagree about which period we are in.
 */
function budgetWindow(nowMs) {
  if (BUDGET_TOTAL === null) return null;

  const now = new Date(nowMs);
  const h = BUDGET_RESET ? BUDGET_RESET[0] : 0;
  const min = BUDGET_RESET ? BUDGET_RESET[1] : 0;

  if (BUDGET_PERIOD === 'month') {
    // closeAt(i) ends the month at index i (years * 12 + month). Default: the
    // 1st of the next month at midnight. With a reset time: the last day of
    // this month at that time, which is `day 0` of the next month.
    const dayOfNext = BUDGET_RESET ? 0 : 1;
    const closeAt = (i) => new Date(Math.floor(i / 12), (i % 12) + 1, dayOfNext, h, min, 0, 0).getTime();
    let i = now.getFullYear() * 12 + now.getMonth();
    if (nowMs >= closeAt(i)) i += 1;
    return { start: closeAt(i - 1), end: closeAt(i) };
  }

  // day and week both close at `h:min` on some day, so one day-indexed
  // boundary function covers them. Date normalises an out-of-range day.
  const y = now.getFullYear();
  const mo = now.getMonth();
  const closeAt = (day) => new Date(y, mo, day, h, min, 0, 0).getTime();
  const span = BUDGET_PERIOD === 'week' ? 7 : 1;

  let end = closeAt(now.getDate());
  if (BUDGET_PERIOD === 'week') {
    // Weeks roll over on Monday. getDay() is Sunday-based; shift so 0 = Monday.
    const sinceMonday = (now.getDay() + 6) % 7;
    end = closeAt(now.getDate() - sinceMonday + (sinceMonday === 0 && nowMs < end ? 0 : 7));
  } else if (nowMs >= end) {
    end = closeAt(now.getDate() + 1);
  }

  const endDate = new Date(end);
  const start = new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate() - span, h, min, 0, 0).getTime();
  return { start, end };
}

function updateLedger(sessionId, sessionCost, transcriptPath) {
  // The id becomes a plain-object key. Refuse anything that could collide with
  // Object.prototype ("__proto__", "constructor") or smuggle odd characters --
  // a hostile id degrades to "count the cost, skip the ledger record".
  if (typeof sessionId !== 'string' || !/^[\w.-]{1,128}$/.test(sessionId) ||
      sessionId === '__proto__' || sessionId === 'constructor') {
    sessionId = '';
  }
  const cost = num(sessionCost) ?? 0;
  const totals = { session: cost, day: cost, week: cost, month: cost, tokens: null, period: null, periodEnd: null };

  let file;
  try { file = ledgerPath(); } catch { return totals; }

  const now = Date.now();
  const store = loadLedger(file);
  let dirty = false;

  // --- record / update the current session -------------------------------
  if (sessionId) {
    // Own-property lookup only: a key like "toString" must never hand back
    // something inherited from Object.prototype as if it were a record.
    let rec = Object.prototype.hasOwnProperty.call(store.sessions, sessionId)
      ? store.sessions[sessionId]
      : undefined;
    if (!rec || typeof rec !== 'object') {
      rec = store.sessions[sessionId] = { first: now, last: now, cost };
      dirty = true;
    } else {
      const best = Math.max(num(rec.cost) ?? 0, cost);
      // Only rewrite when the number actually moved. At a 300ms debounce this
      // turns most renders into a pure read and keeps the disk quiet.
      if (best !== rec.cost) { rec.cost = best; dirty = true; }
      if (!num(rec.first)) { rec.first = now; dirty = true; }
    }

    // Token accumulation shares the ledger read/write: a separate store would
    // mean two file round-trips per render for the same session record.
    const beforeOffset = rec.tOff;
    try {
      totals.tokens = accumulateTranscript(rec, transcriptPath);
    } catch {
      totals.tokens = null;
    }
    if (rec.tOff !== beforeOffset) dirty = true;

    if (dirty) rec.last = now;
  }

  // --- prune anything past the retention horizon --------------------------
  const cutoff = now - LEDGER_RETENTION_DAYS * 86400000;
  for (const [id, rec] of Object.entries(store.sessions)) {
    const stamp = num(rec && (rec.last ?? rec.first));
    if (stamp === null || stamp < cutoff) {
      delete store.sessions[id];
      dirty = true;
    }
  }

  // --- roll up ------------------------------------------------------------
  const d = new Date(now);
  const startOfToday = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const startOfWeek = startOfToday - 6 * 86400000;                      // today + previous 6 days
  const startOfMonth = new Date(d.getFullYear(), d.getMonth(), 1).getTime();

  // The budget period is a separate window from the D/W/M buckets: it can end
  // at 17:00 on the last day of the month rather than at a calendar boundary,
  // so it needs its own start and its own bounded end. Folded into the same
  // pass -- a second walk of the store per render buys nothing.
  const win = budgetWindow(now);
  if (win) {
    totals.period = BUDGET_OFFSET;
    totals.periodEnd = win.end;
  }

  totals.day = 0;
  totals.week = 0;
  totals.month = 0;
  for (const rec of Object.values(store.sessions)) {
    const c = num(rec && rec.cost);
    const anchor = num(rec && (rec.first ?? rec.last));
    if (c === null || anchor === null) continue;
    if (anchor >= startOfToday) totals.day += c;
    if (anchor >= startOfWeek) totals.week += c;
    if (anchor >= startOfMonth) totals.month += c;
    if (win && anchor >= win.start && anchor < win.end) totals.period += c;
  }

  // A brand-new session that hasn't been flushed yet must still appear in the
  // live totals, and a session id we never got must not vanish from them.
  if (!sessionId) {
    totals.day += cost;
    totals.week += cost;
    totals.month += cost;
    if (win) totals.period += cost;
  }

  if (dirty) saveLedger(file, store);
  return totals;
}

/* ---------------------------------------------------------------------------
 * Pace arrows
 * ----------------------------------------------------------------------------
 * Ported from the bash reference. The payload gives `used_percentage` and
 * `resets_at`, and every window has a fixed length, so the window's start is
 * simply resets_at - duration. From there:
 *
 *   elapsed   = now - start
 *   expected% = elapsed / duration * 100        (what linear burn would show)
 *
 *   used > expected  -> burning fast. Projected 100% is reached at
 *                       start + elapsed * (100 / used). Note this epoch is
 *                       provably earlier than resets_at exactly when
 *                       used > expected, so the ETA is always meaningful here.
 *   |used-expected| <= 5 points -> on pace.
 *   used < expected  -> under-consuming.
 * ------------------------------------------------------------------------ */

function paceArrow(usedPct, resetsAt, durationSeconds, nowSeconds) {
  const used = num(usedPct);
  const resets = num(resetsAt);
  const blank = { onPace: null, arrow: '' };
  if (used === null || resets === null) return blank;

  const start = resets - durationSeconds;
  const elapsed = nowSeconds - start;

  // Too early for the ratio to mean anything, or the stamp is stale/bogus
  // (already past the reset, or in the future beyond a full window).
  if (elapsed <= durationSeconds * PACE_MIN_ELAPSED_FRACTION) return blank;
  if (elapsed >= durationSeconds) return blank;

  // on_pace% is what the meter WOULD read right now for a perfectly linear
  // burn that lands exactly on 100% at reset. Comparing the two numbers by eye
  // is the whole point of showing both.
  const onPace = (elapsed / durationSeconds) * 100;

  // Where this rate lands at reset.
  const projected = used <= 0 ? 0 : (used * durationSeconds) / elapsed;

  if (projected < PACE_SLOW_PROJECTED) {
    // Under-consuming: the limit will not be reached, so there is no
    // exhaustion time to project.
    return { onPace, arrow: green(ASCII_ARROWS ? 'v' : '↓') };
  }

  // Both the on-pace and burning-fast branches project an exhaustion clock.
  // used > 0 is guaranteed here: projected >= 85 with a positive elapsed can
  // only happen for a positive used.
  const exhaustAt = start + elapsed * (100 / used);
  const eta = clock(exhaustAt);

  // The exhaustion time is coloured by how much of the REMAINING window it
  // eats: under a third left is alarming, under two thirds is worth noticing.
  const minutesToExhaust = (exhaustAt - nowSeconds) / 60;
  const minutesToReset = (resets - nowSeconds) / 60;
  let timeColor = green;
  if (minutesToReset > 0) {
    const ratio = (minutesToExhaust / minutesToReset) * 100;
    if (ratio < 33) timeColor = red;
    else if (ratio < 66) timeColor = orange;
  }

  const head = projected > PACE_FAST_PROJECTED
    ? red(ASCII_ARROWS ? '^' : '↑')
    : yellow(ASCII_ARROWS ? '=' : '→');

  return { onPace, arrow: head + (eta ? ' ' + timeColor(eta) : '') };
}

/**
 * Seconds -> compact duration. The reference caps at hours, which produces
 * "142h" for a fresh 7-day window; days keep the 7d cell readable.
 * Non-positive (already elapsed, or a bogus stamp) renders as nothing at all.
 */
function fmtSpan(seconds) {
  if (!(seconds > 0)) return '';
  const minutes = Math.floor(seconds / 60);
  if (minutes >= 2880) return `${Math.floor(minutes / 1440)}d`;   // 48h+
  if (minutes > 99) return `${Math.floor(minutes / 60)}h`;
  return `${minutes}m`;
}

function untilReset(resetsAt, nowSeconds) {
  const resets = num(resetsAt);
  if (resets === null) return '';
  return fmtSpan(resets - nowSeconds);
}

/* ---------------------------------------------------------------------------
 * Line builders
 * ------------------------------------------------------------------------ */

/** xhigh -> "XHigh"; anything else -> first letter capitalised. */
function formatEffort(level) {
  if (typeof level !== 'string') return '';
  const l = level.trim().toLowerCase();
  // Whitelist, not a strip: this is an enum-shaped field headed for a
  // terminal, so anything outside plain words renders as nothing at all.
  if (!/^[a-z][a-z0-9-]{0,15}$/.test(l)) return '';
  const special = { xhigh: 'XHigh', max: 'Max' };
  return special[l] || l.charAt(0).toUpperCase() + l.slice(1);
}

/**
 * Line 1: Model (context variant) Effort Thinking [FAST] [CAVEMAN:X]
 *         [PONYTAIL:Y] session-name
 *
 * The required elements keep their specified relative order. FAST sits with the
 * other mode flags; the session name is appended last because it is the longest
 * and the first thing worth losing on a narrow terminal.
 */
function lineModel(d, maxWidth) {
  const model = d?.model?.display_name;
  const modelText = cleanText(model) || 'Claude';

  // Only annotate the extended window, and only when the display name hasn't
  // already said so -- "Opus 5 (1M context)" must not become "... (1M context)
  // (1M context)".
  const windowSize = num(d?.context_window?.context_window_size);
  const showVariant = windowSize === 1000000 && !/1M/i.test(String(model ?? ''));

  // Tags are omitted entirely when inactive -- no empty brackets.
  const caveman = detectPlugin('caveman', 'CAVEMAN_DEFAULT_MODE');
  const ponytail = detectPlugin('ponytail', 'PONYTAIL_DEFAULT_MODE');

  // fast_mode changes throughput and therefore how fast the 5h window burns.
  // Strictly boolean-true: an absent field must not read as "off" styling.
  const fast = d?.fast_mode === true;

  return fit([
    cell(bold(modelText), 0),
    cell(showVariant ? dim('(1M context)') : '', 5),
    cell(formatEffort(d?.effort?.level) && cyan(formatEffort(d.effort.level)), 3),
    cell(d?.thinking?.enabled === true ? cyan('Thinking') : '', 4),
    cell(fast ? yellow('[FAST]') : '', 3),
    cell(caveman ? orange(`[CAVEMAN:${caveman}]`) : '', 2),
    cell(ponytail ? sage(`[PONYTAIL:${ponytail}]`) : '', 2),
  ], ' ', maxWidth);
}

/* Glyphs used by the repo line. CC_STATUSLINE_ASCII swaps in plain text for
 * consoles whose font boxes them. */
const GLYPH = ASCII_ARROWS
  ? { branch: 'br', clean: 'ok', ahead: '^', behind: 'v' }
  : { branch: '⎇', clean: '✓', ahead: '⇡', behind: '⇣' };

/**
 * Line 1: repo - branch and working-tree state - session name
 *
 * Symbols follow the reference: a tick when clean, otherwise +N staged,
 * ~N modified, ?N untracked; then unpushed / available-to-pull counts.
 */
function lineRepo(d, nowSeconds, maxWidth) {
  // workspace.repo.name is parsed host-side from the origin remote, so it costs
  // nothing here. It is absent outside a repo or when there is no origin --
  // fall back to the project directory's own name.
  const dir = d?.workspace?.project_dir || d?.workspace?.current_dir || d?.cwd || '';
  const repoName = cleanText(d?.workspace?.repo?.name) || (dir ? cleanText(path.basename(dir)) : '');

  let gitText = '';
  const cwd = d?.workspace?.current_dir || d?.cwd || dir;
  if (GIT_ENABLED && cwd) {
    const st = gitStatus(cwd);
    if (st && st.branch) {
      const parts = [dim(GLYPH.branch) + ' ' + magenta(st.branch)];

      if (!st.staged && !st.modified && !st.untracked) {
        parts.push(dim(green(GLYPH.clean)));
      } else {
        if (st.staged) parts.push(green(`+${st.staged}`));
        if (st.modified) parts.push(yellow(`~${st.modified}`));
        if (st.untracked) parts.push(dim(`?${st.untracked}`));
      }

      if (st.ahead) parts.push(orange(GLYPH.ahead + st.ahead));
      if (st.behind) parts.push(cyan(GLYPH.behind + st.behind));

      gitText = parts.join(' ');

      // Ahead/behind are only as fresh as the last fetch. Refresh in the
      // background so the numbers keep meaning something, without ever
      // blocking this render.
      if (!st.detached) {
        const root = findRepoRoot(cwd);
        if (root) maybeBackgroundFetch(root, st.branch, nowSeconds);
      }
    }
  }

  // Session name, unclipped per spec. Control bytes are still stripped: the
  // value is AI-generated or user-supplied and reaches a terminal on every
  // keystroke.
  const rawName = d?.session_name;
  const sessionName =
    typeof rawName === 'string' && rawName.trim()
      ? cleanText(rawName)
      : '';

  // workspace.git_worktree is present for ANY linked worktree created with
  // `git worktree add`, and absent in the main working tree -- so it only ever
  // appears when it is actually telling you something. It is deliberately not
  // read from worktree.name, which is populated only for --worktree sessions
  // and would miss hand-made worktrees entirely.
  const rawTree = d?.workspace?.git_worktree;
  const worktree =
    typeof rawTree === 'string' && rawTree.trim()
      ? cleanText(rawTree)
      : '';

  return fit([
    cell(repoName ? cyan(repoName) : '', 0),
    cell(gitText, 1),
    // Ranked above the session name: which worktree you are in changes what
    // your edits affect, and losing that to truncation is a real hazard.
    cell(worktree ? magenta(`[${worktree}]`) : '', 2),
    cell(sessionName ? dim(sessionName) : '', 3),
  ], SEP, maxWidth);
}

/**
 * Line 3: S session · D day · W week · M month · burn rate · API share
 *
 * Burn rate divides by API time, not wall time: wall-clock $/hr is dominated by
 * however long you spent reading the diff and says nothing about spend. The API
 * share (api/wall) is the complement -- how much of the session was actually
 * inference rather than you thinking.
 */
/**
 * Dollars per hour of API time -- not per hour of wall clock. Idle minutes are
 * not spend, and including them makes a session that sat untouched overnight
 * look free. null when there is nothing meaningful to divide.
 */
function burnPerHour(d, sessionCost) {
  const apiMs = num(d?.cost?.total_api_duration_ms);
  if (apiMs === null || apiMs <= 0 || !(sessionCost > 0)) return null;
  const perHour = sessionCost / (apiMs / 3600000);
  // Above ~$1k/hr the figure is a sampling artifact of a very short session,
  // not information. Suppress rather than report something absurd.
  return perHour < 1000 ? perHour : null;
}

function lineCost(d, t, maxWidth) {
  // Four bare dollar amounts in a row are unreadable -- nothing says which
  // window each belongs to. Single-letter keys cost 2 columns each and remove
  // the ambiguity entirely.
  const label = (text, value) => (SHOW_COST_LABELS ? `${dim(text)} ${value}` : value);

  const apiMs = num(d?.cost?.total_api_duration_ms);
  const wallMs = num(d?.cost?.total_duration_ms);

  const perHour = burnPerHour(d, t.session);
  const burn = perHour === null ? '' : dim(money(perHour) + '/hr');

  let apiShare = '';
  if (apiMs !== null && wallMs !== null && wallMs > 0) {
    const pct = Math.min(100, (apiMs / wallMs) * 100);
    apiShare = `${dim('API')} ${dim(Math.round(pct) + '%')}`;
  }

  return fit([
    cell(label('S', green(money(t.session))), 0),
    cell(label('D', money(t.day)), 2),
    cell(label('W', money(t.week)), 3),
    cell(label('M', money(t.month)), 4),
    cell(burn, 5),
    cell(apiShare, 6),
  ], SEP, maxWidth);
}

/**
 * One rate-limit cell: `5h 71%:60%↑ 16:20:1h`
 *                          |    |  |     |  `- time until the window resets
 *                          |    |  `- projected exhaustion clock
 *                          |    `- on_pace%: what a perfectly linear burn reads
 *                          `- used%
 *
 * @param usedColor colour applied to used% -- threshold-based for 5h, flat for
 *                  7d, matching the reference.
 */
function rateLimitCell(label, node, duration, nowSeconds, usedColor) {
  const used = num(node?.used_percentage);
  if (used === null) return `${dim(label)} ${dim('n/a')}`;

  const { onPace, arrow } = paceArrow(used, node?.resets_at, duration, nowSeconds);

  let text = usedColor(`${Math.round(used)}%`);
  // on_pace% and the arrow are suppressed together: both are undefined in the
  // opening 2% of a window, and half the trio would read as a bug.
  if (onPace !== null) text += dim(':') + dim(`${Math.round(onPace)}%`) + arrow;

  const left = untilReset(node?.resets_at, nowSeconds);
  if (left) text += dim(':') + cyan(left);

  return `${dim(label)} ${text}`;
}

/** Usage colour for the 5h window. Reference thresholds. */
function fiveHourColor(p) {
  if (p >= 80) return red;
  if (p >= 50) return yellow;
  return cyan;
}

/**
 * Line 2: context usage, LONGCTX flag, token split, cache hit rate, then the
 * 5h and 7d rate limits with their pace arrows.
 *
 * Context and rate limits share a line because they answer the same question --
 * "how much runway is left" -- and merging them into one fit() call means the
 * width budget is allocated across all of it at once. Two separate lines would
 * each trim in isolation and could drop a rate limit while keeping a token
 * count that nobody needs.
 */
/**
 * Spend against the configured allocation: "Bgt $34.63/250:6h".
 *
 * The trailing span is the same projection the rate-limit pace arrows make --
 * at the current burn, when does the allocation run out -- coloured by how much
 * of the remaining period that eats. Empty when no budget is configured.
 */
function budgetCell(t, perHour, nowSeconds) {
  const spent = num(t?.period);
  if (BUDGET_TOTAL === null || spent === null) return '';

  const pct = (spent / BUDGET_TOTAL) * 100;
  const color = pct >= 80 ? red : pct >= 50 ? yellow : cyan;

  // The allocation keeps its own formatting: a round 250 reads better than the
  // noisier "$250.00" beside an amount that genuinely needs its cents.
  const cap = Number.isInteger(BUDGET_TOTAL) ? String(BUDGET_TOTAL) : BUDGET_TOTAL.toFixed(2);
  let text = color(`${money(spent)}/${cap}`);

  const left = BUDGET_TOTAL - spent;
  if (perHour !== null) {
    // Nothing left to project once the allocation is gone: the span goes
    // negative and fmtSpan -- the single authority on non-positive durations --
    // renders it as nothing at all.
    const secondsToEmpty = (left / perHour) * 3600;
    const span = fmtSpan(secondsToEmpty);
    if (span) {
      const end = num(t?.periodEnd);
      const secondsToReset = end === null ? 0 : end / 1000 - nowSeconds;
      let timeColor = green;
      if (secondsToReset > 0) {
        const ratio = (secondsToEmpty / secondsToReset) * 100;
        if (ratio < 33) timeColor = red;
        else if (ratio < 66) timeColor = orange;
      }
      text += dim(':') + timeColor(span);
    }
  }

  return `${dim('Bgt')} ${text}`;
}

/**
 * Blended cost per million tokens: what this session actually paid, divided by
 * everything it was billed for. Per MILLION rather than the reference's per
 * 1k, because at two decimal places a per-1k figure collapses to "$0.01" or
 * "$0.02" for every model -- one significant digit, and no way to see a cache
 * strategy working. Per-million keeps the resolution the number is for.
 */
function tokenRateCell(sessionCost, tokens) {
  if (!(tokens > 0) || !(sessionCost > 0)) return '';
  return `${dim('$/Mtok')} ${dim(((sessionCost * 1e6) / tokens).toFixed(2))}`;
}

function lineUsage(d, ledger, nowSeconds, maxWidth) {
  const cw = d?.context_window;

  const usedPct = num(cw?.used_percentage) ?? 0;
  const ctx = `${dim('Ctx')} ${pctColor(usedPct)(`${Math.round(usedPct)}%`)}`;

  // Token counts come from the COMBINED totals, not current_usage.
  //
  // current_usage.input_tokens is fresh, uncached input only -- on a warm
  // session that is a single-digit number ("In 2") while the context actually
  // holds tens of thousands of tokens, which reads as broken. total_input_tokens
  // is the sum of input + cache_creation + cache_read, i.e. what is really in
  // the window. current_usage is still used below for the cache split, which is
  // the one thing it is genuinely the right source for.
  const usage = cw?.current_usage;
  const inTok =
    num(cw?.total_input_tokens) ??
    (num(usage?.input_tokens) ?? 0) +
      (num(usage?.cache_creation_input_tokens) ?? 0) +
      (num(usage?.cache_read_input_tokens) ?? 0);

  // Out is the session's CUMULATIVE output, accumulated from the transcript.
  // Neither payload field can supply this: total_output_tokens and
  // current_usage.output_tokens are both the most recent response only, so Out
  // would sit at a few hundred all session while In climbed into six figures.
  // Falls back to the payload when the transcript is unreadable.
  const tok = ledger?.tokens;
  const outTok = num(tok?.out) ?? num(cw?.total_output_tokens) ?? num(usage?.output_tokens) ?? 0;
  const tokens = `${dim('In')} ${group(inTok)} ${dim('Out')} ${group(outTok)}`;

  // cache_read / (input + cache_creation + cache_read). Denominator 0 -> 0%.
  //
  // Summed across the whole session, not just the last call, so it sits in the
  // same frame of reference as Out. The per-call figure swings wildly -- a
  // single cache-write turn can read 92% where the session is running at 98% --
  // and the session number is the one that says whether the conversation is
  // caching well. Falls back to the last call when the transcript is
  // unreadable.
  const cacheRead = num(tok?.cacheRead) ?? num(usage?.cache_read_input_tokens) ?? 0;
  const cacheCreate = num(tok?.cacheCreate) ?? num(usage?.cache_creation_input_tokens) ?? 0;
  const freshIn = num(tok?.input) ?? num(usage?.input_tokens) ?? 0;
  const denom = freshIn + cacheCreate + cacheRead;
  const hit = denom > 0 ? (cacheRead / denom) * 100 : 0;
  // Inverted scale: a HIGH cache hit rate is the good outcome.
  const hitColor = hit >= 80 ? green : hit >= 50 ? cyan : orange;
  const cache = `${dim('Cache')} ${hitColor(`${Math.round(hit)}%`)}`;

  // LngCtx: progress toward the FIXED 200k long-context threshold, which is
  // fixed regardless of the actual window size. On a 1M model it is reached at
  // ~20% context -- long before the Ctx cell looks remotely alarming -- and
  // crossing it moves requests into the premium tier and accelerates
  // rate-limit burn. Showing it as a percentage rather than a boolean flag
  // means the approach is visible, not just the arrival.
  // Deliberately NOT the cumulative Out above: exceeds_200k_tokens is defined
  // against a single response ("input, cache and output tokens combined, from
  // the most recent API response"), so the output half must be that response's
  // output, not the session's running total. Mixing the two inflates the gauge
  // past 100% on any long session regardless of actual request size.
  const lastOutTok = num(cw?.total_output_tokens) ?? num(usage?.output_tokens) ?? 0;
  const longPct = ((inTok + lastOutTok) / 200000) * 100;
  // exceeds_200k_tokens is authoritative for the crossing itself: it is
  // computed host-side from the same response, so trust it over our arithmetic
  // when the two disagree at the boundary.
  const overLong = d?.exceeds_200k_tokens === true;
  const longColor = overLong || longPct >= 100 ? red : longPct >= 80 ? orange : longPct >= 50 ? yellow : green;
  // Once the threshold is actually crossed the label goes red too, not just
  // the number -- at that point it is a billing-tier change, not a gauge, and
  // a dim label beside a red figure reads as ordinary.
  const longLabel = overLong ? red('LngCtx') : dim('LngCtx');
  const longCtx = `${longLabel} ${longColor(`${Math.round(longPct)}%`)}`;

  const rl = d?.rate_limits;
  const hasWindow =
    num(rl?.five_hour?.used_percentage) !== null || num(rl?.seven_day?.used_percentage) !== null;

  // rate_limits is sent only to Claude.ai subscribers, and only AFTER the first
  // API response of the session -- so its absence on its own does not mean "API
  // plan". Wait until a response has actually landed before reading it that
  // way, or every subscription session opens on the budget cells and flips to
  // 5h/7d one response later.
  const sessionCost = num(d?.cost?.total_cost_usd) ?? 0;
  const responded = inTok > 0 || outTok > 0 || sessionCost > 0;
  const billed = !hasWindow && responded;

  // Denominator for $/Mtok: session cost has to be divided by everything the
  // session was billed for, not by what happens to be in the window right now.
  // The transcript totals are the only cumulative input figure available --
  // without them, fall back to the context window's own numbers.
  const lifetimeTokens = num(tok?.input) !== null
    ? freshIn + cacheCreate + cacheRead + outTok
    : inTok + outTok;

  // Rank 1 on both plans: whichever of the two is real -- the rate-limit
  // windows on a subscription, the allocation on a billed account -- is the
  // constraint that ends the day's work, so it outlives the token counts, the
  // cache rate and LngCtx.
  const constraint = billed
    ? [
        cell(budgetCell(ledger, burnPerHour(d, sessionCost), nowSeconds), 1),
        cell(tokenRateCell(sessionCost, lifetimeTokens), 5),
      ]
    : [
        cell(rateLimitCell('5h', rl?.five_hour, FIVE_HOUR_SECONDS, nowSeconds, fiveHourColor(num(rl?.five_hour?.used_percentage) ?? 0)), 1),
        cell(rateLimitCell('7d', rl?.seven_day, SEVEN_DAY_SECONDS, nowSeconds, cyan), 1),
      ];

  return fit([
    cell(ctx, 0),
    cell(tokens, 4),
    cell(cache, 3),
    cell(longCtx, 2),
    ...constraint,
  ], SEP, maxWidth);
}

/* ---------------------------------------------------------------------------
 * Optional self-update
 * ----------------------------------------------------------------------------
 * OFF unless <config>/.statusline-autoupdate exists. `install.js --auto-update`
 * creates it; `install.js --no-auto-update` removes it. When it is absent the
 * entire feature costs one statSync per render.
 *
 * When it is present the render path still does no network I/O. It checks the
 * age of a marker file and, at most once a day, spawns a DETACHED child that
 * exits on its own schedule -- the bar is already printed by then.
 *
 * The child refuses to install anything that is not, in order:
 *   1. present in the manifest written at install time,
 *   2. byte-identical to what that install put on disk (else you edited it --
 *      the tunables at the top of this file are meant to be edited, and an
 *      updater that silently reverts them would be a bug, not a feature),
 *   3. over 4 KB and starting with the expected shebang,
 *   4. parseable by `node --check`.
 * Only then does it rename the new file into place.
 * ------------------------------------------------------------------------ */

const UPDATE_REPO = 'GridFlowTech/claude-statusline';
const UPDATE_FILES = ['statusline.js', 'subagent-statusline.js'];
const UPDATE_FLAG_FILE = '.statusline-autoupdate';
const UPDATE_MARKER_FILE = '.statusline-last-update';
const UPDATE_MANIFEST_FILE = '.statusline-manifest.json';
const UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const UPDATE_MIN_BYTES = 4096;
// Ceiling on any single download. Both scripts are ~40 KB; a response in the
// megabytes is not this project and must not be buffered into memory.
const UPDATE_MAX_BYTES = 5 * 1024 * 1024;

/**
 * Render-path half. Synchronous, allocation-free on the common path, and called
 * only after stdout has been written. Must never throw and never block.
 */
function maybeSelfUpdate() {
  try {
    const dir = claudeDir();

    const flag = fs.statSync(path.join(dir, UPDATE_FLAG_FILE), { throwIfNoEntry: false });
    if (!flag) return;

    const marker = path.join(dir, UPDATE_MARKER_FILE);
    const stamp = fs.statSync(marker, { throwIfNoEntry: false });
    if (stamp && Date.now() - stamp.mtimeMs < UPDATE_INTERVAL_MS) return;

    // Touch the marker BEFORE spawning, not after. Two renders can overlap
    // inside the 300ms debounce, and a network failure must not re-arm the
    // check on every single render for the rest of the day.
    fs.writeFileSync(marker, new Date().toISOString() + '\n');

    const child = require('child_process').spawn(
      process.execPath,
      [__filename, '--self-update'],
      { detached: true, stdio: 'ignore', windowsHide: true }
    );
    child.unref();
  } catch {
    // An updater that can blank the status bar is worse than a stale statusline.
  }
}

/** GET as UTF-8 text, following redirects. Resolves null on any failure. */
function updateFetch(https, url, redirects) {
  return new Promise((resolve) => {
    const req = https.get(
      url,
      { headers: { 'User-Agent': 'claude-statusline-selfupdate' } },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
          res.resume();
          const next = new URL(res.headers.location, url).toString();
          // https only: a redirect must not downgrade the transport the whole
          // update chain's integrity hangs on.
          if (!next.startsWith('https://')) return resolve(null);
          return resolve(updateFetch(https, next, redirects - 1));
        }
        if (res.statusCode !== 200) { res.resume(); return resolve(null); }
        const chunks = [];
        let total = 0;
        res.on('data', (c) => {
          total += c.length;
          if (total > UPDATE_MAX_BYTES) { res.destroy(); return resolve(null); }
          chunks.push(c);
        });
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        res.on('error', () => resolve(null));
      }
    );
    req.setTimeout(15000, () => req.destroy());
    req.on('error', () => resolve(null));
  });
}

/**
 * Detached-child half. Nothing here is on the render path, so it may take as
 * long as it likes. Every failure mode is "leave the installed file alone".
 */
async function selfUpdate() {
  const https = require('https');
  const crypto = require('crypto');
  const { spawnSync } = require('child_process');

  const dir = claudeDir();
  const manifestPath = path.join(dir, UPDATE_MANIFEST_FILE);
  const sha = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    return;                       // no manifest -> no baseline -> no update
  }
  if (!manifest || typeof manifest !== 'object' || !manifest.files) return;

  // "owner/name" shape only: the value is interpolated into a URL path, and a
  // manifest written by anything else must not point the fetch elsewhere.
  const repo = typeof manifest.repo === 'string' && /^[\w.-]+\/[\w.-]+$/.test(manifest.repo)
    ? manifest.repo
    : UPDATE_REPO;
  const ref = typeof manifest.ref === 'string' && manifest.ref ? manifest.ref : 'main';
  let changed = false;

  for (const name of UPDATE_FILES) {
    const dest = path.join(dir, name);
    const baseline = manifest.files[name];
    if (typeof baseline !== 'string') continue;      // not installed by us

    let current;
    try { current = fs.readFileSync(dest, 'utf8'); } catch { continue; }
    if (sha(current) !== baseline) continue;         // locally edited -- hands off

    const url = `https://raw.githubusercontent.com/${repo}/${encodeURIComponent(ref)}/${name}`;
    const next = await updateFetch(https, url, 5);

    if (!next || Buffer.byteLength(next, 'utf8') < UPDATE_MIN_BYTES) continue;
    if (!next.startsWith('#!/usr/bin/env node')) continue;
    const nextHash = sha(next);
    if (nextHash === baseline) continue;             // already current

    // Keep the `.js` extension: `node --check` on Node 20+ resolves a module
    // format from the extension first and fails on anything it does not know.
    const tmp = `${dest}.update.${process.pid}.js`;
    try {
      fs.writeFileSync(tmp, next, 'utf8');
      const res = spawnSync(process.execPath, ['--check', tmp], { windowsHide: true });
      if (res.status !== 0) { fs.unlinkSync(tmp); continue; }
      fs.renameSync(tmp, dest);                      // atomic; a half-written
      manifest.files[name] = nextHash;               // statusline is impossible
      changed = true;
    } catch {
      try { fs.unlinkSync(tmp); } catch { /* best effort */ }
    }
  }

  if (!changed) return;
  try {
    manifest.updatedAt = new Date().toISOString();
    const tmp = `${manifestPath}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2) + '\n');
    fs.renameSync(tmp, manifestPath);
  } catch { /* the file is updated; a stale manifest only costs one no-op pass */ }
}

/* ---------------------------------------------------------------------------
 * Main
 * ------------------------------------------------------------------------ */

function main() {
  let data = {};
  try {
    const raw = readStdin();
    if (raw && raw.trim()) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') data = parsed;
    }
  } catch {
    // Malformed or truncated payload (Claude Code kills in-flight renders).
    // Keep going with {} -- every builder tolerates a fully empty object.
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const width = terminalWidth();
  const lines = [];

  // Each line is independently guarded: one bad field can't blank the others.
  const safe = (fn, fallback) => {
    try { return fn(); } catch { return fallback; }
  };

  // Order: identity, runway (context + rate limits), money, place.
  // The repo line sits at the bottom because it is the slowest-changing
  // information on the bar -- branch and working-tree state barely move within
  // a turn, while context and rate limits move on every response.
  // One ledger round-trip per render, shared by the two lines that need it.
  // It carries both the cost roll-ups and the accumulated token totals.
  const ledger = safe(
    () => updateLedger(data?.session_id, data?.cost?.total_cost_usd, data?.transcript_path),
    { session: 0, day: 0, week: 0, month: 0, tokens: null, period: null, periodEnd: null }
  );

  lines.push(safe(() => lineModel(data, width), 'Claude'));
  lines.push(safe(() => lineUsage(data, ledger, nowSeconds, width), `${dim('Ctx')} 0%`));
  lines.push(safe(() => lineCost(data, ledger, width), money(num(data?.cost?.total_cost_usd) ?? 0)));
  lines.push(safe(() => lineRepo(data, nowSeconds, width), ''));

  const agentName = data?.agent?.name;
  if (typeof agentName === 'string' && agentName.trim()) {
    const clean = cleanText(agentName);
    if (clean) {
      const label = dim('Session Agent:');
      // Reserve room for the label + its trailing space when clipping.
      const room = width === null ? 64 : Math.max(8, width - visibleWidth(label) - 1);
      lines.push(`${label} ${cyan(clip(clean, room))}`);
    }
  }

  // A line that produced nothing at all (no repo, no branch, no session name)
  // is dropped rather than printed blank -- an empty row still costs a terminal
  // row and looks like a rendering fault.
  const printable = lines.filter((l) => l !== '');
  process.stdout.write(printable.join('\n') + '\n');

  // Strictly after the write, so nothing here can delay a single frame.
  maybeSelfUpdate();
}

if (process.argv.includes('--self-update')) {
  // Detached child spawned by maybeSelfUpdate(). Never reads stdin, never
  // prints, and its exit code is discarded.
  selfUpdate().catch(() => {});
} else {
  try {
    main();
  } catch {
    // Absolute last resort: never leave the status bar empty and never exit
    // non-zero, which would make Claude Code log an error on every render.
    try { process.stdout.write('Claude\n'); } catch { /* stdout is gone */ }
  }
}
