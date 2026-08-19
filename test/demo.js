#!/usr/bin/env node
'use strict';
/* ============================================================================
 * Screenshot fixtures for the README. Four shots, no captions -- what the
 * terminal shows is exactly what the image should contain.
 *
 *   node test/demo.js everyday    subscription session (Pro / Max)
 *   node test/demo.js all-fields  every cell populated at once
 *   node test/demo.js billed      API / Bedrock / Vertex / Enterprise, $750/mo
 *   node test/demo.js agents      the companion subagent panel
 *   node test/demo.js             all four, separated by a blank line
 *
 * Everything the statusline reads is real: a scratch git repo carrying genuine
 * staged/modified/untracked/ahead/behind state, a seeded cost ledger, and a
 * synthesised transcript sized so the accumulated Out, Cache and $/Mtok cells
 * land on plausible numbers. The 9-record example transcript makes $/Mtok read
 * $1023.79 -- arithmetically correct, useless in a screenshot.
 *
 * Two things here are drawn by Claude Code, not by these scripts, and are
 * reproduced so the framing matches: the `auto mode on` hint row, and the agent
 * panel's own chrome (the `main` header and the row markers). Everything to the
 * right of a row marker is real subagent-statusline.js output.
 * ========================================================================== */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const MAIN = path.join(ROOT, 'statusline.js');
const SUB = path.join(ROOT, 'subagent-statusline.js');

const MODE = (process.argv[2] || 'all').toLowerCase();

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-shots-'));
const nowMs = Date.now();
const nowSec = Math.floor(nowMs / 1000);
const d = new Date(nowMs);
const startOfToday = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
const startOfMonth = new Date(d.getFullYear(), d.getMonth(), 1).getTime();

/* --- chrome Claude Code draws itself ------------------------------------- */

const HINT = '\u001b[38;5;172m\u23f5\u23f5 auto mode on\u001b[0m \u001b[2m(shift+tab to cycle) \u00b7 \u2190 for agents\u001b[0m';
const PANEL_HEAD = '  \u25cf main';
const MARK_SELECTED = '\u001b[2m\u276f \u23f5\u001b[0m ';
const MARK_PLAIN = '  \u001b[2m\u23f5\u001b[0m ';

/* --- a real repo with real working-tree and upstream state --------------- */

function git(cwd, args) {
  return spawnSync('git', ['-c', 'user.name=demo', '-c', 'user.email=demo@example.com', ...args], {
    cwd, encoding: 'utf8',
  });
}

/**
 * @param {{staged:number, modified:number, untracked:number, ahead:number, behind:number}} state
 * @returns {string} path to the working tree
 */
function makeRepo(name, state) {
  const base = path.join(scratch, name);
  const bare = path.join(base, 'origin.git');
  const work = path.join(base, 'work');
  fs.mkdirSync(base, { recursive: true });

  // Cloning an empty bare repo leaves no branch to work on, so the working
  // tree is initialised directly and wired to the remote afterwards.
  git(base, ['init', '--bare', '-b', 'main', 'origin.git']);
  fs.mkdirSync(work, { recursive: true });
  git(work, ['init', '-b', 'main']);
  git(work, ['remote', 'add', 'origin', bare]);

  fs.writeFileSync(path.join(work, 'tracked-0.txt'), 'seed\n');
  fs.writeFileSync(path.join(work, 'tracked-1.txt'), 'seed\n');
  git(work, ['add', '-A']);
  git(work, ['commit', '-m', 'seed']);
  git(work, ['push', '-u', 'origin', 'main']);

  // Commits that exist only upstream -> `behind`.
  if (state.behind > 0) {
    const other = path.join(base, 'other');
    git(base, ['clone', bare, 'other']);
    for (let i = 0; i < state.behind; i++) {
      fs.writeFileSync(path.join(other, `upstream-${i}.txt`), 'x\n');
      git(other, ['add', '-A']);
      git(other, ['commit', '-m', `upstream ${i}`]);
    }
    git(other, ['push', 'origin', 'main']);
    git(work, ['fetch', 'origin']);
  }

  // Commits that exist only locally -> `ahead`.
  for (let i = 0; i < state.ahead; i++) {
    fs.writeFileSync(path.join(work, `local-${i}.txt`), 'y\n');
    git(work, ['add', '-A']);
    git(work, ['commit', '-m', `local ${i}`]);
  }

  // Working tree: staged additions, unstaged edits to tracked files, untracked.
  for (let i = 0; i < state.staged; i++) {
    fs.writeFileSync(path.join(work, `staged-${i}.txt`), 'z\n');
    git(work, ['add', `staged-${i}.txt`]);
  }
  for (let i = 0; i < state.modified; i++) {
    fs.appendFileSync(path.join(work, `tracked-${i}.txt`), 'edited\n');
  }
  for (let i = 0; i < state.untracked; i++) {
    fs.writeFileSync(path.join(work, `scratch-${i}.txt`), 'w\n');
  }

  return work;
}

/* --- transcript ---------------------------------------------------------- */

/**
 * Write a transcript whose accumulated totals are exactly the ones asked for.
 *
 * `idleSec` sets the prompt-cache countdown. The first read of a transcript is
 * a CATCH-UP read -- there is no prior byte offset to resume from -- and the
 * clock is stamped from the file's mtime rather than from now, precisely so a
 * resumed session does not open on a false 5:00. Every render here is a first
 * read, so backdating the mtime is the only lever on that cell, and it is the
 * honest one: the file really was last written `idleSec` ago.
 *
 * The last record also has to end its turn. `stop_reason: 'tool_use'` means
 * another request is already in flight refreshing the cache, and suppresses
 * the countdown entirely.
 */
function makeTranscript(name, { turns, freshIn, cacheCreate, cacheRead, out, idleSec = 139 }) {
  const file = path.join(scratch, name);
  const split = (total, i) =>
    Math.floor(total / turns) + (i === turns - 1 ? total - Math.floor(total / turns) * turns : 0);

  const lines = [];
  for (let i = 0; i < turns; i++) {
    lines.push(JSON.stringify({
      type: 'assistant',
      requestId: `req_${i}`,
      message: {
        id: `msg_${i}`,
        role: 'assistant',
        model: 'claude-opus-5',
        content: [],
        stop_reason: 'end_turn',
        usage: {
          input_tokens: split(freshIn, i),
          cache_creation_input_tokens: split(cacheCreate, i),
          cache_read_input_tokens: split(cacheRead, i),
          output_tokens: split(out, i),
        },
      },
      uuid: `a-${i}`,
      timestamp: new Date(nowMs - (turns - i) * 30000).toISOString(),
    }));
  }
  fs.writeFileSync(file, lines.join('\n') + '\n');
  const mtime = new Date(nowMs - idleSec * 1000);
  fs.utimesSync(file, mtime, mtime);
  return file;
}

/* --- pricing -------------------------------------------------------------
 * Anthropic list pricing for claude-opus-5, dollars per million tokens. Cache
 * writes are 1.25x input at the default 5-minute TTL; cache reads are 0.1x.
 * Session cost is DERIVED from the transcript totals rather than asserted, so
 * S, D/W/M, $/hr, Bgt and $/Mtok are all the same arithmetic the statusline
 * would do against a real session.
 * ------------------------------------------------------------------------ */

const PRICE = { input: 5, cacheWrite: 6.25, cacheRead: 0.5, output: 25 };

const costOf = (t) =>
  (t.freshIn * PRICE.input + t.cacheCreate * PRICE.cacheWrite +
   t.cacheRead * PRICE.cacheRead + t.out * PRICE.output) / 1e6;

// The three idle ages are deliberately spread across the countdown's colour
// tiers -- 2:41 green, 1:30 yellow, 0:35 red -- so one image shows all three
// without any shot having to lie about how long it has been sitting.
//
// Long session: 98% cache hit, 153k cumulative output.
const LONG = { turns: 60, freshIn: 6000, cacheCreate: 48000, cacheRead: 2646000, out: 153470, idleSec: 139 };
// Ordinary session behind the everyday shot.
const SHORT = { turns: 24, freshIn: 900, cacheCreate: 9600, cacheRead: 289500, out: 6309, idleSec: 210 };
// Billed shot.
const BILLED = { turns: 30, freshIn: 900, cacheCreate: 16500, cacheRead: 290000, out: 18000, idleSec: 265 };

const TRANSCRIPT_LONG = makeTranscript('transcript-long.jsonl', LONG);
const TRANSCRIPT_SHORT = makeTranscript('transcript-short.jsonl', SHORT);
const TRANSCRIPT_BILLED = makeTranscript('transcript-billed.jsonl', BILLED);

/* --- ledger -------------------------------------------------------------- */

const T_TODAY = Math.max(startOfToday + 3600000, nowMs - 10800000);
const T_WEEK = startOfToday - 2 * 86400000 + 43200000;
const T_MONTH = Math.max(startOfMonth + 86400000, startOfToday - 20 * 86400000);

/** Extra dollars per bucket, on top of the live session's own cost. */
function ledger({ today = 0, week = 0, month = 0 }) {
  const sessions = {};
  const add = (id, cost, first) => { if (cost > 0) sessions[id] = { first, last: first, cost }; };
  add('seed-today-a', today * 0.56, T_TODAY);
  add('seed-today-b', today * 0.44, T_TODAY - 5400000);
  add('seed-week-a', week * 0.61, T_WEEK);
  add('seed-week-b', week * 0.39, T_WEEK - 86400000);
  add('seed-month-a', month * 0.52, T_MONTH);
  add('seed-month-b', month * 0.48, T_MONTH - 3 * 86400000);
  return { v: 1, sessions };
}

/* --- rendering ----------------------------------------------------------- */

let seq = 0;

// Everything the statusline writes now lives in one directory under the config
// dir, the ledger included.
const STATE_DIR = 'statusline';

/**
 * Seed the RTK badge.
 *
 * The badge only ever reads a cache a detached `--rtk-refresh` child writes,
 * keyed by project directory -- an entry from the wrong project is a wrong
 * number with a plausible shape, so a miss draws nothing at all. A scratch repo
 * has no entry and never would, so one is written by hand.
 *
 * Stamping it at `now` also keeps this honest: the refresh gate only spawns for
 * a project whose figure has aged past a minute, so a fresh entry means no
 * `rtk` process is started and the number in the image is exactly the number
 * seeded here.
 */
function rtkSeed(dir, pct, saved) {
  return { [dir]: { at: nowMs, pct, saved } };
}

function render(script, payload, { env = {}, seed = { v: 1, sessions: {} }, rtk = null } = {}) {
  const sandbox = fs.mkdtempSync(path.join(scratch, 'cfg-'));
  const state = path.join(sandbox, STATE_DIR);
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(state, 'cost_ledger.json'), JSON.stringify(seed));
  if (rtk) fs.writeFileSync(path.join(state, 'rtk.json'), JSON.stringify(rtk));
  const res = spawnSync(process.execPath, [script], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    cwd: ROOT,
    env: { ...process.env, CLAUDE_CONFIG_DIR: sandbox, ...env },
  });
  return (res.stdout || '').replace(/\n$/, '');
}

const CSI = String.fromCharCode(27) + '[';

const WRAP = 110;

/** Break `text` on word boundaries at `width` columns. */
function wrap(text, width) {
  const out = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    if (!line) line = word;
    else if (line.length + 1 + word.length <= width) line += ' ' + word;
    else { out.push(line); line = word; }
  }
  if (line) out.push(line);
  return out;
}

function heading(title, note) {
  const lines = note ? wrap(note, WRAP) : [];
  console.log(`${CSI}1m${title}${CSI}0m`);
  for (const line of lines) console.log(`${CSI}2m${line}${CSI}0m`);
  const rule = Math.max(title.length, ...lines.map((l) => l.length), 0);
  console.log(`${CSI}2m` + '\u2500'.repeat(Math.min(WRAP, rule)) + `${CSI}0m`);
}

/** A window `usedPct` consumed with `elapsedFraction` of its duration gone. */
const window_ = (usedPct, durationSec, elapsedFraction) => ({
  used_percentage: usedPct,
  resets_at: nowSec + Math.round(durationSec * (1 - elapsedFraction)),
});
const FIVE_HOUR = 18000;
const SEVEN_DAY = 604800;

const base = JSON.parse(fs.readFileSync(path.join(ROOT, 'examples', 'payload.json'), 'utf8'));

const REPO = { host: 'github.com', owner: 'you', name: 'claude-statusline' };

/* ========================================================================== *
 * 1 -- everyday subscription session (Pro / Max)
 * ========================================================================== */

function shotEveryday() {
  heading(
    'Everyday session on a Pro or Max subscription',
    'Both rate-limit windows cool, one untracked file in the tree. Cache carries the seconds left on the prompt cache, and the RTK badge the share of tokens this project\'s filtered commands saved. The last row is Claude Code\'s own hint line, not statusline output.'
  );

  const work = makeRepo('everyday', { staged: 0, modified: 0, untracked: 1, ahead: 0, behind: 0 });
  const payload = {
    ...base,
    session_id: `shot-${seq++}`,
    session_name: 'Add install script to repository',
    transcript_path: TRANSCRIPT_SHORT,
    cwd: work,
    workspace: { current_dir: work, project_dir: work, added_dirs: [], repo: REPO },
    cost: {
      ...base.cost,
      total_cost_usd: costOf(SHORT),
      total_duration_ms: 2400000,
      total_api_duration_ms: 384000,
    },
    context_window: {
      ...base.context_window,
      total_input_tokens: 53763,
      total_output_tokens: 640,
      used_percentage: 5.4,
      remaining_percentage: 94.6,
    },
    fast_mode: false,
    rate_limits: {
      five_hour: window_(1, FIVE_HOUR, 0.06),
      seven_day: window_(2, SEVEN_DAY, 0.85),
    },
  };
  delete payload.agent;

  console.log(render(MAIN, payload, {
    env: { COLUMNS: '104' },
    seed: ledger({ today: 8.05, week: 23.55, month: 87.40 }),
    rtk: rtkSeed(work, 18, 37000),
  }));
  console.log(HINT);
}

/* ========================================================================== *
 * 2 -- every field at once
 * ========================================================================== */

function shotAllFields() {
  heading(
    'Every field at once',
    'Model identity with the 1M-context, effort, thinking, fast, plugin and RTK tags; context, cache with its prompt-cache countdown, long-context and both rate-limit windows with pace arrows; the four cost windows with burn rate and API share; repo, branch, working-tree and worktree state; and the session agent.'
  );

  const work = makeRepo('all-fields', { staged: 2, modified: 1, untracked: 3, ahead: 1, behind: 2 });
  const payload = {
    ...base,
    session_id: `shot-${seq++}`,
    transcript_path: TRANSCRIPT_LONG,
    cwd: work,
    workspace: { ...base.workspace, current_dir: work, project_dir: work, repo: REPO },
    cost: {
      ...base.cost,
      total_cost_usd: costOf(LONG),
      total_duration_ms: 5400000,
      total_api_duration_ms: 1800000,
    },
    context_window: { ...base.context_window, total_input_tokens: 152002, used_percentage: 15.2 },
    rate_limits: {
      five_hour: window_(90, FIVE_HOUR, 0.6),
      seven_day: window_(52, SEVEN_DAY, 0.5),
    },
  };

  console.log(render(MAIN, payload, {
    env: { COLUMNS: '132' },
    seed: ledger({ today: 18.65, week: 81.80, month: 324.58 }),
    rtk: rtkSeed(work, 23, 412000),
  }));
  console.log(HINT);
}

/* ========================================================================== *
 * 3 -- billed plan (API key / Bedrock / Vertex / Enterprise), $750 a month
 * ========================================================================== */

function shotBilled() {
  heading(
    'Billed plan (API key, Bedrock, Vertex, Enterprise) with CC_STATUSLINE_BUDGET=750',
    'No rate_limits is sent on a billed deployment, so the 5h/7d windows give way to the spend gauge against the monthly allocation and the blended cost per million tokens.'
  );

  const api = JSON.parse(fs.readFileSync(path.join(ROOT, 'examples', 'payload-api.json'), 'utf8'));
  const work = makeRepo('billed', { staged: 0, modified: 2, untracked: 1, ahead: 1, behind: 0 });

  const payload = {
    ...api,
    session_id: `shot-${seq++}`,
    transcript_path: TRANSCRIPT_BILLED,
    cwd: work,
    workspace: {
      current_dir: work,
      project_dir: work,
      added_dirs: [],
      repo: { host: 'github.com', owner: 'you', name: 'my-project' },
    },
    // The 1M window is what makes the "(1M context)" tag and the LngCtx cell
    // real; used_percentage has to follow the larger denominator.
    context_window: {
      ...api.context_window,
      context_window_size: 1000000,
      used_percentage: 15.2,
      remaining_percentage: 84.8,
    },
    // A 1.5h session with 30 minutes of API time. Dollars per hour of inference
    // is what the budget runway is projected against.
    cost: {
      ...api.cost,
      total_cost_usd: costOf(BILLED),
      total_duration_ms: 5400000,
      total_api_duration_ms: 1800000,
    },
    effort: { level: 'xhigh' },
  };

  console.log(render(MAIN, payload, {
    env: { COLUMNS: '132', CC_STATUSLINE_BUDGET: '750' },
    seed: ledger({ today: 41.80, week: 96.35, month: 319.20 }),
  }));
  console.log(HINT);
}

/* ========================================================================== *
 * 4 -- the companion subagent panel
 * ========================================================================== */

function shotAgents() {
  heading(
    'The companion subagent statusline',
    'One row per visible teammate below the prompt: name, status, model and effort, context used, age, and what it is doing. The panel header and the row markers are Claude Code\'s chrome; everything to their right is subagent-statusline.js.'
  );

  const work = makeRepo('agents', { staged: 0, modified: 0, untracked: 0, ahead: 0, behind: 0 });
  const payload = {
    ...base,
    session_id: `shot-${seq++}`,
    session_name: 'Final assessment of repository',
    transcript_path: TRANSCRIPT_LONG,
    cwd: work,
    workspace: { current_dir: work, project_dir: work, added_dirs: [], repo: REPO },
    cost: {
      ...base.cost,
      total_cost_usd: costOf(LONG),
      total_duration_ms: 5400000,
      total_api_duration_ms: 1800000,
    },
    context_window: { ...base.context_window, total_input_tokens: 152002, used_percentage: 15.2 },
    rate_limits: {
      five_hour: window_(27, FIVE_HOUR, 0.54),
      seven_day: window_(4, SEVEN_DAY, 0.86),
    },
  };
  delete payload.agent;

  console.log(render(MAIN, payload, {
    env: { COLUMNS: '112' },
    seed: ledger({ today: 24.60, week: 61.20, month: 208.45 }),
  }));
  console.log(HINT);
  console.log('');
  console.log(PANEL_HEAD);

  const sub = {
    columns: 104,
    session_id: payload.session_id,
    tasks: [
      {
        id: 't1', name: 'cavecrew-investigator', type: 'general-purpose', status: 'running',
        description: 'Locate every call site of updateLedger across the repo',
        label: 'grepping src/', startTime: nowMs - 72000, model: 'claude-opus-5', effort: 'xhigh',
        contextWindowSize: 1000000, tokenCount: 42100,
      },
      {
        id: 't2', name: 'code-reviewer', type: 'code-reviewer', status: 'running',
        description: 'Review the diff on branch main', startTime: nowMs - 9000,
        model: 'claude-haiku-4-5-20251001', effort: 'medium',
        contextWindowSize: 200000, tokenCount: 181000,
      },
      {
        id: 't3', name: 'doc-writer', type: 'general-purpose', status: 'completed',
        description: 'Reading examples/README.md', startTime: nowMs - 4320000,
        model: 'claude-sonnet-5', effort: 'medium', contextWindowSize: 200000, tokenCount: 25000,
      },
      {
        id: 't4', name: 'schema-migrator', type: 'general-purpose', status: 'failed',
        description: 'Port the ledger to v2', startTime: nowMs - 300000,
        model: 'claude-sonnet-5', effort: 'low', contextWindowSize: 200000, tokenCount: 9400,
      },
    ],
  };

  const rows = render(SUB, sub).split('\n').filter(Boolean).map((l) => JSON.parse(l).content);
  rows.forEach((content, i) => {
    if (content) console.log((i === 0 ? MARK_SELECTED : MARK_PLAIN) + content);
  });
}

const RUN = {
  everyday: shotEveryday,
  'all-fields': shotAllFields,
  billed: shotBilled,
  agents: shotAgents,
  all: () => {
    shotEveryday(); console.log('');
    shotBilled(); console.log('');
    shotAgents(); console.log('');
    shotAllFields();
  },
};

(RUN[MODE] || RUN.all)();

try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* best effort */ }
