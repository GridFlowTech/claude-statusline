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
const yellow = (s) => paint('38;5;179', s);
const green = (s) => paint('38;5;108', s);
const cyan = (s) => paint('38;5;110', s);
const orange = (s) => paint('38;5;172', s);
const magenta = (s) => paint('38;5;176', s);

const SEP = dim(' · ');

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
  const buf = Buffer.alloc(CHUNK);
  const parts = [];
  const deadline = Date.now() + 500;

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
    parts.push(Buffer.from(buf.subarray(0, bytes)));
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
const CONTROL_RE = /[\u0000-\u001f\u007f]/g;
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
    return { xhigh: 'XHigh', max: 'Max' }[e] || e.charAt(0).toUpperCase() + e.slice(1);
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
function renderRow(task, columns, nowMs) {
  const status = clean(task?.status).toLowerCase();
  const running = status === 'running';

  if (!running && !SHOW_IDLE_ROWS) return '';   // empty content hides the row

  const paintName = statusColor(status);
  const name = clean(task?.name) || clean(task?.type) || 'agent';

  // model + effort read straight from the payload -- no transcript lookup.
  const model = friendlyModel(task?.model);
  const effort = friendlyEffort(task?.effort);
  const modelCell = [model && cyan(model), effort && dim(effort)].filter(Boolean).join(' ');

  // tokenCount against contextWindowSize gives a per-row context percentage,
  // computed the same way the main statusline computes its own.
  const tokens = num(task?.tokenCount);
  const windowSize = num(task?.contextWindowSize);
  let tokenCell = '';
  if (tokens !== null) {
    tokenCell = dim(compactTokens(tokens));
    if (windowSize !== null && windowSize > 0) {
      const pct = (tokens / windowSize) * 100;
      const colour = pct >= 90 ? red : pct >= 70 ? yellow : green;
      tokenCell += ' ' + colour(`${Math.round(pct)}%`);
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

  // First pass drops whole cells. If the description alone still overflows,
  // clip it rather than losing it -- it is the only cell that says what the
  // teammate is actually doing.
  let line = fit(cells, SEP, columns);
  if (columns !== null && visibleWidth(line) > columns && detail) {
    const withoutDetail = fit(cells.slice(0, -1), SEP, columns);
    const room = columns - visibleWidth(withoutDetail) - visibleWidth(SEP);
    line = room > 4 ? withoutDetail + SEP + dim(clip(detail, room)) : withoutDetail;
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
  const out = [];

  for (const task of tasks) {
    const id = task?.id;
    if (typeof id !== 'string' || !id) continue;   // no id: leave the default row
    let content;
    try {
      content = renderRow(task, columns, nowMs);
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
