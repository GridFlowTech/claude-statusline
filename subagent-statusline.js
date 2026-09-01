#!/usr/bin/env node
'use strict';
/* ============================================================================
 * Claude Code SUBAGENT statusline  —  Node.js implementation (Windows-first)
 * ----------------------------------------------------------------------------
 * This is the `subagentStatusLine` setting, which is a DIFFERENT feature from
 * `statusLine`. It renders the body of each row in the agent panel below the
 * prompt -- one row per visible subagent -- replacing the default
 * `name · description · token count` rendering.
 *
 * CONTRACT
 *   stdin  : ONE JSON object describing ALL visible rows:
 *              { columns: <usable row width>,
 *                tasks: [ { id, name, type, status, description, label,
 *                           startTime, model, effort, contextWindowSize,
 *                           tokenCount, tokenSamples, cwd }, ... ],
 *                ...base hook fields }
 *   stdout : ONE JSON line PER ROW you want to override:
 *              {"id": "<task id>", "content": "<row body>"}
 *            `content` renders as-is, ANSI included. Omit a task's id entirely
 *            to keep its default rendering; emit an empty content string to
 *            hide the row.
 *
 * WHY A NAME SOMETIMES COMES OFF DISK
 *   `tasks[].name` is filled from Claude Code's agent NAME REGISTRY, which only
 *   holds names that were explicitly allocated (teammates, FleetView rows). A
 *   plain `Agent({subagent_type: "data_dashboard_engineer"})` never registers
 *   one, so `name` arrives undefined and the only other identity in the payload
 *   is `type` -- the task KIND (`local_agent`, `local_bash`, `local_workflow`,
 *   `remote_agent`, `in_process_teammate`), not the agent type. Rendering that
 *   raw puts a literal `local_agent` in the panel for every unnamed agent.
 *   The agent type does exist on disk, in a 142-byte sidecar next to the
 *   teammate's transcript: <session>/subagents/agent-<id>.meta.json, holding
 *   {"agentType", "description", "toolUseId", "spawnDepth"}. That file is read
 *   ONLY for a row that has no name, and never for its transcript.
 *
 * WHY THE MODEL IS READ FROM THE PAYLOAD
 *   Existing implementations of this hook open each teammate's own transcript
 *   at <session>/subagents/agent-<id>.jsonl to discover its model, because
 *   `tasks[]` originally carried no model field. It does now: `model` and
 *   `contextWindowSize` since Claude Code v2.1.205, `effort` since v2.1.214.
 *   Reading them from the payload removes one file read per subagent per tick
 *   and drops a dependency on an internal transcript path that is free to
 *   change. The transcript is never touched here.
 *
 * DESIGN
 *   Same rules as the main statusline: no dependencies, no subprocesses, no
 *   network, everything synchronous, never throws, never exits non-zero, and
 *   every field access is null-guarded. Text only -- no icons or emoji.
 * ========================================================================== */

const fs = require('fs');
const path = require('path');

/* ---------------------------------------------------------------------------
 * Tunables
 * ------------------------------------------------------------------------ */

// Rows for teammates that are not actively running. `false` hides them, which
// keeps the panel to just the work in flight. `true` renders them dimmed.
const SHOW_IDLE_ROWS = true;

// Fallback width when `columns` is missing or nonsensical.
const DEFAULT_COLUMNS = 80;

/* ---------------------------------------------------------------------------
 * ANSI
 * ------------------------------------------------------------------------ */

const USE_COLOR = !process.env.NO_COLOR && process.env.CC_STATUSLINE_NOCOLOR !== '1';
const E = '\u001b[';   // CSI as an escape, never a raw 0x1B byte
const paint = (code, s) => (USE_COLOR && s !== '' ? `${E}${code}m${s}${E}0m` : s);

const dim = (s) => paint('2', s);
const bold = (s) => paint('1', s);
const red = (s) => paint('38;5;203', s);
const cyan = (s) => paint('38;5;110', s);
const green = (s) => paint('38;5;108', s);

const SEP = dim(' · ');

/* ---------------------------------------------------------------------------
 * Context degradation scale
 * ----------------------------------------------------------------------------
 * A teammate's context is coloured by ABSOLUTE TOKENS, not by percentage of its
 * window -- the same scale the main statusline paints its own `Ctx` cell on, so
 * that a number on this panel means what the equivalent number means on the bar
 * above it. Attention degrades on a token scale, and the window size is a
 * licensing decision: 200k of context is exactly as reliable whether the model
 * is willing to accept 200k of it or 1M. Colouring by percentage would say a
 * teammate on a 200k window at 190k is critical while one on a 1M window at
 * 190k is comfortable, when both hold the same 190k.
 *
 * That difference is sharper here than on the main bar, because a panel mixes
 * models: a Haiku row and an Opus row sit one above the other, and percentages
 * against different denominators cannot be compared down the column. Token
 * tiers can.
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
 * Truecolor (38;2;R;G;B) rather than the 256-colour palette the rest of the row
 * uses, because these five hexes are the scale -- an approximation to the
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

/** Painter for a context length, in tokens. */
function ctxColor(tokens) {
  const t = num(tokens) ?? 0;
  for (const [limit, rgb] of CTX_TIERS) {
    if (t < limit) return (s) => paint(`38;2;${rgb}`, s);
  }
  return (s) => paint(`38;2;${CTX_CRITICAL}`, s);
}

/* ---------------------------------------------------------------------------
 * Helpers (mirrors of the main statusline's, kept local so this file stands
 * alone -- a shared require would add a module resolution walk per tick)
 * ------------------------------------------------------------------------ */

function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    /* SharedArrayBuffer unavailable */
  }
}

/** Synchronous stdin read that survives non-blocking pipes on Windows. */
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
      break;
    }
    if (!bytes) break;
    total += bytes;
    parts.push(Buffer.from(buf.subarray(0, bytes)));
    if (total >= MAX_STDIN_BYTES) break;
  }

  return Buffer.concat(parts).toString('utf8');
}

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 12500 -> "12.5k", 1200000 -> "1.2M". Row width is scarce here. */
function compactTokens(n) {
  if (n < 1000) return String(Math.round(n));
  if (n < 1000000) {
    const k = n / 1000;
    return (k < 10 ? k.toFixed(1) : String(Math.round(k))) + 'k';
  }
  return (n / 1000000).toFixed(1) + 'M';
}

const ANSI_RE = /\u001b\[[0-9;]*m/g;
const visibleWidth = (s) => String(s).replace(ANSI_RE, '').length;

/** Strip control bytes: task text is model-authored and lands in a terminal. */
const CONTROL_RE = /[\x00-\x1f\x7f-\x9f]/g;
const clean = (s) => (typeof s === 'string' ? s.replace(CONTROL_RE, '').trim() : '');

function clip(s, max) {
  const str = String(s);
  if (max <= 0) return '';
  return str.length <= max ? str : str.slice(0, Math.max(1, max - 2)) + '..';
}

/** Elapsed time since an ISO timestamp or epoch ms. "" when unusable. */
function elapsed(startTime, nowMs) {
  let start = num(startTime);
  if (start === null && typeof startTime === 'string') {
    const parsed = Date.parse(startTime);
    start = Number.isNaN(parsed) ? null : parsed;
  }
  if (start === null) return '';
  const seconds = Math.floor((nowMs - start) / 1000);
  if (seconds < 0 || seconds > 86400 * 7) return '';   // clock skew or garbage
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h${Math.floor((seconds % 3600) / 60)}m`;
}

/**
 * "claude-opus-5" -> "Opus 5", "claude-haiku-4-5-20251001" -> "Haiku 4.5".
 * Text only, no glyphs. Unknown ids pass through unchanged.
 */
function friendlyModel(id) {
  if (typeof id !== 'string' || !id) return '';
  const m = id.match(/^claude-([a-z]+)(?:-([0-9][0-9-]*?))?(?:-\d{8})?$/);
  if (!m) return clip(clean(id), 20);
  const family = m[1].charAt(0).toUpperCase() + m[1].slice(1);
  // "4-5" is a version, not a range: 4.5. A bare "5" stays "5".
  const version = m[2] ? m[2].replace(/-/g, '.') : '';
  return version ? `${family} ${version}` : family;
}

/** low|medium|high|xhigh|max, or a numeric token budget. */
function friendlyEffort(effort) {
  if (typeof effort === 'string' && effort.trim()) {
    const e = effort.trim().toLowerCase();
    // Whitelist: this is an enum-shaped field headed for a terminal. A numeric
    // string falls through to the token-budget branch below; anything else
    // renders as nothing at all.
    if (/^[a-z][a-z0-9-]{0,15}$/.test(e)) {
      return { xhigh: 'XHigh', max: 'Max' }[e] || e.charAt(0).toUpperCase() + e.slice(1);
    }
  }
  const n = num(effort);
  return n === null ? '' : compactTokens(n);
}

function statusColor(status) {
  switch (status) {
    case 'running': return green;
    case 'failed':
    case 'error': return red;
    case 'completed':
    case 'done': return cyan;
    default: return dim;
  }
}

/* ---------------------------------------------------------------------------
 * Naming
 * ------------------------------------------------------------------------ */

/**
 * `tasks[].type` is the task KIND, not an agent type. When it is all a row has,
 * these are what a reader can actually use -- `local_agent` says nothing that
 * the panel it sits in did not already say.
 */
const KIND_LABEL = {
  local_agent: 'agent',
  local_bash: 'shell',
  local_shell: 'shell',
  local_workflow: 'workflow',
  remote_agent: 'remote agent',
  in_process_teammate: 'teammate',
};

/** Task ids index a path, so they are whitelisted before being joined to one. */
const SAFE_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

/** Agent types are model- and config-authored: keep them short and printable. */
const AGENT_TYPE_RE = /^[A-Za-z0-9 ._:@\/-]{1,48}$/;

/**
 * <session>/subagents/agent-<id>.meta.json -> its `agentType`, or ''.
 *
 * The session directory sits beside the session transcript and carries the same
 * name minus the extension, so `transcript_path` locates it without assuming
 * where Claude Code keeps projects. No transcript path, no lookup: `session_id`
 * alone would only name a directory relative to the cwd, which is a different
 * directory.
 *
 * The sidecar is keyed on the task id, which is the agent id Claude Code names
 * the teammate's own transcript with. If that ever stops holding, the read
 * misses and the row falls back to its kind label -- the same as for a teammate
 * whose sidecar has not been written yet.
 *
 * One read of a ~150-byte file, only for a row the payload did not name, and
 * only for a kind that has such a sidecar. Failure of any kind returns '' and
 * the row falls back to its kind label.
 */
function agentTypeFromSidecar(id, ctx) {
  if (!ctx || !SAFE_ID_RE.test(id)) return '';

  const transcript = typeof ctx.transcriptPath === 'string' ? ctx.transcriptPath.trim() : '';
  const sessionDir = transcript.replace(/\.jsonl$/i, '');
  if (!sessionDir || sessionDir === transcript) return '';   // missing, or not a .jsonl path

  try {
    const file = path.join(sessionDir, 'subagents', `agent-${id}.meta.json`);
    const meta = JSON.parse(fs.readFileSync(file, 'utf8'));
    const agentType = clean(meta?.agentType);
    if (!agentType || !AGENT_TYPE_RE.test(agentType)) return '';
    return agentType === 'main-session' ? 'main' : agentType;
  } catch {
    return '';   // no sidecar, unreadable, or not JSON -- all mean "no name"
  }
}

/**
 * The row's identity, best first: the registered name, then the agent type off
 * disk, then a readable label for the kind. Never the raw kind string.
 */
function rowName(task, ctx) {
  const registered = clean(task?.name);
  if (registered) return registered;

  const kind = clean(task?.type);
  const known = Object.prototype.hasOwnProperty.call(KIND_LABEL, kind);

  if (kind === 'local_agent' || kind === 'remote_agent' || !known) {
    const agentType = agentTypeFromSidecar(clean(task?.id), ctx);
    if (agentType) return agentType;
  }

  if (known) return KIND_LABEL[kind];
  // A kind this file has not seen: make it readable rather than printing an
  // internal identifier verbatim. `local_notebook` -> `notebook`.
  return kind ? kind.replace(/^(?:local|remote|in_process)_/, '').replace(/_/g, ' ') : 'agent';
}

/* ---------------------------------------------------------------------------
 * Row rendering
 * ------------------------------------------------------------------------ */

const cell = (text, rank) => (text ? { text, rank } : null);

/** Join cells, dropping highest-rank (rightmost on a tie) until it fits. */
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
        if (list[i].rank >= worstRank && list[i].rank > 0) { worstRank = list[i].rank; victim = i; }
      }
      if (victim < 0) break;
      list.splice(victim, 1);
    }
  }

  return list.map((c) => c.text).join(sep);
}

/**
 * One row:
 *   code-reviewer · Opus 5 XHigh · 42.1k 21% · 1m12s · reviewing the diff
 *
 * Rank 0 never drops (the name), then status/model, then the description --
 * which is the longest and most expendable part.
 */
function renderRow(task, columns, nowMs, ctx) {
  const status = clean(task?.status).toLowerCase();
  const running = status === 'running';

  if (!running && !SHOW_IDLE_ROWS) return '';   // empty content hides the row

  const paintName = statusColor(status);
  const name = rowName(task, ctx);

  // model + effort read straight from the payload -- no transcript lookup.
  const model = friendlyModel(task?.model);
  const effort = friendlyEffort(task?.effort);
  const modelCell = [model && cyan(model), effort && dim(effort)].filter(Boolean).join(' ');

  // tokenCount against contextWindowSize gives a per-row context percentage,
  // computed the same way the main statusline computes its own. The percentage
  // is what says how much room is left; the COLOUR comes from the raw token
  // count, on the degradation scale above -- see there for why the two are
  // different numbers.
  //
  // The count is painted rather than the percentage, so a row still carries a
  // tier when `contextWindowSize` is absent. That field only arrived in
  // v2.1.205, and the tokens alone are enough to place a teammate on the scale.
  const tokens = num(task?.tokenCount);
  const windowSize = num(task?.contextWindowSize);
  let tokenCell = '';
  if (tokens !== null) {
    tokenCell = ctxColor(tokens)(compactTokens(tokens));
    if (windowSize !== null && windowSize > 0) {
      const pct = (tokens / windowSize) * 100;
      tokenCell += ' ' + dim(`${Math.round(pct)}%`);
    }
  }

  const age = elapsed(task?.startTime, nowMs);

  // `label` is the short live status; `description` is the original task text.
  const detail = clean(task?.label) || clean(task?.description);

  const cells = [
    cell(paintName(bold(name)), 0),
    cell(!running && status ? dim(status) : '', 2),
    cell(modelCell, 3),
    cell(tokenCell, 2),
    cell(age ? dim(age) : '', 4),
    cell(detail ? dim(detail) : '', 5),
  ];

  // First pass drops whole cells. The detail cell is rank 5, so it is the
  // first to go under pressure -- but it is the only cell that says what the
  // teammate is actually doing, so when it did not survive (or the line still
  // overflows), clip it into whatever room remains rather than losing it.
  let line = fit(cells, SEP, columns);
  if (columns !== null && detail) {
    const detailCell = cells[cells.length - 1].text;
    if (visibleWidth(line) > columns || !line.endsWith(detailCell)) {
      const withoutDetail = fit(cells.slice(0, -1), SEP, columns);
      const room = columns - visibleWidth(withoutDetail) - visibleWidth(SEP);
      line = room > 4 ? withoutDetail + SEP + dim(clip(detail, room)) : withoutDetail;
    }
  }

  return line;
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
    // Malformed payload: emit nothing at all, which leaves every row at its
    // default rendering. Strictly better than emitting broken rows.
    return;
  }

  const tasks = Array.isArray(data.tasks) ? data.tasks : [];
  if (!tasks.length) return;

  let columns = num(data.columns);
  if (columns === null || columns < 10) columns = DEFAULT_COLUMNS;

  const nowMs = Date.now();
  const ctx = {
    transcriptPath: typeof data.transcript_path === 'string' ? data.transcript_path : '',
  };
  const out = [];

  for (const task of tasks) {
    const id = task?.id;
    if (typeof id !== 'string' || !id) continue;   // no id: leave the default row
    let content;
    try {
      content = renderRow(task, columns, nowMs, ctx);
    } catch {
      continue;   // one bad task must not take out the other rows
    }
    out.push(JSON.stringify({ id, content }));
  }

  if (out.length) process.stdout.write(out.join('\n') + '\n');
}

try {
  main();
} catch {
  // Emit nothing rather than exiting non-zero: every row keeps its default
  // rendering and Claude Code logs no error.
}
