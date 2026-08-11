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
 *   and usage-refresh children only, so a normal render never pays for loading
 *   them -- and neither child can delay a frame, because both are spawned after
 *   stdout has already been written.
 *
 * CONTRACT
 *   stdin  : one JSON object (schema: https://code.claude.com/docs/en/statusline)
 *   stdout : 4 lines, plus an optional 5th when a named agent is active.
 *              1. model and mode flags
 *              2. runway   -- context, cache, LngCtx, the Fable allowance,
 *                             both rate-limit windows
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
 *
 *   The post-/compact null is the one case where `?? 0` is itself a bug: the
 *   window shrank, it did not empty. contextState() is the single place that
 *   decides what the context reads as while those fields are null.
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
 * Fable allowance. As of July 2026 a subscription may spend up to half of its
 * weekly limit on Fable 5, which makes the 7d cell alone useless for pacing
 * Fable: a 40% weekly reading is comfortable if it is all Sonnet and nearly
 * spent if it is all Fable. So the ledger keeps Fable spend in its own
 * seven-day bucket, and while Fable is the active model the bar reports that
 * bucket as a percentage of the Fable allowance rather than of the whole limit.
 *
 *   CC_STATUSLINE_FABLE_SHARE=50  percent of the weekly limit Fable may use
 *
 * The allowance itself is derived from the seven-day window the host already
 * reports -- see fableCell(). That window is subscription-only, so on a billed
 * plan the cell simply collapses, which is correct: a billed account has no
 * Fable allowance to pace against, only dollars, and `Bgt` already covers those.
 *
 * The statusline payload carries no model-scoped bucket -- `rate_limits` is
 * exactly `five_hour` and `seven_day` -- so this estimate is what runs whenever
 * the server's own figure is unavailable. See the usage-endpoint section below
 * for where that figure comes from and how it retires the guesswork here.
 * ------------------------------------------------------------------------ */

// Percent of the weekly subscription limit Fable 5 may consume. A product
// policy number rather than a payload field, so it is overridable: the default
// tracks the July 2026 policy and the env var covers it moving.
const FABLE_WEEKLY_SHARE = (() => {
  const n = Number(process.env.CC_STATUSLINE_FABLE_SHARE);
  return Number.isFinite(n) && n > 0 && n <= 100 ? n : 50;
})();

/* ---------------------------------------------------------------------------
 * Ground truth: the OAuth usage endpoint
 * ----------------------------------------------------------------------------
 * `GET https://api.anthropic.com/api/oauth/usage`, with the same OAuth bearer
 * Claude Code itself holds, answers the question the payload cannot:
 *
 *   "limits": [
 *     { "kind": "session",        "percent": 10, "severity": "normal", ... },
 *     { "kind": "weekly_all",     "percent":  7, "severity": "normal", ... },
 *     { "kind": "weekly_scoped",  "percent":  2, "severity": "normal",
 *       "scope": { "model": { "display_name": "Fable" } } }
 *   ]
 *
 * `weekly_scoped` is the per-model weekly bucket, server-side and already
 * expressed as a percentage of that model's own allowance. It is a measurement
 * where fableCell()'s dollar ratio is an inference, so when it is available it
 * simply wins. (The older `seven_day_opus` / `seven_day_sonnet` top-level fields
 * are null on current accounts; `limits[]` is the live shape and the only one
 * read here.)
 *
 * It costs NO tokens -- there is no inference behind it, it is account
 * metadata -- but it does cost a TLS round trip, and the render path is
 * forbidden from doing network I/O for the same reason it is forbidden from
 * doing four git spawns: Claude Code re-renders on a 300ms debounce and a
 * stalled render is a stuttering status bar. So the split mirrors the
 * self-update feature:
 *
 *   render path   one statSync on a marker + one small readFileSync. When the
 *                 marker is older than the TTL it is touched and a DETACHED
 *                 child is spawned. This render uses whatever was already
 *                 cached; it never waits.
 *   detached child  reads the credential, makes the request, writes the cache,
 *                 exits. Nothing it does can delay a frame.
 *
 * The marker is stamped BEFORE the spawn, so a failing request (offline, 401,
 * rate limited) still debounces for a full TTL instead of re-arming on every
 * render.
 *
 * OFF unless <config>/.statusline-usage exists, on the same terms as the
 * self-updater and for the same reason: this is a status bar reaching out to
 * the network with the user's credential, and nothing a status bar does should
 * surprise anyone. `install.js --usage` creates the flag, `--no-usage` removes
 * it. While it is absent the whole feature costs one statSync per render and
 * fableCell() behaves exactly as it did before this existed.
 *
 *   install.js --usage           opt in
 *   CC_STATUSLINE_USAGE=0        force off even with the flag present
 *   CC_STATUSLINE_USAGE_TTL=90   seconds between refreshes
 * ------------------------------------------------------------------------ */

const USAGE_FLAG_FILE = '.statusline-usage';

// The env var is a kill switch, not the switch: it can only turn the feature
// off. Opting IN is a deliberate on-disk act, so that a stray environment
// variable inherited from somewhere can never start network traffic.
const USAGE_DISABLED = process.env.CC_STATUSLINE_USAGE === '0';

// Seconds between refresh attempts. The seven-day bucket this feeds moves by
// single-digit percent per DAY, so anything under a minute is pure waste; the
// floor exists to stop a typo turning the bar into a polling loop against a
// production endpoint.
const USAGE_TTL_MS = (() => {
  const n = Number(process.env.CC_STATUSLINE_USAGE_TTL);
  const seconds = Number.isFinite(n) && n > 0 ? n : 90;
  return clamp(seconds, 60, 600) * 1000;
})();

// Past this age the cached figure stops being treated as ground truth and the
// local estimate takes over. An hour of drift on a seven-day window is small,
// but an hour without a successful refresh means something is actually broken
// (revoked token, no network), and silently presenting a stale measurement as
// current is the one failure mode worse than presenting an estimate.
const USAGE_MAX_AGE_MS = 60 * 60 * 1000;

const USAGE_HOST = 'api.anthropic.com';
const USAGE_PATH = '/api/oauth/usage';
const USAGE_BETA = 'oauth-2025-04-20';
const USAGE_TIMEOUT_MS = 10000;
const USAGE_MAX_BYTES = 256 * 1024;   // the real response is ~1.5 KB
const USAGE_CACHE_FILE = '.statusline-usage.json';
const USAGE_CHECK_FILE = '.statusline-usage-check';

/* ---------------------------------------------------------------------------
 * Estimator calibration
 * ----------------------------------------------------------------------------
 * Every render that has BOTH the server's figure and the local estimate can
 * measure how wrong the estimate is, and that ratio is worth keeping: it is
 * exactly what the estimate needs the next time the server's figure is missing.
 *
 *   k = serverPercent / estimatedPercent
 *
 * This is deliberately a learned constant rather than a hand-tuned one. The
 * estimate's error is the product of several unknowns at once -- whether the
 * server normalises `weekly_scoped` against the Fable allowance or against the
 * whole weekly limit, how a Fable dollar maps to limit units against a Sonnet
 * dollar, and the model mix and reasoning effort this particular account
 * actually runs at. Guessing any of them wrong bakes in a permanent bias;
 * measuring their combined effect gets all of them at once and re-measures
 * whenever the account's habits change.
 *
 * Smoothed rather than replaced, because a single sample carries the noise of
 * whatever the ledger happened to miss (work on another machine, a session
 * started before install). Persisted in the ledger, which is already read and
 * written once per render, so it costs no extra file I/O.
 * ------------------------------------------------------------------------ */

// Weight of the newest observation. Low enough that one bad sample cannot move
// the bar much, high enough to converge within an hour of renders.
const CALIB_ALPHA = 0.25;

// Both percentages must be at least this large before their ratio means
// anything. At 0.4% against 0.3% the quotient is dominated by rounding, and a
// ratio learned there would be nonsense carried for the rest of the window.
const CALIB_MIN_PCT = 2;

// Hard bounds. A correction outside these is not a calibration, it is a bug or
// a schema change, and clamping keeps the fallback merely wrong rather than
// absurd.
const CALIB_MIN_K = 0.2;
const CALIB_MAX_K = 5;

/* ---------------------------------------------------------------------------
 * Git. At most one subprocess per GIT_CACHE_MS, and only when we are actually
 * inside a repo.
 * ------------------------------------------------------------------------ */

// A hung git (network filesystem, index.lock contention) must never freeze the
// status bar. spawnSync kills the child at this deadline.
const GIT_TIMEOUT_MS = 800;

// How long a `git status` result stays reusable. The render debounce is 300ms,
// so a busy turn fires renders far faster than a working tree actually changes;
// see cachedGitState(). Set to 0 to spawn git on every render.
const GIT_CACHE_MS = 3000;

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

/** Constrain `v` to [lo, hi]. A declaration, not an arrow, so the tunables
 *  above may use it despite being evaluated first. */
function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

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

/* ---------------------------------------------------------------------------
 * Context degradation scale
 * ----------------------------------------------------------------------------
 * The Ctx gauge is coloured by ABSOLUTE TOKENS, not by percentage of the
 * window -- which is why it does not use pctColor() above. Attention degrades
 * on a token scale, and the window size is a licensing decision: 200k of
 * context is exactly as reliable whether the model is willing to accept 200k
 * or 1M of it. Colouring by percentage says a 200k window at 190k is critical
 * while a 1M window at 190k is comfortable, which inverts the truth -- both
 * hold the same 190k, and the second one is merely allowed to keep going.
 *
 * Five tiers, from the NoLiMa / MRCR v2 / RULER benchmark work on mid-2026
 * 1M+ models:
 *
 *   0    - 32K    Optimal            maximum effective context window
 *   32K  - 128K   Attention dilution measurable unreliability begins
 *   128K - 250K   Moderate rot       multi-needle reasoning limit
 *   250K - 600K   Severe             effective capacity ceiling, recall cliffs
 *   600K - 1.05M  Critical collapse  structural logic and agentic failure
 *
 * Truecolor (38;2;R;G;B) rather than the 256-colour palette the rest of the
 * bar uses, because these five hexes are the scale -- an approximation to the
 * nearest xterm index would put two adjacent tiers within a few units of each
 * other and cost the reading at a glance that the whole thing is for.
 * ------------------------------------------------------------------------ */

const CTX_TIERS = [
  [32000, '0;176;80'],      // #00B050  optimal
  [128000, '255;215;0'],    // #FFD700  attention dilution
  [250000, '255;140;0'],    // #FF8C00  moderate context rot
  [600000, '255;69;0'],     // #FF4500  severe degradation
];
const CTX_CRITICAL = '255;0;0';   // #FF0000  critical collapse, 600K and up

/** Painter for a context length, in tokens. Unknown lengths never reach here --
 *  the caller draws the compaction marker instead. */
function ctxColor(tokens) {
  const t = num(tokens) ?? 0;
  for (const [limit, rgb] of CTX_TIERS) {
    if (t < limit) return (s) => paint(`38;2;${rgb}`, s);
  }
  return (s) => paint(`38;2;${CTX_CRITICAL}`, s);
}

/** Strip C0 AND C1 control bytes. Payload text lands in a terminal on every
 *  keystroke, and a stray ESC -- or an 8-bit CSI (U+009B), which some
 *  terminals honour just the same -- would let it inject escape sequences. */
const CONTROL_RE = /[\x00-\x1f\x7f-\x9f]/g;
const cleanText = (s) => (typeof s === 'string' ? s.replace(CONTROL_RE, '').trim() : '');

/** Is Fable the model behind this render?
 *
 *  display_name is the field the host actually populates ("Claude Fable 5");
 *  the id is checked as well so a host that ships a shortened or localised
 *  display string cannot silently stop the allowance tracking. Both reads are
 *  coerced through String() -- a non-string here must be a miss, not a throw. */
const FABLE_RE = /fable/i;
function isFableModel(d) {
  return FABLE_RE.test(String(d?.model?.display_name ?? '')) ||
         FABLE_RE.test(String(d?.model?.id ?? ''));
}

/** Honors CLAUDE_CONFIG_DIR the same way Claude Code and both plugins do. */
function claudeDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

/**
 * Spawn `statusline.js <flag>` detached, at most once per `intervalMs`, using
 * the mtime of `<config>/<markerFile>` as the debounce.
 *
 * Both background jobs -- the self-updater and the usage refresh -- want
 * exactly this, and they want it to behave IDENTICALLY. The marker is stamped
 * BEFORE the spawn, never after: two renders can overlap inside the 300ms
 * debounce, and a job that fails must still wait out the interval rather than
 * re-arming on every render for the rest of it.
 *
 * Never throws, and is only ever called after stdout has been written, so
 * nothing here can delay or disturb a frame.
 */
function spawnDebounced(markerFile, intervalMs, flag) {
  try {
    const marker = path.join(claudeDir(), markerFile);
    const stamp = fs.statSync(marker, { throwIfNoEntry: false });
    // `age >= 0` rejects a stamp from the future: a clock stepping backwards
    // (NTP correction, VM resume, a restored backup) would otherwise pin the
    // job until real time caught up again.
    const age = stamp ? Date.now() - stamp.mtimeMs : Infinity;
    if (age >= 0 && age < intervalMs) return;

    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, new Date().toISOString() + '\n');

    require('child_process')
      .spawn(process.execPath, [__filename, flag], {
        detached: true, stdio: 'ignore', windowsHide: true,
      })
      .unref();   // let this process exit while the child carries on
  } catch {
    /* a background job that cannot start is no reason to disturb the bar */
  }
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
 * The directory git is asked about. Defined once because two call sites depend
 * on agreeing exactly: updateLedger keys the cache on it, lineRepo reads that
 * cache back. A disagreement would hand line 4 another directory's branch.
 */
function gitCwd(d) {
  return d?.workspace?.current_dir || d?.cwd || d?.workspace?.project_dir || '';
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

/**
 * `git status` behind a short-lived cache held in the session's own ledger
 * record.
 *
 * The spawn is the most expensive thing on the render path (~30-60ms on
 * Windows, against a ~35-50ms process budget for everything else combined), and
 * Claude Code re-renders on every assistant message, permission-mode change and
 * vim-mode toggle, debounced at 300ms. A busy turn therefore fires renders
 * roughly ten times a second against a working tree that has not moved.
 *
 * The cache lives in the ledger record rather than in a temp file of its own.
 * The ledger is already read once and written at most once per render, and it
 * is keyed by session_id -- the only identifier that is both stable across the
 * renders of a session and distinct between concurrent sessions in different
 * repositories. Keying on process.pid instead would change every render and
 * defeat the cache entirely. Reusing the ledger keeps this at zero extra file
 * I/O; the cost is that a refresh marks the record dirty, so the ledger is
 * written at most once per GIT_CACHE_MS instead of only when a cost moves.
 *
 * `null` is cached exactly as eagerly as a hit: outside a repo, or with git
 * absent from PATH, the answer still cost a full spawn to establish.
 *
 * @returns {{status:object|null, root:string|null, refreshed:boolean}}
 */
function cachedGitState(rec, cwd, nowMs) {
  const stamp = num(rec.gTs);
  // `nowMs - stamp >= 0` rejects a timestamp from the future: a clock stepping
  // backwards (NTP correction, VM resume) would otherwise pin the cache until
  // it caught up again.
  const fresh =
    rec.gDir === cwd && stamp !== null && nowMs - stamp >= 0 && nowMs - stamp < GIT_CACHE_MS;
  if (fresh) return { status: rec.gSt ?? null, root: rec.gRoot ?? null, refreshed: false };

  const status = gitStatus(cwd);
  rec.gDir = cwd;
  rec.gTs = nowMs;
  rec.gSt = status;
  // Only the background-fetch debounce needs the repo root, and only on an
  // attached branch -- but resolving it walks up to 64 directories with an
  // existsSync each, so it rides the same cache rather than repeating on every
  // render for the sake of a check that fires once per 600s.
  rec.gRoot = status && status.branch && !status.detached ? findRepoRoot(cwd) : null;
  return { status, root: rec.gRoot, refreshed: true };
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
    rec.tCtx = null;
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

      const rIn = num(u.input_tokens) ?? 0;
      const rCc = num(u.cache_creation_input_tokens) ?? 0;
      const rCr = num(u.cache_read_input_tokens) ?? 0;

      rec.tOut += num(u.output_tokens) ?? 0;
      rec.tIn += rIn;
      rec.tCc += rCc;
      rec.tCr += rCr;

      // The context LENGTH at this response -- assigned, never summed. The
      // four counters above are lifetime billing figures: they only ever grow,
      // and /compact shrinks the live window without touching them, so using
      // them as a context gauge reports the historical maximum forever after a
      // compaction. This one field is the only honest transcript-side answer
      // to "how big is the window right now", and it drops on its own the
      // moment the first post-compaction response is written.
      rec.tCtx = rIn + rCc + rCr;
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

/* ---------------------------------------------------------------------------
 * Context window state (the /compact boundary)
 * ----------------------------------------------------------------------------
 * `/compact` nulls every context_window field and leaves them null until the
 * next API response lands. Three different wrong answers are available in that
 * gap, and this is the one place that rules all three out:
 *
 *   0%             -- what the raw payload coerces to. The window is not empty,
 *                     it is unknown, and a gauge that drops to zero and springs
 *                     back one response later reads as a rendering fault.
 *   the last value -- the pre-compaction figure, i.e. the session's historical
 *                     maximum. Reporting it is worse than reporting nothing,
 *                     because /compact is precisely the event that made it
 *                     false.
 *   rec.tIn        -- the transcript's CUMULATIVE input total. This is the
 *                     tempting fallback and it is mathematically wrong: it is a
 *                     lifetime billing sum that only grows, so on any session
 *                     past its first compaction it overshoots the real window
 *                     by whole multiples. It is deliberately never read here.
 *
 * Instead the ledger carries a four-field state machine per session, so the
 * boundary is observed once and remembered across renders:
 *
 *   cSeen : the payload has reported a live context at least once
 *   cIn   : the last live total_input_tokens
 *   cComp : we are inside a post-compaction gap
 *   cMax  : the context length at the instant the gap opened -- the ceiling
 *           that must not be reported as current
 *
 * The transcript catches up before the payload does, so once a post-compaction
 * response is written the real shrunk length is available and is shown. A
 * transcript value that has not visibly shrunk is still the pre-compaction
 * response (or /compact's own summarisation call, whose input is the entire
 * history it is summarising), so it is refused rather than believed.
 * ------------------------------------------------------------------------ */

// How much smaller than the pre-compaction ceiling a transcript reading has to
// be before it is accepted as post-compaction. A real compaction collapses the
// window by far more than a quarter; anything above this is the old response.
const COMPACT_SHRINK_RATIO = 0.75;

/**
 * @param rec ledger record, or null when there is no usable session id
 * @returns {{input:number|null, pct:number|null, compacted:boolean, changed:boolean}}
 *          `input`/`pct` are null when the length is genuinely unknown -- the
 *          caller renders that as a marker, never as a number.
 */
function contextState(d, rec) {
  const cw = d?.context_window;
  // Zero is the host's "no data yet" sentinel, not a measurement. The schema
  // defines total_input_tokens/total_output_tokens as 0 before the first API
  // response, and a live window is never genuinely empty -- the system prompt
  // alone is thousands of tokens, and used_percentage is a float, so a real
  // context reads 0.5 rather than 0. Accepting a zero as live would defeat the
  // gap detection below on any host that ZEROES these fields after /compact
  // instead of nulling them, and put the "Ctx 0%" flash straight back.
  const rawIn = num(cw?.total_input_tokens);
  const rawPct = num(cw?.used_percentage);
  const liveIn = rawIn !== null && rawIn > 0 ? rawIn : null;
  const livePct = rawPct !== null && rawPct > 0 ? rawPct : null;
  const liveSize = num(cw?.context_window_size);
  // The window size is a property of the model, not of the turn, so the last
  // one seen stays correct while the payload's copy is null -- and without it
  // there is no denominator to turn a recovered length into a percentage
  // during a compaction gap.
  const size = liveSize ?? num(rec?.cSize);

  // used_percentage can lag total_input_tokens by a response, so derive it when
  // only the token count is there. Without this the gauge reads 0% on exactly
  // the response that ends a compaction gap -- the one frame the whole state
  // machine exists to get right.
  const pctOf = (input) =>
    input !== null && size !== null && size > 0 ? Math.min(100, (input / size) * 100) : null;

  const live = liveIn !== null || livePct !== null;

  // No record to persist into: the payload is all there is.
  if (!rec) {
    return { input: liveIn, pct: livePct ?? pctOf(liveIn), compacted: false, changed: false };
  }

  let changed = false;

  if (live) {
    // A response has landed. The payload is authoritative again and whatever
    // gap we were in is over.
    if (rec.cComp) { rec.cComp = 0; changed = true; }
    if (!rec.cSeen) { rec.cSeen = 1; changed = true; }
    if (liveIn !== null && rec.cIn !== liveIn) { rec.cIn = liveIn; changed = true; }
    if (liveSize !== null && rec.cSize !== liveSize) { rec.cSize = liveSize; changed = true; }
    return { input: liveIn, pct: livePct ?? pctOf(liveIn), compacted: false, changed };
  }

  if (!rec.cSeen) {
    // Nothing has ever been live: a fresh session before its first API call.
    // A RESUMED session is the same shape from the payload's side but not from
    // the transcript's -- it already holds a response, and tCtx is that
    // response's real window size, so the gauge starts populated instead of at
    // zero.
    const t = num(rec.tCtx);
    return { input: t, pct: pctOf(t), compacted: false, changed };
  }

  // Live -> null with a response already behind us is the /compact boundary.
  // Freeze the pre-compaction length as the ceiling and drop it from cIn so no
  // later read can hand it back as the current window.
  if (!rec.cComp) {
    rec.cComp = 1;
    rec.cMax = num(rec.cIn) ?? 0;
    rec.cIn = null;
    changed = true;
  }

  const t = num(rec.tCtx);
  const ceiling = num(rec.cMax) ?? 0;
  const shrunk = t !== null && (ceiling <= 0 || t <= ceiling * COMPACT_SHRINK_RATIO);
  return { input: shrunk ? t : null, pct: shrunk ? pctOf(t) : null, compacted: true, changed };
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
 * Record this render's session cost and roll up the historical buckets. Also
 * the one place the ledger file is read and written, so the transcript offset
 * and the git-status cache both ride along rather than opening files of their
 * own.
 *
 * `git` is undefined -- not null -- when no cache was available; null is the
 * cached answer for "not a repo". See lineRepo.
 *
 * @returns {{session:number, day:number, week:number, month:number,
 *            period:number|null, periodEnd:number|null,
 *            git:object|null|undefined, gitRoot:string|null|undefined}}
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

/* ---------------------------------------------------------------------------
 * Per-day cost buckets
 * ----------------------------------------------------------------------------
 * `cost.total_cost_usd` is a running total for the whole session, so the ledger
 * only ever sees one number per session. The roll-up used to attribute all of
 * it to the day the session STARTED, which means a session left open across
 * midnight drops out of D entirely: at 00:20 you can be $6 into today's work
 * and read `D $0.00`. W and M have the same defect at their own boundaries, it
 * is just rarer to be looking when one crosses.
 *
 * Every render already computes the delta since the last one -- it has to, to
 * split Fable spend out of a session that switched models mid-way. That same
 * delta lands in a bucket keyed by the LOCAL calendar date, so the roll-up sums
 * buckets rather than guessing from a single anchor, and a session that spans a
 * boundary is split across it instead of landing entirely on one side.
 *
 *   days: { '2026-08-06': [total, fableShare] }
 *
 * Sub-day windows (a 17:00 budget reset, the Fable window anchored on the
 * host's `resets_at`) cannot be answered exactly at day granularity. A bucket
 * that OVERLAPS such a window counts in full: a gauge that overstates the
 * boundary day is a safer failure than one that silently drops it.
 * ------------------------------------------------------------------------ */

/** Local calendar date as YYYY-MM-DD. Local rather than UTC because every
 *  boundary the roll-up compares against is a local midnight. */
function dayKey(ms) {
  const t = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;
}

/** `[start, end)` of a day key as local epoch ms, or null if unparseable.
 *  Built from date components, so a DST day is 23 or 25 hours and not 24. */
function dayRange(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  const dd = Number(m[3]);
  const start = new Date(y, mo, dd).getTime();
  if (!Number.isFinite(start)) return null;
  return [start, new Date(y, mo, dd + 1).getTime()];   // Date normalises overflow
}

/** Accrue `amount` into the bucket for the day containing `nowMs`. */
function addDay(rec, nowMs, amount, fable) {
  if (!rec.days || typeof rec.days !== 'object') rec.days = {};
  const key = dayKey(nowMs);
  const cur = Array.isArray(rec.days[key]) ? rec.days[key] : [0, 0];
  rec.days[key] = [
    (num(cur[0]) ?? 0) + amount,
    (num(cur[1]) ?? 0) + (fable ? amount : 0),
  ];
}

/**
 * The shape every line builder reads. Defined once because updateLedger() fills
 * it in and main() needs an identical fallback for the case where updateLedger
 * itself throws -- a field added to one and forgotten in the other is a silent
 * `undefined` reaching a gauge.
 *
 * `scoped` / `weekly` / `snapshotAt` are the usage endpoint's answer and `calib`
 * the correction learned from it. All four stay null while the feature is off,
 * which is what makes fableCell() fall straight back to the behaviour it had
 * before the endpoint existed.
 */
function emptyTotals(cost, context) {
  return {
    session: cost, day: cost, week: cost, month: cost,
    tokens: null, period: null, periodEnd: null,
    fable: 0, fableWindow: 0,
    scoped: null, weekly: null, calib: null, snapshotAt: null,
    context,
  };
}

function updateLedger(d) {
  // The id becomes a plain-object key. Refuse anything that could collide with
  // Object.prototype ("__proto__", "constructor") or smuggle odd characters --
  // a hostile id degrades to "count the cost, skip the ledger record".
  let sessionId = d?.session_id;
  if (typeof sessionId !== 'string' || !/^[\w.-]{1,128}$/.test(sessionId) ||
      sessionId === '__proto__' || sessionId === 'constructor') {
    sessionId = '';
  }
  const cost = num(d?.cost?.total_cost_usd) ?? 0;
  const fable = isFableModel(d);
  // The context is resolved from the payload alone for now, so every early
  // return below still hands back a usable reading rather than an implicit zero.
  const totals = emptyTotals(cost, contextState(d, null));

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
      // A session first seen while Fable is active has no earlier model to
      // split against, so everything it has spent so far is Fable's. In
      // practice that is $0 -- the first render lands before the first
      // response does.
      rec = store.sessions[sessionId] = { first: now, last: now, cost, fab: fable ? cost : 0 };
      addDay(rec, now, cost, fable);
      dirty = true;
    } else {
      // A record written before per-day buckets existed carries its whole spend
      // in `cost`. Fold that into the day it started -- the same day the old
      // roll-up would have counted it against -- so switching to bucket-summing
      // does not make an in-flight session's history vanish.
      if (!rec.days || typeof rec.days !== 'object') {
        rec.days = {};
        const anchor = num(rec.first) ?? num(rec.last) ?? now;
        rec.days[dayKey(anchor)] = [num(rec.cost) ?? 0, num(rec.fab) ?? 0];
        dirty = true;
      }

      const prev = num(rec.cost) ?? 0;
      const best = Math.max(prev, cost);
      // Only rewrite when the number actually moved. At a 300ms debounce this
      // turns most renders into a pure read and keeps the disk quiet.
      if (best !== rec.cost) { rec.cost = best; dirty = true; }
      // Segregate by DELTA, not by session -- for the day bucket and the Fable
      // bucket alike. /model switches mid-session, and attributing a whole
      // session to whichever model happened to be active at the last render
      // would move dollars between buckets retroactively: a Sonnet session that
      // ends with one Fable turn would land entirely in the Fable bucket. Only
      // spend that accrued while Fable was the active model is Fable's, and
      // only spend that accrued today is today's.
      if (best > prev) {
        addDay(rec, now, best - prev, fable);
        if (fable) rec.fab = (num(rec.fab) ?? 0) + (best - prev);
        dirty = true;
      }
      if (!num(rec.first)) { rec.first = now; dirty = true; }
    }

    // Day buckets share the ledger's own retention horizon. Only the session
    // being touched is swept; every other record is pruned whole, below.
    for (const key of Object.keys(rec.days)) {
      const range = dayRange(key);
      if (!range || range[1] <= now - LEDGER_RETENTION_DAYS * 86400000) {
        delete rec.days[key];
        dirty = true;
      }
    }

    // Token accumulation shares the ledger read/write: a separate store would
    // mean two file round-trips per render for the same session record.
    const beforeOffset = rec.tOff;
    try {
      totals.tokens = accumulateTranscript(rec, d?.transcript_path);
    } catch {
      totals.tokens = null;
    }
    if (rec.tOff !== beforeOffset) dirty = true;

    // Strictly AFTER the transcript pass: inside a compaction gap the shrunk
    // window shows up in the transcript before the payload admits it exists,
    // and contextState() reads rec.tCtx to find it.
    try {
      const ctx = contextState(d, rec);
      totals.context = ctx;
      if (ctx.changed) dirty = true;
    } catch {
      /* keep the payload-only reading established above */
    }

    // Git state rides the same round-trip, for the same reason the transcript
    // offset does: a second store would mean a second pair of file operations
    // per render for the same session. `totals.git` stays undefined on every
    // path that could not produce a record, and lineRepo reads that as "no
    // cache available this render" and falls back to a live call.
    if (GIT_ENABLED) {
      const cwd = gitCwd(d);
      if (cwd) {
        try {
          const g = cachedGitState(rec, cwd, now);
          totals.git = g.status;
          totals.gitRoot = g.root;
          if (g.refreshed) dirty = true;
        } catch {
          /* leave totals.git undefined: lineRepo spawns git itself */
        }
      }
    }

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
  const today = new Date(now);
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const startOfWeek = startOfToday - 6 * 86400000;                      // today + previous 6 days
  const startOfMonth = new Date(today.getFullYear(), today.getMonth(), 1).getTime();

  // The budget period is a separate window from the D/W/M buckets: it can end
  // at 17:00 on the last day of the month rather than at a calendar boundary,
  // so it needs its own start and its own bounded end. Folded into the same
  // pass -- a second walk of the store per render buys nothing.
  const win = budgetWindow(now);
  if (win) {
    totals.period = BUDGET_OFFSET;
    totals.periodEnd = win.end;
  }

  // The Fable allowance is scoped to the same seven-day window the weekly limit
  // uses, so anchor on the host's own `resets_at` rather than on a local
  // calendar boundary -- a bucket that disagrees with the window it is measured
  // against is worse than no bucket. A stamp that is not plausibly the end of
  // the window we are inside would slide the bucket by days, so it is refused
  // and a rolling seven days is used instead (also the billed-plan path, where
  // no window is sent at all).
  const resetsMs = (num(d?.rate_limits?.seven_day?.resets_at) ?? 0) * 1000;
  const fableStart = resetsMs > now && resetsMs - now <= SEVEN_DAY_SECONDS * 1000
    ? resetsMs - SEVEN_DAY_SECONDS * 1000
    : now - SEVEN_DAY_SECONDS * 1000;

  totals.day = 0;
  totals.week = 0;
  totals.month = 0;
  // One bucket's contribution. D/W/M all close on a local midnight, so a day
  // either starts inside them or does not. The budget period and the Fable
  // window can close at any hour, so a bucket that OVERLAPS them counts in
  // full -- see the note above dayKey().
  const addBucket = (start, end, c, f) => {
    if (start >= startOfToday) totals.day += c;
    if (start >= startOfWeek) totals.week += c;
    if (start >= startOfMonth) totals.month += c;
    if (win && end > win.start && start < win.end) totals.period += c;
    if (end > fableStart) {
      // Both halves of the ratio come from the same window, so an incomplete
      // ledger (installed mid-week, work done on another machine) skews them
      // together and the Fable SHARE stays roughly right even when neither
      // absolute figure is.
      totals.fable += f;
      totals.fableWindow += c;
    }
  };

  for (const rec of Object.values(store.sessions)) {
    const days = rec && rec.days;
    if (days && typeof days === 'object') {
      for (const [key, pair] of Object.entries(days)) {
        const range = dayRange(key);
        if (!range) continue;
        const c = num(Array.isArray(pair) ? pair[0] : pair);
        if (c === null) continue;
        addBucket(range[0], range[1], c, (Array.isArray(pair) && num(pair[1])) || 0);
      }
      continue;
    }

    // A record this build has never touched, so it has no buckets: fall back to
    // the whole session total against the day it started. That is exactly what
    // the roll-up did before buckets existed, and it is what these records were
    // written to mean. They convert the first time their session renders again.
    const c = num(rec && rec.cost);
    const anchor = num(rec && (rec.first ?? rec.last));
    if (c === null || anchor === null) continue;
    addBucket(anchor, anchor + 1, c, num(rec.fab) ?? 0);
  }

  // A brand-new session that hasn't been flushed yet must still appear in the
  // live totals, and a session id we never got must not vanish from them.
  if (!sessionId) {
    totals.day += cost;
    totals.week += cost;
    totals.month += cost;
    totals.fableWindow += cost;
    if (fable) totals.fable += cost;
    if (win) totals.period += cost;
  }

  // --- ground truth, and what it teaches the estimator --------------------
  //
  // Folded into the ledger round-trip rather than done in fableCell(), for two
  // reasons: the correction has to be PERSISTED to be worth learning, and this
  // is the one function that already holds an open, write-tracked store.
  //
  // The correction is read back unconditionally, OUTSIDE the feature check: it
  // is ledger data, not endpoint data, and a render with no snapshot -- offline,
  // token expired, endpoint switched back off -- is exactly the render that
  // needs it. Only the LEARNING half depends on the endpoint being on.
  const prev = num(store.fcal && store.fcal.k);
  totals.calib = prev;

  if (usageEnabled()) {
    const snap = readUsageSnapshot();
    // Kept whether or not the snapshot is still fresh: the refresh gate needs
    // its AGE to decide, and re-reading the file after the render would be a
    // second round-trip for something already in hand.
    totals.snapshotAt = num(snap && snap.at);
    if (usageFresh(snap, now)) Object.assign(totals, pickUsage(snap, d));

    const truthPct = num(totals.scoped && totals.scoped.percent);
    // Uncalibrated on purpose: this is the raw estimate whose error is being
    // measured, so feeding the correction back into it would drive k to 1 and
    // learn nothing.
    const rawPct = rawFablePct(d, totals);

    if (truthPct !== null && rawPct !== null &&
        truthPct >= CALIB_MIN_PCT && rawPct >= CALIB_MIN_PCT) {
      // Clamp the OBSERVATION before it is blended, not just the result: one
      // absurd sample would otherwise drag the smoothed value for many renders.
      const obs = clamp(truthPct / rawPct, CALIB_MIN_K, CALIB_MAX_K);
      const next = prev === null ? obs : prev * (1 - CALIB_ALPHA) + obs * CALIB_ALPHA;
      const k = clamp(next, CALIB_MIN_K, CALIB_MAX_K);
      totals.calib = k;
      // The bar rounds to whole percent, so a move this small can never change
      // what is drawn -- and at a 300ms debounce, writing it anyway would mean
      // a ledger flush on every single render forever.
      if (prev === null || Math.abs(k - prev) > 0.002) {
        store.fcal = { k, at: now };
        dirty = true;
      }
    }
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
 * Usage endpoint: render-path half
 * ----------------------------------------------------------------------------
 * Everything here is synchronous, allocation-light, and does no network I/O.
 * See the header block near the top for why the work is split this way.
 * ------------------------------------------------------------------------ */

function usageCachePath() { return path.join(claudeDir(), USAGE_CACHE_FILE); }

/**
 * Is the feature switched on? One statSync, and the only cost when it is off.
 *
 * Memoised because two callers ask (the ledger pass and the refresh check) and
 * a flag file cannot change inside the lifetime of a single render.
 */
let usageEnabledCache = null;
function usageEnabled() {
  if (usageEnabledCache !== null) return usageEnabledCache;
  let on = false;
  if (!USAGE_DISABLED) {
    try {
      on = fs.statSync(path.join(claudeDir(), USAGE_FLAG_FILE), { throwIfNoEntry: false }) !== undefined;
    } catch {
      on = false;
    }
  }
  usageEnabledCache = on;
  return on;
}

// Everything the child writes is already sanitised, but the cache is a file in
// a shared config directory and anything that can write it gets a string into
// the user's terminal on the next render. So the read side re-checks rather
// than trusting its own past output -- the same stance readFlagFile() takes.
const USAGE_CACHE_MAX_BYTES = 64 * 1024;

/**
 * The last snapshot the detached child wrote, or null.
 *
 * Shape is fixed by normalizeUsage() below -- this side never sees the raw
 * response body, so a schema change upstream cannot reach the renderer as
 * anything but a missing field.
 */
function readUsageSnapshot() {
  try {
    const file = usageCachePath();
    // lstat, not stat: refuse a symlink, and refuse a file large enough to be
    // something other than the ~400 bytes this cache actually is.
    const st = fs.lstatSync(file, { throwIfNoEntry: false });
    if (!st || !st.isFile() || st.isSymbolicLink() || st.size > USAGE_CACHE_MAX_BYTES) return null;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.limits)) return parsed;
  } catch {
    /* absent until the first successful refresh; corrupt means the same thing */
  }
  return null;
}

/** Is this snapshot recent enough to be presented as a measurement? */
function usageFresh(snap, nowMs) {
  const at = num(snap?.at);
  // A stamp from the future is a clock that stepped, not a fresh snapshot.
  return at !== null && nowMs - at >= 0 && nowMs - at <= USAGE_MAX_AGE_MS;
}

/**
 * The two buckets the bar reads, found in one pass: `{ scoped, weekly }`, keyed
 * to match the fields on the ledger's return value so the caller can assign
 * them straight across.
 *
 * `weekly` is the account-wide `weekly_all` figure. `scoped` is the
 * `weekly_scoped` bucket belonging to the model THIS render is for, and the two
 * ends write that model's name differently: the server sends a FAMILY
 * ("Fable"), the payload a full display string ("Claude Fable 5") plus an id
 * ("claude-fable-5"). So the match is the server's first word appearing
 * anywhere in either payload field, case-insensitively -- equality would miss
 * every real pairing, and matching the payload's words against the server would
 * make "Claude" match a scope named "Claude Code".
 *
 * Deliberately not gated on isFableModel(): the endpoint scopes by model, and
 * if the account ever gets a scoped bucket for something else, the cell should
 * report that too rather than staying blank because of a hard-coded name.
 */
function pickUsage(snap, d) {
  const name = `${String(d?.model?.display_name ?? '')} ${String(d?.model?.id ?? '')}`.toLowerCase();
  const out = { scoped: null, weekly: null };

  for (const l of Array.isArray(snap?.limits) ? snap.limits : []) {
    if (!l) continue;
    if (l.kind === 'weekly_all') {
      if (!out.weekly) out.weekly = l;   // first wins; duplicates are not ours
      continue;
    }
    if (out.scoped || l.kind !== 'weekly_scoped' || typeof l.model !== 'string') continue;
    const family = l.model.trim().split(/\s+/)[0];
    if (family && name.includes(family.toLowerCase())) out.scoped = l;
  }

  return out;
}

/** A model name that arrived over the network, reduced to something safe to
 *  print. Shared by the cache writer and the renderer so the two can never
 *  disagree about what "sanitised" means. */
function modelLabel(raw) {
  return typeof raw === 'string' ? raw.replace(/[^\w .+-]/g, '').trim().slice(0, 24) : '';
}

/**
 * Is a refresh worth making a request for, on THIS model?
 *
 * The endpoint answers for the whole account, but the bar only draws a figure
 * for a model that has a scoped bucket. Polling every 90s while on a model that
 * has none is traffic bought for nothing, so the full cadence is reserved for
 * renders that can actually use the answer.
 *
 * Standing down entirely would be a trap, though: a model gets a scoped bucket
 * by appearing in the response, and a gate that only refreshes for models
 * already known to have one could never discover the first. Hence the two
 * escape hatches below -- with no snapshot at all, and once an hour after that,
 * the request goes out regardless of model. That is enough to find a bucket
 * Anthropic adds later, at roughly 1/40th the traffic of the full cadence.
 *
 * @param t the ledger round-trip's return value, for the snapshot it already read
 */
function usageWorthRefreshing(d, t) {
  const at = num(t?.snapshotAt);
  if (at === null) return true;                          // nothing cached yet
  if (Date.now() - at > USAGE_MAX_AGE_MS) return true;   // slow rediscovery
  // A fresh snapshot exists: only keep it fresh if this model reads from it.
  // isFableModel covers the case where the bar would fall back to the estimate,
  // which is calibrated from exactly these responses.
  return t?.scoped != null || isFableModel(d);
}

/**
 * Kick off a detached refresh if the marker has aged past the TTL.
 *
 * Called only AFTER stdout has been written, so even the spawn cannot delay a
 * frame. Never throws: a status bar that fails because a usage figure could not
 * be refreshed would be a strictly worse product than one showing an estimate.
 */
function maybeRefreshUsage(d, t) {
  try {
    if (!usageEnabled() || !usageWorthRefreshing(d, t)) return;
    spawnDebounced(USAGE_CHECK_FILE, USAGE_TTL_MS, '--usage-refresh');
  } catch {
    /* best effort, always */
  }
}

/* ---------------------------------------------------------------------------
 * Usage endpoint: detached-child half
 * ----------------------------------------------------------------------------
 * Nothing below runs on the render path. It may take as long as it likes, and
 * every failure mode is "leave the previous cache alone".
 * ------------------------------------------------------------------------ */

/** Pull the OAuth access token out of a credentials blob, or null. */
function tokenFrom(blob) {
  const tok = blob?.claudeAiOauth?.accessToken;
  // Printable ASCII, no spaces: this value goes into an HTTP header, and the
  // charset check is what makes header injection impossible rather than
  // merely unlikely.
  return typeof tok === 'string' && /^[\x21-\x7e]{20,4096}$/.test(tok) ? tok : null;
}

/**
 * The live OAuth access token, or null.
 *
 * Two stores, because Claude Code uses two:
 *
 *   Windows / Linux   <config>/.credentials.json, plain JSON on disk.
 *   macOS             the login Keychain, under "Claude Code-credentials".
 *                     `security find-generic-password -w` is the only way in,
 *                     and the FIRST call raises a Keychain prompt naming
 *                     /usr/bin/security. Answer "Always Allow" once and it
 *                     never appears again. That prompt is exactly why this
 *                     runs in the detached child and never on the render path:
 *                     a blocking dialog here would freeze the status bar.
 *
 * The Keychain is consulted only when CLAUDE_CONFIG_DIR is unset. A caller that
 * pointed us at a specific config directory means the credentials in THAT
 * directory -- honouring that is what keeps the test suite (and anyone running
 * a sandboxed config) from reaching the real account.
 *
 * The token is returned, used once, and never stored, logged or written to the
 * cache. Nothing else in this file ever sees it.
 */
function readOauthToken() {
  try {
    const file = path.join(claudeDir(), '.credentials.json');
    // lstat, not stat: refuse a symlink pointing somewhere we did not intend to
    // read, on the same terms as the plugin flag files.
    const st = fs.lstatSync(file, { throwIfNoEntry: false });
    if (st && st.isFile() && !st.isSymbolicLink() && st.size <= 64 * 1024) {
      const tok = tokenFrom(JSON.parse(fs.readFileSync(file, 'utf8')));
      if (tok) return tok;
    }
  } catch {
    /* fall through to the platform store */
  }

  if (process.platform === 'darwin' && !process.env.CLAUDE_CONFIG_DIR) {
    try {
      const res = require('child_process').spawnSync(
        '/usr/bin/security',
        ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
        { encoding: 'utf8', timeout: 30000 }
      );
      if (res && !res.error && res.status === 0 && typeof res.stdout === 'string') {
        return tokenFrom(JSON.parse(res.stdout));
      }
    } catch {
      /* no Keychain entry, or the user declined the prompt */
    }
  }

  return null;
}

/** GET the usage endpoint. Resolves the parsed body, or null on any failure. */
function fetchUsage(token) {
  return new Promise((resolve) => {
    let req;
    try {
      req = require('https').request(
        {
          host: USAGE_HOST,
          port: 443,
          path: USAGE_PATH,
          method: 'GET',
          headers: {
            Authorization: `Bearer ${token}`,
            'anthropic-beta': USAGE_BETA,
            Accept: 'application/json',
            'User-Agent': 'claude-statusline',
          },
        },
        (res) => {
          // Redirects are deliberately NOT followed. This request carries a
          // bearer token; following a 302 would hand that credential to
          // whatever host the redirect names. The self-updater follows
          // redirects because it sends no credential at all -- the two are not
          // comparable and must not share a fetch helper.
          if (res.statusCode !== 200) { res.resume(); return resolve(null); }

          const chunks = [];
          let total = 0;
          res.on('data', (c) => {
            total += c.length;
            if (total > USAGE_MAX_BYTES) { res.destroy(); return resolve(null); }
            chunks.push(c);
          });
          res.on('end', () => {
            try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
            catch { resolve(null); }
          });
          res.on('error', () => resolve(null));
        }
      );
    } catch {
      return resolve(null);
    }
    req.setTimeout(USAGE_TIMEOUT_MS, () => req.destroy());
    req.on('error', () => resolve(null));
    req.end();
  });
}

const USAGE_SEVERITIES = new Set(['normal', 'warning', 'critical', 'exceeded']);

/**
 * Reduce the response to the few fields the bar draws, sanitised.
 *
 * Two jobs. The obvious one is size: the real body carries a dozen null
 * codenamed buckets, promotional flags and a support-article URL, none of which
 * the bar reads. The important one is TRUST -- every value here reaches a
 * terminal on the next render, so the model name is stripped to a safe charset
 * and clipped, severity is whitelisted rather than passed through, and percent
 * is clamped. Nothing from the network is written to the cache unfiltered.
 *
 * @returns a snapshot, or null when the body carries no usable limit at all
 */
function normalizeUsage(body) {
  const limits = [];
  for (const e of Array.isArray(body?.limits) ? body.limits : []) {
    if (!e || typeof e !== 'object') continue;
    const pct = num(e.percent);
    if (pct === null) continue;

    const kind = typeof e.kind === 'string' ? e.kind.replace(/[^a-z_]/gi, '').slice(0, 32) : '';
    if (!kind) continue;

    const sev = typeof e.severity === 'string' ? e.severity.toLowerCase().replace(/[^a-z]/g, '') : '';
    // `resets_at` is an ISO 8601 string here, unlike the payload's epoch
    // seconds. Stored as seconds so it matches everything else in this file.
    const resets = typeof e.resets_at === 'string' ? Date.parse(e.resets_at) : NaN;
    const model = modelLabel(e?.scope?.model?.display_name);

    limits.push({
      kind,
      percent: clamp(pct, 0, 100),
      severity: USAGE_SEVERITIES.has(sev) ? sev : 'normal',
      model: model || null,
      resets: Number.isFinite(resets) ? Math.floor(resets / 1000) : null,
    });

    if (limits.length >= 16) break;   // a response with more than this is not ours
  }

  return limits.length ? { v: 1, at: Date.now(), limits } : null;
}

/**
 * Detached-child half: fetch the account's figures and write them to the cache.
 *
 * Named for what it does rather than for the feature it belongs to, so it
 * cannot be mistaken at a glance for maybeRefreshUsage() -- the render-path
 * trigger that spawns it. This is the end that makes the network request.
 *
 * Prints nothing, and its exit code is discarded.
 */
async function cacheUsageSnapshot() {
  if (!usageEnabled()) return;

  const token = readOauthToken();
  if (!token) return;

  const snap = normalizeUsage(await fetchUsage(token));
  if (!snap) return;   // a failed refresh leaves the previous snapshot in place

  const file = usageCachePath();
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(snap), 'utf8');
    fs.renameSync(tmp, file);   // atomic: a render can never read a half-written cache
  } catch {
    try { fs.unlinkSync(tmp); } catch { /* nothing else to do */ }
  }
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
  ? { branch: 'br', clean: 'ok', ahead: '^', behind: 'v', compact: '~' }
  : { branch: '⎇', clean: '✓', ahead: '⇡', behind: '⇣', compact: '↺' };

/**
 * Line 1: repo - branch and working-tree state - session name
 *
 * Symbols follow the reference: a tick when clean, otherwise +N staged,
 * ~N modified, ?N untracked; then unpushed / available-to-pull counts.
 */
function lineRepo(d, ledger, nowSeconds, maxWidth) {
  // workspace.repo.name is parsed host-side from the origin remote, so it costs
  // nothing here. It is absent outside a repo or when there is no origin --
  // fall back to the project directory's own name.
  const dir = d?.workspace?.project_dir || d?.workspace?.current_dir || d?.cwd || '';
  const repoName = cleanText(d?.workspace?.repo?.name) || (dir ? cleanText(path.basename(dir)) : '');

  let gitText = '';
  const cwd = gitCwd(d);
  // Resolved during the ledger round-trip so it can be cached across renders
  // (see cachedGitState). `undefined` means no record was available -- an
  // unusable session id, or an unwritable ledger path -- in which case this
  // line pays for the spawn itself rather than losing the branch entirely.
  const cached = ledger && ledger.git !== undefined;
  if (GIT_ENABLED && cwd) {
    const st = cached ? ledger.git : gitStatus(cwd);
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
        const root = cached ? ledger.gitRoot : findRepoRoot(cwd);
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

/**
 * The local estimate of Fable's share of its weekly allowance, as a raw
 * percentage. Null when the ingredients are not all present.
 *
 * Dollars are the only currency the local ledger and the host's seven-day
 * window have in common, so Fable's slice of the window's SPEND is taken as its
 * slice of the window's LIMIT, and that is measured against the share Fable is
 * allowed to take. Both figures come from the same seven days, so an incomplete
 * ledger (installed mid-week, work done on another machine) moves them together
 * and mostly cancels out of the ratio.
 *
 * The assumption inside it is that a dollar of Fable and a dollar of Sonnet
 * consume the same fraction of the weekly limit. They do not, exactly, and that
 * residual error is what the calibration constant measures and removes -- see
 * the calibration block in updateLedger(). This function stays deliberately
 * UNcorrected so it can serve as the thing being measured.
 *
 * The weekly percentage comes from the payload when there is one and from the
 * usage snapshot otherwise, which is what lets the cell survive the opening
 * stretch of a session: `rate_limits` is absent until the first API response
 * lands, and the snapshot is not.
 */
function rawFablePct(d, t) {
  const spent = num(t?.fable);
  const windowSpend = num(t?.fableWindow);
  const weekPct = num(d?.rate_limits?.seven_day?.used_percentage) ?? num(t?.weekly?.percent);
  if (spent === null || spent < 0) return null;
  if (weekPct === null || windowSpend === null || windowSpend <= 0) return null;

  // Guard the share against a ledger that somehow recorded more Fable spend
  // than total spend -- a partially pruned store can do it, and it must not
  // project past the whole window.
  const share = Math.min(1, spent / windowSpend);

  const pct = ((weekPct * share) / FABLE_WEEKLY_SHARE) * 100;
  return Number.isFinite(pct) ? Math.max(0, pct) : null;
}

/**
 * Colour for a server-reported figure.
 *
 * `severity` is the server's own read on the same number and it knows things
 * the percentage does not -- a soft cap being approached, a bucket already
 * refused -- so it can only ever make the cell MORE alarming, never less. A
 * "normal" severity at 95% still renders red.
 */
function severityColor(severity, pct) {
  if (severity === 'critical' || severity === 'exceeded') return red;
  const base = pctColor(pct);
  if (severity === 'warning' && base === green) return yellow;
  return base;
}

/**
 * The model-scoped weekly allowance, spent: "Fable 42%", or "Fable ~42%" when
 * the number is the local estimate rather than the server's own.
 *
 * Two sources, in order:
 *
 *   1. The `weekly_scoped` bucket from the usage endpoint. This is a
 *      measurement -- the server's percentage of that model's own allowance --
 *      so when it is present and fresh it simply wins, and it is drawn without
 *      the tilde. It is also not Fable-specific: whatever model the account has
 *      a scoped bucket for is what gets reported, under the server's own name
 *      for it.
 *
 *   2. Failing that, the local dollar-ratio estimate, corrected by whatever
 *      calibration the endpoint has taught it so far. Shown only while Fable is
 *      the active model -- it is a pacing gauge for the decision being made
 *      right now, not a historical statistic, and on any other model it would
 *      be a column of noise. The leading "~" is the whole point of the
 *      distinction: an estimate that looks identical to a measurement is how
 *      you end up trusting it at exactly the wrong moment.
 *
 * No seven-day window and no snapshot (billed plans) -> empty, and the cell
 * collapses.
 */
function fableCell(d, t) {
  const scoped = t?.scoped;
  const truth = num(scoped?.percent);
  if (truth !== null) {
    const pct = clamp(truth, 0, 100);
    // The server's own name for the scope, so a rename upstream shows up as a
    // relabelled cell rather than as a wrong one. Re-sanitised here and not
    // merely where it was cached: this is the last point before it reaches a
    // terminal, and it arrived from a file.
    const label = modelLabel(scoped.model) || 'Scoped';
    return `${dim(label)} ${severityColor(scoped.severity, pct)(`${Math.round(pct)}%`)}`;
  }

  if (!isFableModel(d)) return '';

  const raw = rawFablePct(d, t);
  if (raw === null) return '';

  // Clamped at 100 because this estimates a percentage of a limit that cannot
  // be exceeded: the API stops you there. A reading past it is estimator error,
  // not headroom that was actually spent, and "Fable ~180%" would present the
  // error as the measurement. Upstream clamps its authoritative figure the same
  // way.
  const pct = Math.min(100, raw * (num(t?.calib) ?? 1));
  if (!Number.isFinite(pct)) return '';

  return `${dim('Fable')} ${pctColor(pct)(`~${Math.round(pct)}%`)}`;
}

function lineUsage(d, ledger, nowSeconds, maxWidth) {
  const cw = d?.context_window;
  const usage = cw?.current_usage;

  // The window's length and percentage come from the ledger's context state
  // machine rather than straight off the payload: /compact nulls both fields
  // until the next response lands, and every obvious fallback from there is
  // wrong in a different way. See contextState(). `compacted` means "inside
  // that gap"; a null length there means the shrunk size is not knowable yet
  // and is rendered as a marker instead of as a number.
  const ctxState = ledger?.context;
  const compacted = ctxState?.compacted === true;

  // Token counts come from the COMBINED totals, not current_usage.
  //
  // current_usage.input_tokens is fresh, uncached input only -- on a warm
  // session that is a single-digit number ("In 2") while the context actually
  // holds tens of thousands of tokens, which reads as broken. The state machine
  // resolves total_input_tokens, the sum of input + cache_creation +
  // cache_read, i.e. what is really in the window. current_usage is still used
  // below for the cache split, which is the one thing it is genuinely the right
  // source for -- and as a last-resort sum here, EXCEPT inside a compaction gap
  // where it is null and summing it prints exactly the "In 0" flash this path
  // exists to remove.
  const inTok =
    num(ctxState?.input) ??
    (compacted
      ? null
      : (num(usage?.input_tokens) ?? 0) +
        (num(usage?.cache_creation_input_tokens) ?? 0) +
        (num(usage?.cache_read_input_tokens) ?? 0));

  // The percentage is what is drawn; the TOKEN COUNT is what picks the colour.
  // See the degradation scale above for why the two come from different
  // numbers. Inside a compaction gap neither is knowable, and the marker says
  // so rather than guessing a tier.
  const usedPct = num(ctxState?.pct);
  const ctx = usedPct !== null
    ? `${dim('Ctx')} ${ctxColor(inTok)(`${Math.round(usedPct)}%`)}`
    : compacted
      ? `${dim('Ctx')} ${cyan(GLYPH.compact)}`
      : `${dim('Ctx')} ${ctxColor(0)('0%')}`;

  // Out is the session's CUMULATIVE output, accumulated from the transcript.
  // Neither payload field can supply this: total_output_tokens and
  // current_usage.output_tokens are both the most recent response only, so Out
  // would sit at a few hundred all session while In climbed into six figures.
  // Falls back to the payload when the transcript is unreadable.
  const tok = ledger?.tokens;
  const outTok = num(tok?.out) ?? num(cw?.total_output_tokens) ?? num(usage?.output_tokens) ?? 0;
  // Out is a lifetime figure and survives compaction untouched -- it is what
  // the session has generated, not what is in the window -- so only In can be
  // unknown here.
  const inText = inTok === null ? dim(GLYPH.compact) : group(inTok);
  const tokens = `${dim('In')} ${inText} ${dim('Out')} ${group(outTok)}`;

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
  // Unknown input length -> no gauge at all. Inside a compaction gap the honest
  // answer is "not yet", and a fabricated 0% would read as "plenty of room" at
  // the one moment the number is least trustworthy.
  const longPct = inTok === null ? null : ((inTok + lastOutTok) / 200000) * 100;
  // exceeds_200k_tokens is authoritative for the crossing itself: it is
  // computed host-side from the same response, so trust it over our arithmetic
  // when the two disagree at the boundary.
  const overLong = d?.exceeds_200k_tokens === true;
  const longColor = overLong || longPct >= 100 ? red : longPct >= 80 ? orange : longPct >= 50 ? yellow : green;
  // Once the threshold is actually crossed the label goes red too, not just
  // the number -- at that point it is a billing-tier change, not a gauge, and
  // a dim label beside a red figure reads as ordinary.
  const longLabel = overLong ? red('LngCtx') : dim('LngCtx');
  const longCtx = longPct === null ? '' : `${longLabel} ${longColor(`${Math.round(longPct)}%`)}`;

  // On a 200k model the gauge is Ctx plus one response's output -- the same
  // number twice, since used_percentage is that same input total over that same
  // 200k. It earns its slot only where the two genuinely diverge, i.e. on an
  // extended window. The crossing itself still shows regardless: on a 200k model
  // input plus output can overshoot 200k, and exceeds_200k_tokens firing is a
  // billing-tier event worth a red label even when the percentage is redundant.
  // An unknown window size keeps the cell rather than guessing it away.
  const windowSize = num(cw?.context_window_size);
  const showLong = longCtx !== '' && (overLong || windowSize === null || windowSize > 200000);

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
  // The transcript totals are the only cumulative token figures available --
  // the payload's are window-scoped ("token counts currently in the context
  // window, from the most recent API response"), so falling back to them would
  // divide a whole session's cost by a single response's tokens and print a
  // rate several times too high. There is no honest denominator without the
  // transcript, so null suppresses the cell rather than inventing one.
  const lifetimeTokens = num(tok?.input) !== null
    ? freshIn + cacheCreate + cacheRead + outTok
    : null;

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
    cell(showLong ? longCtx : '', 2),
    ...constraint,
    // Rank 2, placed LAST on the line. Being rightmost means the equal-rank
    // tie with LngCtx -- fit() drops the rightmost -- now takes Fable first.
    cell(fableCell(d, ledger), 2),
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
    if (!fs.statSync(path.join(claudeDir(), UPDATE_FLAG_FILE), { throwIfNoEntry: false })) return;
    spawnDebounced(UPDATE_MARKER_FILE, UPDATE_INTERVAL_MS, '--self-update');
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
 * Detached-child half: fetch, verify, and rename the new files into place.
 *
 * Named for what it does rather than for the feature it belongs to, so it
 * cannot be mistaken at a glance for maybeSelfUpdate() -- the four-line render-
 * path trigger that spawns it. This is the end that overwrites files on disk.
 *
 * Nothing here is on the render path, so it may take as long as it likes. Every
 * failure mode is "leave the installed file alone".
 */
async function installUpdate() {
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
    () => updateLedger(data),
    emptyTotals(0, { input: null, pct: null, compacted: false })
  );

  lines.push(safe(() => lineModel(data, width), 'Claude'));
  lines.push(safe(() => lineUsage(data, ledger, nowSeconds, width), `${dim('Ctx')} 0%`));
  lines.push(safe(() => lineCost(data, ledger, width), money(num(data?.cost?.total_cost_usd) ?? 0)));
  lines.push(safe(() => lineRepo(data, ledger, nowSeconds, width), ''));

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
  maybeRefreshUsage(data, ledger);
}

// The flag strings are an INTERFACE, not an implementation detail: an already
// installed copy spawns these exact arguments, so renaming one would break a
// child spawned from a half-updated file. They stay put even when the functions
// behind them are renamed.
if (process.argv.includes('--self-update')) {
  // Detached child spawned by maybeSelfUpdate(). Never reads stdin, never
  // prints, and its exit code is discarded.
  installUpdate().catch(() => {});
} else if (process.argv.includes('--usage-refresh')) {
  // Detached child spawned by maybeRefreshUsage(). Same contract: no stdin, no
  // stdout, exit code discarded.
  cacheUsageSnapshot().catch(() => {});
} else {
  try {
    main();
  } catch {
    // Absolute last resort: never leave the status bar empty and never exit
    // non-zero, which would make Claude Code log an error on every render.
    try { process.stdout.write('Claude\n'); } catch { /* stdout is gone */ }
  }
}
