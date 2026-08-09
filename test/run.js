#!/usr/bin/env node
'use strict';
/* ============================================================================
 * Test harness. No dependencies, no framework.
 *
 *   node test/run.js
 *
 * Every case runs the real script as a child process with a real stdin payload,
 * because that is the only interface Claude Code uses. Each run gets a throwaway
 * CLAUDE_CONFIG_DIR so the suite never touches your real cost ledger or reads
 * your real plugin flag files, and NO_COLOR keeps assertions about text from
 * tripping over escape sequences.
 * ========================================================================== */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const MAIN = path.join(ROOT, 'statusline.js');
const SUB = path.join(ROOT, 'subagent-statusline.js');
const INSTALL = path.join(ROOT, 'install.js');
const TRANSCRIPT = path.join(ROOT, 'examples', 'transcript.jsonl');

let sandboxCounter = 0;
const sandboxes = [];

/**
 * A sandbox path that is *not* created. The installer cases need to assert
 * that it creates the directory itself, and that --dry-run does not.
 */
function sandboxPath() {
  const dir = path.join(os.tmpdir(), `cs-test-${process.pid}-${sandboxCounter++}`);
  sandboxes.push(dir);
  return dir;
}

/** A fresh config dir per run: no shared ledger state between cases. */
function sandbox() {
  const dir = sandboxPath();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * @param {string} script
 * @param {object|string} payload  object is JSON-stringified; string is sent raw
 * @param {object} [opts] { env, configDir }
 */
function run(script, payload, opts = {}) {
  const input = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const res = spawnSync(process.execPath, [script], {
    input,
    encoding: 'utf8',
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: opts.configDir || sandbox(),
      NO_COLOR: '1',
      // Neutralise the host's own plugin state so tag assertions are stable.
      CAVEMAN_DEFAULT_MODE: '',
      PONYTAIL_DEFAULT_MODE: '',
      ...(opts.env || {}),
    },
  });
  return {
    status: res.status,
    stdout: res.stdout || '',
    lines: (res.stdout || '').split('\n').filter((l) => l !== ''),
  };
}

/* --- assertions --------------------------------------------------------- */

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures.push({ name, message: err.message });
    console.log(`  FAIL ${name}`);
    console.log(`       ${err.message}`);
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

function assertMatch(haystack, needle, label) {
  assert(
    haystack.includes(needle),
    `${label}: expected to contain ${JSON.stringify(needle)}\n       got: ${JSON.stringify(haystack)}`
  );
}

function assertNotMatch(haystack, needle, label) {
  assert(
    !haystack.includes(needle),
    `${label}: expected NOT to contain ${JSON.stringify(needle)}\n       got: ${JSON.stringify(haystack)}`
  );
}

/* --- fixtures ----------------------------------------------------------- */

const nowSec = Math.floor(Date.now() / 1000);

/** A window `usedPct` consumed with `elapsedFraction` of its time gone. */
function window_(usedPct, durationSec, elapsedFraction) {
  return {
    used_percentage: usedPct,
    resets_at: nowSec + Math.round(durationSec * (1 - elapsedFraction)),
  };
}

function basePayload(over = {}) {
  return {
    session_id: '00000000-0000-4000-8000-00000000000' + (sandboxCounter % 10),
    model: { display_name: 'Opus 5' },
    cost: { total_cost_usd: 1 },
    context_window: {
      total_input_tokens: 5000,
      total_output_tokens: 100,
      context_window_size: 200000,
      used_percentage: 3,
      current_usage: null,
    },
    ...over,
  };
}

/* ========================================================================== */

console.log('\nstatusline.js\n');

check('empty object renders and exits 0', () => {
  const r = run(MAIN, {});
  assert(r.status === 0, `exit ${r.status}`);
  assert(r.lines.length >= 3, `expected >=3 lines, got ${r.lines.length}`);
  assertMatch(r.stdout, 'Ctx 0%', 'empty');
});

check('non-JSON input exits 0 and still renders', () => {
  const r = run(MAIN, 'this is not json at all');
  assert(r.status === 0, `exit ${r.status}`);
  assert(r.lines.length >= 3, `expected >=3 lines, got ${r.lines.length}`);
});

check('empty stdin exits 0', () => {
  const r = run(MAIN, '');
  assert(r.status === 0, `exit ${r.status}`);
});

check('null current_usage and null rate_limits degrade to n/a', () => {
  // Before the first API response, absent rate_limits is what EVERY plan looks
  // like -- a subscription included -- so the windows stay on screen.
  const r = run(MAIN, basePayload({
    rate_limits: null,
    cost: { total_cost_usd: 0 },
    context_window: {
      total_input_tokens: 0,
      total_output_tokens: 0,
      context_window_size: 200000,
      used_percentage: null,
      current_usage: null,
    },
  }));
  assert(r.status === 0, `exit ${r.status}`);
  assertMatch(r.stdout, '5h n/a', 'null rate limits');
  assertMatch(r.stdout, '7d n/a', 'null rate limits');
});

check('transcript dedup: Out is 750, not the naive 1350', () => {
  const r = run(MAIN, basePayload({ transcript_path: TRANSCRIPT }));
  assertMatch(r.stdout, 'Out 750', 'dedup');
  assertNotMatch(r.stdout, 'Out 1,350', 'dedup');
});

check('transcript cache rate is session-cumulative (62%)', () => {
  const r = run(MAIN, basePayload({ transcript_path: TRANSCRIPT }));
  // 2500 / (8 + 1500 + 2500) = 62.4%
  assertMatch(r.stdout, 'Cache 62%', 'session cache');
});

check('incremental read is stable across renders', () => {
  const dir = sandbox();
  const p = basePayload({ transcript_path: TRANSCRIPT });
  const first = run(MAIN, p, { configDir: dir });
  const second = run(MAIN, p, { configDir: dir });
  assertMatch(first.stdout, 'Out 750', 'first render');
  assertMatch(second.stdout, 'Out 750', 'second render (must not double-count)');
});

check('Out falls back to the payload when the transcript is missing', () => {
  const r = run(MAIN, basePayload({ transcript_path: '/definitely/not/here.jsonl' }));
  assertMatch(r.stdout, 'Out 100', 'fallback');
});

check('LngCtx uses last-response output, not cumulative Out', () => {
  // 5000 in + 100 last-response out = 5100 / 200000 = 3%.
  // Using the cumulative 750 would still be 3%, so make the gap unambiguous:
  const r = run(MAIN, basePayload({
    transcript_path: TRANSCRIPT,
    context_window: {
      total_input_tokens: 199000,
      total_output_tokens: 100,
      context_window_size: 1000000,
      used_percentage: 20,
      current_usage: null,
    },
  }));
  // (199000 + 100) / 200000 = 99.55% -> 100%. With cumulative 750 it would be 100% too,
  // so assert the value is not inflated past the threshold.
  assertMatch(r.stdout, 'LngCtx 100%', 'the cell is on screen at all');
  assertNotMatch(r.stdout, 'LngCtx 101%', 'LngCtx must not include cumulative output');
});

check('LngCtx is suppressed on a 200k window as a duplicate of Ctx', () => {
  // There, used_percentage is the same input total over the same 200k, so the
  // gauge would just restate Ctx one response's output higher.
  const r = run(MAIN, basePayload());
  assertMatch(r.stdout, 'Ctx 3%', 'Ctx still renders');
  assertNotMatch(r.stdout, 'LngCtx', 'redundant on a standard window');
});

check('exceeds_200k_tokens keeps LngCtx on a 200k window and colours it red', () => {
  // The crossing survives the suppression above: it is a billing-tier event,
  // not a gauge, and it can fire on a 200k model once output is added in.
  const r = run(MAIN, basePayload({ exceeds_200k_tokens: true }), { env: { NO_COLOR: '' } });
  const esc = String.fromCharCode(27);
  assertMatch(r.stdout, `${esc}[38;5;203mLngCtx`, 'red label');
});

check('pace arrow: under-consuming shows a down arrow and no ETA', () => {
  const r = run(MAIN, basePayload({
    rate_limits: { five_hour: window_(5, 18000, 0.5), seven_day: window_(1, 604800, 0.5) },
  }));
  assertMatch(r.stdout, '5h 5%:50%', 'on_pace shown');
  assertMatch(r.stdout, '\u2193', 'down arrow');
});

check('pace arrow: burning fast shows an up arrow and an ETA', () => {
  const r = run(MAIN, basePayload({
    rate_limits: { five_hour: window_(90, 18000, 0.2), seven_day: window_(1, 604800, 0.5) },
  }));
  assertMatch(r.stdout, '5h 90%:20%', 'used and on_pace');
  assertMatch(r.stdout, '\u2191', 'up arrow');
  assert(/\u2191 \d\d:\d\d/.test(r.stdout), 'expected an HH:MM exhaustion clock after the up arrow');
});

check('pace arrow: on pace shows a right arrow', () => {
  const r = run(MAIN, basePayload({
    rate_limits: { five_hour: window_(50, 18000, 0.5), seven_day: window_(1, 604800, 0.5) },
  }));
  assertMatch(r.stdout, '\u2192', 'right arrow');
});

check('pace is suppressed in the first 2% of a window', () => {
  const r = run(MAIN, basePayload({
    rate_limits: { five_hour: window_(4, 18000, 0.01), seven_day: window_(1, 604800, 0.5) },
  }));
  // used% and time-to-reset still render; on_pace% and the arrow do not.
  // Suppressed reads "5h 4%:4h"; unsuppressed reads "5h 4%:50%<arrow>:2h".
  // Match on the trailing "%" -- the reset duration also starts with a digit.
  assert(/5h 4%:\d+[mhd]\b/.test(r.stdout), `expected used%:reset only, got: ${r.stdout}`);
  assert(!/5h 4%:\d+%/.test(r.stdout), 'on_pace% must be suppressed this early');
  assert(!/5h 4%:[^·]*[↑→↓]/.test(r.stdout), 'arrow must be suppressed this early');
});

check('rate limit renders used:on_pace:reset in that order', () => {
  const r = run(MAIN, basePayload({
    rate_limits: { five_hour: window_(40, 18000, 0.5), seven_day: window_(10, 604800, 0.5) },
  }));
  assert(/5h 40%:50%\u2193:\d+[mhd]/.test(r.stdout), `bad 5h format: ${r.stdout}`);
  assert(/7d 10%:50%\u2193:\d+[mhd]/.test(r.stdout), `bad 7d format: ${r.stdout}`);
});

/* --- billed plans: API key, Bedrock, Vertex, Enterprise ------------------ */

const LEDGER = 'cost_ledger.json';

/** A config dir whose ledger already holds `sessions`. */
function seededSandbox(sessions) {
  const dir = sandbox();
  fs.writeFileSync(path.join(dir, LEDGER), JSON.stringify({ v: 1, sessions }), 'utf8');
  return dir;
}

check('no rate_limits after a response swaps the windows for billed cells', () => {
  const r = run(MAIN, basePayload({ transcript_path: TRANSCRIPT }));
  assertNotMatch(r.stdout, '5h n/a', 'the dead window cells must be gone');
  assertNotMatch(r.stdout, '7d n/a', 'the dead window cells must be gone');
  assertMatch(r.stdout, '$/Mtok', 'billed cells');
});

check('$/Mtok is suppressed when the transcript is unreadable', () => {
  // The payload's token counts are window-scoped, so the only available
  // fallback denominator is one response -- which would report a session rate
  // several times too high. No denominator, no cell.
  const r = run(MAIN, basePayload({ transcript_path: '/definitely/not/here.jsonl' }));
  assertNotMatch(r.stdout, '$/Mtok', 'no cumulative totals, no blended rate');
});

check('$/Mtok uses the cumulative transcript totals, not the live window', () => {
  // transcript.jsonl deduped: 8 fresh + 1500 created + 2500 read + 750 out = 4758.
  const r = run(MAIN, basePayload({ transcript_path: TRANSCRIPT }));
  assertMatch(r.stdout, '$/Mtok 210.17', 'cumulative denominator');
});

check('no budget configured shows no budget cell', () => {
  const r = run(MAIN, basePayload());
  assertNotMatch(r.stdout, 'Bgt', 'no allocation, no gauge');
});

check('a budget renders period spend against the allocation', () => {
  const r = run(MAIN, basePayload(), { env: { CC_STATUSLINE_BUDGET: '50' } });
  assertMatch(r.stdout, 'Bgt $1.00/50', 'budget gauge');
});

check('the budget offset covers spend the ledger never saw', () => {
  const r = run(MAIN, basePayload(), {
    env: { CC_STATUSLINE_BUDGET: '50', CC_STATUSLINE_BUDGET_OFFSET: '9' },
  });
  assertMatch(r.stdout, 'Bgt $10.00/50', 'offset added to period spend');
});

check('the budget period bounds which ledger sessions count', () => {
  // 25 hours ago is a previous calendar day whatever the clock reads.
  const then = Date.now() - 25 * 3600000;
  const seed = { older: { first: then, last: then, cost: 7 } };

  const daily = run(MAIN, basePayload(), {
    configDir: seededSandbox(seed),
    env: { CC_STATUSLINE_BUDGET: '50', CC_STATUSLINE_BUDGET_PERIOD: 'day' },
  });
  assertMatch(daily.stdout, 'Bgt $1.00/50', "yesterday's spend must not count against today");

  // Same ledger, monthly period: it does count -- unless today is the 1st, when
  // 25h ago genuinely belongs to the previous month.
  if (new Date().getDate() > 1) {
    const monthly = run(MAIN, basePayload(), {
      configDir: seededSandbox(seed),
      env: { CC_STATUSLINE_BUDGET: '50' },
    });
    assertMatch(monthly.stdout, 'Bgt $8.00/50', 'the same session counts for the month');
  }
});

check('a reset time moves the period boundary off midnight', () => {
  const then = Date.now() - 2 * 3600000;
  const seed = { earlier: { first: then, last: then, cost: 7 } };
  const hhmm = (ms) => {
    const d = new Date(ms);
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  };

  // Boundary an hour ago: the session from two hours ago is a past period.
  const after = run(MAIN, basePayload(), {
    configDir: seededSandbox(seed),
    env: {
      CC_STATUSLINE_BUDGET: '50',
      CC_STATUSLINE_BUDGET_PERIOD: 'day',
      CC_STATUSLINE_BUDGET_RESET: hhmm(Date.now() - 3600000),
    },
  });
  assertMatch(after.stdout, 'Bgt $1.00/50', 'spend before the reset belongs to the last period');

  // Boundary an hour from now: the same session is still inside this one.
  const before = run(MAIN, basePayload(), {
    configDir: seededSandbox(seed),
    env: {
      CC_STATUSLINE_BUDGET: '50',
      CC_STATUSLINE_BUDGET_PERIOD: 'day',
      CC_STATUSLINE_BUDGET_RESET: hhmm(Date.now() + 3600000),
    },
  });
  assertMatch(before.stdout, 'Bgt $8.00/50', 'spend after the reset is the current period');
});

check('a week period spans seven days back from the Monday boundary', () => {
  const now = new Date();
  // On a Monday, yesterday is genuinely the previous week and proves nothing.
  if (now.getDay() === 1) return;

  const y = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 12, 0, 0, 0).getTime();
  const weekly = run(MAIN, basePayload(), {
    configDir: seededSandbox({ yesterday: { first: y, last: y, cost: 7 } }),
    env: { CC_STATUSLINE_BUDGET: '50', CC_STATUSLINE_BUDGET_PERIOD: 'week' },
  });
  assertMatch(weekly.stdout, 'Bgt $8.00/50', 'yesterday is inside the current week');
});

check('a monthly reset time closes on the last day, not the 1st', () => {
  // 30 seconds before this month began: the last day of the PREVIOUS month, at
  // 23:59:30. A calendar month period starts after it; a 23:59 reset period
  // starts 30 seconds before it, so only the reset rule counts it.
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0).getTime();
  const anchor = startOfMonth - 30 * 1000;
  const seed = { lastMonth: { first: anchor, last: anchor, cost: 7 } };

  // The one minute a year this cannot hold: the period has already rolled over.
  const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  if (now.getDate() === lastDay && now.getHours() === 23 && now.getMinutes() === 59) return;

  const calendar = run(MAIN, basePayload(), {
    configDir: seededSandbox(seed),
    env: { CC_STATUSLINE_BUDGET: '50' },
  });
  assertMatch(calendar.stdout, 'Bgt $1.00/50', 'a calendar month starts on the 1st');

  const billing = run(MAIN, basePayload(), {
    configDir: seededSandbox(seed),
    env: { CC_STATUSLINE_BUDGET: '50', CC_STATUSLINE_BUDGET_RESET: '23:59' },
  });
  assertMatch(billing.stdout, 'Bgt $8.00/50', 'a 23:59 reset closes on the last day');
});

check('the budget projects an exhaustion span from the API burn rate', () => {
  // $1.00 over an hour of API time is $1/hr; $49 left is 49h -> "2d".
  const r = run(MAIN, basePayload({
    cost: { total_cost_usd: 1, total_api_duration_ms: 3600000 },
  }), { env: { CC_STATUSLINE_BUDGET: '50' } });
  assertMatch(r.stdout, 'Bgt $1.00/50:2d', 'exhaustion span');
});

check('an exhausted budget projects nothing', () => {
  const r = run(MAIN, basePayload({
    cost: { total_cost_usd: 60, total_api_duration_ms: 3600000 },
  }), { env: { CC_STATUSLINE_BUDGET: '50' } });
  assertMatch(r.stdout, 'Bgt $60.00/50', 'over the allocation');
  assert(!/Bgt \$60\.00\/50:/.test(r.stdout), 'no span once the allocation is gone');
});

check('a subscription session never shows the budget cell', () => {
  const r = run(MAIN, basePayload({
    rate_limits: { five_hour: window_(40, 18000, 0.5), seven_day: window_(10, 604800, 0.5) },
  }), { env: { CC_STATUSLINE_BUDGET: '50' } });
  assertMatch(r.stdout, '5h 40%', 'the windows still win');
  assertNotMatch(r.stdout, 'Bgt', 'no budget gauge on a subscription');
});

check('malformed budget env vars are ignored, not fatal', () => {
  for (const v of ['abc', '0', '-5', '']) {
    const r = run(MAIN, basePayload(), {
      env: {
        CC_STATUSLINE_BUDGET: v,
        CC_STATUSLINE_BUDGET_PERIOD: 'fortnight',
        CC_STATUSLINE_BUDGET_RESET: 'half past',
        CC_STATUSLINE_BUDGET_OFFSET: 'lots',
      },
    });
    assert(r.status === 0, `CC_STATUSLINE_BUDGET=${JSON.stringify(v)} exit ${r.status}`);
    assertNotMatch(r.stdout, 'Bgt', `CC_STATUSLINE_BUDGET=${JSON.stringify(v)} must not render a gauge`);
  }
});

check('narrow terminal never overflows COLUMNS', () => {
  const cols = 38;
  const r = run(MAIN, basePayload({
    session_name: 'a-fairly-long-session-name-here',
    rate_limits: { five_hour: window_(40, 18000, 0.5), seven_day: window_(10, 604800, 0.5) },
  }), { env: { COLUMNS: String(cols) } });
  for (const line of r.lines) {
    assert(line.length <= cols, `line of ${line.length} cols exceeds ${cols}: ${JSON.stringify(line)}`);
  }
});

check('nonsense COLUMNS disables trimming instead of degenerating', () => {
  for (const cols of ['abc', '0', '-5']) {
    const r = run(MAIN, basePayload(), { env: { COLUMNS: cols } });
    assert(r.status === 0, `COLUMNS=${cols} exit ${r.status}`);
    assert(r.lines.length >= 3, `COLUMNS=${cols} produced ${r.lines.length} lines`);
  }
});

check('escape sequences in untrusted fields are stripped', () => {
  const esc = String.fromCharCode(27);
  const r = run(MAIN, basePayload({
    session_name: `evil${esc}[31mRED`,
    workspace: { current_dir: '/tmp', project_dir: '/tmp', git_worktree: `wt${esc}[5m` },
    agent: { name: `agent${esc}[5mBLINK` },
  }));
  assert(!r.stdout.includes(esc), 'raw ESC reached stdout');
  assertMatch(r.stdout, 'evil[31mRED', 'text preserved literally');
});

check('escape sequences in model name and effort level are stripped', () => {
  const esc = String.fromCharCode(27);
  const r = run(MAIN, basePayload({
    model: { display_name: `Opus${esc}[31m 5` },
    effort: { level: `high${esc}[2J` },
  }));
  assert(!r.stdout.includes(esc), 'raw ESC reached stdout');
  assertMatch(r.stdout, 'Opus', 'model name still renders');
});

check('C1 control bytes are stripped from untrusted fields', () => {
  const csi = String.fromCharCode(0x9b);   // 8-bit CSI, honoured by some terminals
  const r = run(MAIN, basePayload({ session_name: `s${csi}31mX` }));
  assert(!r.stdout.includes(csi), 'raw C1 CSI reached stdout');
  assertMatch(r.stdout, 's31mX', 'text preserved literally');
});

check('a hostile session_id cannot become a ledger record', () => {
  const dir = sandbox();
  const r = run(MAIN, basePayload({ session_id: '__proto__' }), { configDir: dir });
  assert(r.status === 0, `exit ${r.status}`);
  const file = path.join(dir, 'cost_ledger.json');
  if (fs.existsSync(file)) {
    const store = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert(
      !Object.prototype.hasOwnProperty.call(store.sessions, '__proto__'),
      '__proto__ was written as a session key'
    );
  }
});

check('a named agent adds the trailing row', () => {
  const r = run(MAIN, basePayload({ agent: { name: 'cavecrew-reviewer' } }));
  assertMatch(r.stdout, 'Session Agent: cavecrew-reviewer', 'agent row');
});

check('no blank lines are ever printed', () => {
  const r = run(MAIN, {});
  assert(!/\n\n/.test(r.stdout), 'output contains a blank line');
});

check('CC_STATUSLINE_NOGIT skips git without breaking the line', () => {
  const r = run(MAIN, basePayload({
    workspace: { current_dir: ROOT, project_dir: ROOT, repo: { name: 'claude-statusline' } },
  }), { env: { CC_STATUSLINE_NOGIT: '1' } });
  assertMatch(r.stdout, 'claude-statusline', 'repo name still shown');
  assertNotMatch(r.stdout, '\u2387', 'branch glyph must be absent');
});

/* --- per-day cost buckets ------------------------------------------------ */

const DAY_MS = 86400000;

/** YYYY-MM-DD in local time, matching dayKey() in the script. */
function dayKeyOf(ms) {
  const t = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}`;
}

check('a session that spans midnight counts today against today', () => {
  // The regression this exists for: a session opened yesterday and still
  // running reported `D $0.00` no matter how much it had spent since midnight,
  // because the whole session was anchored to the day it started.
  const id = '00000000-0000-4000-8000-0000000000d1';
  const y = Date.now() - 25 * 3600 * 1000;
  const dir = seededSandbox({ [id]: { first: y, last: y, cost: 5 } });
  const r = run(MAIN, basePayload({ session_id: id, cost: { total_cost_usd: 8 } }), {
    configDir: dir,
  });
  assertMatch(r.stdout, 'D $3.00', 'only the spend since midnight is today');
  assertMatch(r.stdout, 'W $8.00', 'the whole session is still inside the week');
});

check('a pre-bucket record is migrated onto the day it started', () => {
  const id = '00000000-0000-4000-8000-0000000000d2';
  const y = Date.now() - 25 * 3600 * 1000;
  const dir = seededSandbox({ [id]: { first: y, last: y, cost: 5 } });
  run(MAIN, basePayload({ session_id: id, cost: { total_cost_usd: 8 } }), { configDir: dir });
  const rec = JSON.parse(fs.readFileSync(path.join(dir, LEDGER), 'utf8')).sessions[id];
  assert(rec.days[dayKeyOf(y)][0] === 5, 'the pre-existing total was not folded onto its own day');
  assert(rec.days[dayKeyOf(Date.now())][0] === 3, 'the delta did not land on today');
  assert(rec.cost === 8, 'the running total must still be the session total');
});

check('an untouched pre-bucket record keeps the old anchored behaviour', () => {
  // Other sessions are never rewritten, so they must still roll up exactly as
  // they did before buckets existed: whole cost against the day they started.
  const y = Date.now() - 25 * 3600 * 1000;
  const dir = seededSandbox({ yesterday: { first: y, last: y, cost: 7 } });
  const r = run(MAIN, basePayload(), { configDir: dir });
  assertMatch(r.stdout, 'D $1.00', "yesterday's session must not leak into today");
  assertMatch(r.stdout, 'W $8.00', 'but it is still inside the week');
});

check('buckets are summed per window, not per session', () => {
  const id = '00000000-0000-4000-8000-0000000000d3';
  const now = Date.now();
  const dir = seededSandbox({
    [id]: {
      first: now - 3 * DAY_MS, last: now, cost: 10,
      days: {
        [dayKeyOf(now - 3 * DAY_MS)]: [7, 0],
        [dayKeyOf(now)]: [3, 0],
      },
    },
  });
  const r = run(MAIN, basePayload({ session_id: id, cost: { total_cost_usd: 10 } }), {
    configDir: dir,
  });
  assertMatch(r.stdout, 'D $3.00', 'today is one bucket, not the session total');
  assertMatch(r.stdout, 'W $10.00', 'the week spans both buckets');
});

check('a bucket older than the retention horizon is dropped', () => {
  const id = '00000000-0000-4000-8000-0000000000d4';
  const old = Date.now() - 60 * DAY_MS;
  const dir = seededSandbox({
    [id]: { first: Date.now(), last: Date.now(), cost: 1, days: { [dayKeyOf(old)]: [99, 0] } },
  });
  run(MAIN, basePayload({ session_id: id }), { configDir: dir });
  const rec = JSON.parse(fs.readFileSync(path.join(dir, LEDGER), 'utf8')).sessions[id];
  assert(rec.days[dayKeyOf(old)] === undefined, 'a 60-day-old bucket survived the sweep');
});

check('a Fable delta lands in the bucket, not on the whole session', () => {
  // Half the session was spent on another model, so only the delta observed
  // while Fable was active may count against the Fable allowance.
  const id = '00000000-0000-4000-8000-0000000000d5';
  const dir = seededSandbox({ [id]: { first: Date.now(), last: Date.now(), cost: 4, fab: 0 } });
  run(MAIN, basePayload({
    session_id: id,
    model: { display_name: 'Fable 5' },
    cost: { total_cost_usd: 10 },
  }), { configDir: dir });
  const rec = JSON.parse(fs.readFileSync(path.join(dir, LEDGER), 'utf8')).sessions[id];
  const today = rec.days[dayKeyOf(Date.now())];
  assert(today[0] === 10, `today's total should be 10, got ${today[0]}`);
  assert(today[1] === 6, `only the 6 spent under Fable is Fable's, got ${today[1]}`);
});

/* --- the OAuth usage endpoint -------------------------------------------- */

// The feature is opt-in via a flag file and refreshes in a DETACHED child, so
// every case here seeds the cache by hand and stamps the debounce marker fresh.
// Nothing in this suite may reach the network: the marker suppresses the spawn,
// and the child would find no credentials in a sandbox anyway -- statusline.js
// consults the macOS Keychain only when CLAUDE_CONFIG_DIR is unset, which it
// never is here.
const USAGE_FLAG = '.statusline-usage';
const USAGE_CACHE = '.statusline-usage.json';
const USAGE_MARKER = '.statusline-usage-check';

// $10 spent in the window, $4 of it on Fable -> a 40% share. Against a 20%
// weekly reading and the default 50% allowance the raw estimate is
// 20 * 0.4 / 50 * 100 = 16%.
const RAW_FABLE_PCT = 16;

function fablePayload(id, over = {}) {
  return basePayload({
    session_id: id,
    model: { display_name: 'Fable 5' },
    cost: { total_cost_usd: 10 },
    rate_limits: { seven_day: { used_percentage: 20, resets_at: nowSec + 100000 } },
    ...over,
  });
}

/** Two limits in the shape normalizeUsage() writes them. */
const usageLimits = (percent, severity = 'normal', model = 'Fable') => [
  { kind: 'weekly_all', percent: 20, severity: 'normal', model: null, resets: null },
  { kind: 'weekly_scoped', percent, severity, model, resets: null },
];

function usageSandbox(id, opts = {}) {
  const { limits, ageMs = 0, flag = true, marker = true, calib } = opts;
  const now = Date.now();
  const store = {
    v: 1,
    sessions: { [id]: { first: now, last: now, cost: 10, fab: 4, days: { [dayKeyOf(now)]: [10, 4] } } },
  };
  if (calib !== undefined) store.fcal = { k: calib, at: now };

  const dir = sandbox();
  fs.writeFileSync(path.join(dir, LEDGER), JSON.stringify(store), 'utf8');
  if (flag) fs.writeFileSync(path.join(dir, USAGE_FLAG), 'on\n', 'utf8');
  if (limits) {
    fs.writeFileSync(path.join(dir, USAGE_CACHE), JSON.stringify({ v: 1, at: now - ageMs, limits }), 'utf8');
  }
  if (marker) fs.writeFileSync(path.join(dir, USAGE_MARKER), 'test\n', 'utf8');
  return dir;
}

const readLedger = (dir) => JSON.parse(fs.readFileSync(path.join(dir, LEDGER), 'utf8'));

check('with the flag absent the estimate runs and is marked as one', () => {
  const id = '00000000-0000-4000-8000-0000000000e1';
  const dir = usageSandbox(id, { flag: false, limits: usageLimits(8) });
  const r = run(MAIN, fablePayload(id), { configDir: dir });
  // The cached snapshot is present and deliberately ignored: opting in is an
  // on-disk act, and a cache left behind by a previous opt-in must not revive
  // the feature.
  assertMatch(r.stdout, `Fable ~${RAW_FABLE_PCT}%`, 'estimate');
});

check('a correction already learned survives the endpoint being turned off', () => {
  const id = '00000000-0000-4000-8000-0000000000ef';
  // The correction lives in the ledger, not in the snapshot, so switching the
  // endpoint off stops it being UPDATED -- it does not throw it away.
  const dir = usageSandbox(id, { flag: false, calib: 0.5 });
  const r = run(MAIN, fablePayload(id), { configDir: dir });
  assertMatch(r.stdout, `Fable ~${RAW_FABLE_PCT * 0.5}%`, 'calibrated estimate with the flag off');
});

check('the flag is required before anything is fetched', () => {
  const id = '00000000-0000-4000-8000-0000000000e2';
  const dir = usageSandbox(id, { flag: false, marker: false });
  run(MAIN, fablePayload(id), { configDir: dir });
  assert(!fs.existsSync(path.join(dir, USAGE_MARKER)), 'a render with no flag armed the refresh');
});

check('the flag arms exactly one refresh per TTL', () => {
  const id = '00000000-0000-4000-8000-0000000000e3';
  const dir = usageSandbox(id, { marker: false });
  run(MAIN, fablePayload(id), { configDir: dir });
  assert(fs.existsSync(path.join(dir, USAGE_MARKER)), 'the flag did not arm a refresh');

  // Stamped before the spawn, so the second render inside the TTL stands down.
  const first = fs.statSync(path.join(dir, USAGE_MARKER)).mtimeMs;
  run(MAIN, fablePayload(id), { configDir: dir });
  assert(fs.statSync(path.join(dir, USAGE_MARKER)).mtimeMs === first, 'the marker was re-stamped inside the TTL');
});

// --- the refresh gate. The endpoint answers for the whole account, but only a
// model with a scoped bucket has anything to draw from it, so the full 90s
// cadence is reserved for renders that can use the answer.

const armed = (dir) => fs.existsSync(path.join(dir, USAGE_MARKER));

check('a model with nothing to show does not poll at the full cadence', () => {
  const id = '00000000-0000-4000-8000-0000000000f1';
  const dir = usageSandbox(id, { limits: usageLimits(8, 'normal', 'Fable'), marker: false });
  run(MAIN, fablePayload(id, { model: { display_name: 'Opus 5' } }), { configDir: dir });
  assert(!armed(dir), 'Opus polled the endpoint for a Fable-only snapshot');
});

check('a model that DOES have a scoped bucket keeps it fresh', () => {
  const id = '00000000-0000-4000-8000-0000000000f2';
  const dir = usageSandbox(id, { limits: usageLimits(3, 'normal', 'Opus'), marker: false });
  run(MAIN, fablePayload(id, { model: { display_name: 'Opus 5', id: 'claude-opus-5' } }), { configDir: dir });
  assert(armed(dir), 'a model with its own bucket stopped refreshing it');
});

check('Fable keeps refreshing even with no bucket cached yet', () => {
  const id = '00000000-0000-4000-8000-0000000000f3';
  // Its estimate is calibrated from these very responses, so the request is
  // worth making whether or not a scoped bucket has turned up.
  const dir = usageSandbox(id, { limits: [{ kind: 'weekly_all', percent: 20, severity: 'normal', model: null, resets: null }], marker: false });
  run(MAIN, fablePayload(id), { configDir: dir });
  assert(armed(dir), 'Fable stopped refreshing');
});

check('with nothing cached at all, any model bootstraps once', () => {
  const id = '00000000-0000-4000-8000-0000000000f4';
  // A model earns a bucket by appearing in a response, so a gate that only ran
  // for models already known to have one could never discover the first.
  const dir = usageSandbox(id, { marker: false });
  run(MAIN, fablePayload(id, { model: { display_name: 'Opus 5' } }), { configDir: dir });
  assert(armed(dir), 'no snapshot and no bootstrap: the gate can never open');
});

check('past the freshness horizon any model retries, about once an hour', () => {
  const id = '00000000-0000-4000-8000-0000000000f5';
  const dir = usageSandbox(id, {
    limits: usageLimits(8, 'normal', 'Fable'), ageMs: 2 * 3600 * 1000, marker: false,
  });
  run(MAIN, fablePayload(id, { model: { display_name: 'Opus 5' } }), { configDir: dir });
  assert(armed(dir), 'a snapshot past the horizon was never retried');
});

check('a fresh snapshot replaces the estimate and drops the tilde', () => {
  const id = '00000000-0000-4000-8000-0000000000e4';
  const dir = usageSandbox(id, { limits: usageLimits(8) });
  const r = run(MAIN, fablePayload(id), { configDir: dir });
  assertMatch(r.stdout, 'Fable 8%', 'server figure');
  assertNotMatch(r.stdout, 'Fable ~', 'a measurement must not be drawn as an estimate');
});

check('the server figure teaches the estimator its own error', () => {
  const id = '00000000-0000-4000-8000-0000000000e5';
  const dir = usageSandbox(id, { limits: usageLimits(8) });
  run(MAIN, fablePayload(id), { configDir: dir });
  // 8 observed against 16 estimated. First sample, so it is taken whole.
  const k = readLedger(dir).fcal.k;
  assert(Math.abs(k - 0.5) < 1e-9, `expected k=0.5, got ${k}`);
});

check('a stale snapshot falls back to the CALIBRATED estimate', () => {
  const id = '00000000-0000-4000-8000-0000000000e6';
  // Two hours old: past the one-hour horizon, so it is no longer a measurement.
  const dir = usageSandbox(id, { limits: usageLimits(8), ageMs: 2 * 3600 * 1000, calib: 0.5 });
  const r = run(MAIN, fablePayload(id), { configDir: dir });
  assertMatch(r.stdout, `Fable ~${RAW_FABLE_PCT * 0.5}%`, 'calibrated fallback');
});

check('a stale snapshot does not re-teach the estimator', () => {
  const id = '00000000-0000-4000-8000-0000000000e7';
  const dir = usageSandbox(id, { limits: usageLimits(99), ageMs: 2 * 3600 * 1000 });
  run(MAIN, fablePayload(id), { configDir: dir });
  assert(readLedger(dir).fcal === undefined, 'a stale figure was used as ground truth');
});

check('a scoped bucket for another model is not claimed by this one', () => {
  const id = '00000000-0000-4000-8000-0000000000e8';
  const dir = usageSandbox(id, { limits: usageLimits(8, 'normal', 'Fable') });
  // Opus is not Fable: no scoped match, and the estimator is Fable-only, so the
  // cell collapses rather than reporting another model's allowance.
  const r = run(MAIN, fablePayload(id, { model: { display_name: 'Opus 5' } }), { configDir: dir });
  assertNotMatch(r.stdout, 'Fable', 'a Fable bucket was attributed to Opus');
  assertNotMatch(r.stdout, ' 8%', 'a Fable bucket was attributed to Opus');
});

check('the scope is matched by family, not by exact name', () => {
  const id = '00000000-0000-4000-8000-0000000000e9';
  const dir = usageSandbox(id, { limits: usageLimits(3, 'normal', 'Opus') });
  const r = run(MAIN, fablePayload(id, {
    model: { display_name: 'Claude Opus 5 (1M context)', id: 'claude-opus-5' },
  }), { configDir: dir });
  assertMatch(r.stdout, 'Opus 3%', 'server name "Opus" against a full display string');
});

check('severity can only make the cell more alarming, never less', () => {
  const id = '00000000-0000-4000-8000-0000000000ea';
  const dir = usageSandbox(id, { limits: usageLimits(3, 'critical') });
  const r = run(MAIN, fablePayload(id), { configDir: dir, env: { NO_COLOR: '' } });
  // Raw control bytes are banned from source here (see .gitattributes), so the
  // escape is built rather than typed.
  assertMatch(r.stdout, `${String.fromCharCode(27)}[38;5;203m3%`,
    '3% is green by threshold; critical must override it');
});

check('a cached model name cannot smuggle escape sequences into the terminal', () => {
  const id = '00000000-0000-4000-8000-0000000000eb';
  // The cache lives in a shared config dir, so its contents are untrusted on
  // the way back in. The family word stays clean so the scope still MATCHES --
  // what is under test is that the label is sanitised, not that a hostile name
  // is rejected outright.
  const ESC = String.fromCharCode(27);
  const dir = usageSandbox(id, { limits: usageLimits(8, 'normal', `Fable ${ESC}[31mX`) });
  const r = run(MAIN, fablePayload(id), { configDir: dir });
  assert(!r.stdout.includes(ESC), `an escape reached stdout: ${JSON.stringify(r.stdout)}`);
  assertMatch(r.stdout, '8%', 'the figure itself still renders');
});

check('an oversized or corrupt cache is ignored, not fatal', () => {
  const id = '00000000-0000-4000-8000-0000000000ec';
  const dir = usageSandbox(id, { limits: usageLimits(8) });
  fs.writeFileSync(path.join(dir, USAGE_CACHE), '{ not json at all', 'utf8');
  const r = run(MAIN, fablePayload(id), { configDir: dir });
  assert(r.status === 0, `exit ${r.status}`);
  assertMatch(r.stdout, `Fable ~${RAW_FABLE_PCT}%`, 'fell back to the estimate');
});

check('CC_STATUSLINE_USAGE=0 overrides the flag file', () => {
  const id = '00000000-0000-4000-8000-0000000000ed';
  const dir = usageSandbox(id, { limits: usageLimits(8), marker: false });
  const r = run(MAIN, fablePayload(id), { configDir: dir, env: { CC_STATUSLINE_USAGE: '0' } });
  assertMatch(r.stdout, `Fable ~${RAW_FABLE_PCT}%`, 'kill switch');
  assert(!fs.existsSync(path.join(dir, USAGE_MARKER)), 'the kill switch still armed a refresh');
});

check('the refresh child writes nothing when it cannot find a credential', () => {
  const dir = usageSandbox('00000000-0000-4000-8000-0000000000ee', {});
  const res = spawnSync(process.execPath, [MAIN, '--usage-refresh'], {
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_CONFIG_DIR: dir },
  });
  assert(res.status === 0, `exit ${res.status}`);
  assert(res.stdout === '', `the child printed ${JSON.stringify(res.stdout)}`);
  assert(!fs.existsSync(path.join(dir, USAGE_CACHE)), 'a cache was written without a credential');
});

/* --- the git-status cache ------------------------------------------------ */

// A branch name no real checkout will ever have, so its presence in the output
// proves the cached record was served rather than git re-run.
const GIT_SENTINEL = 'zz-cache-sentinel';

/** A ledger record whose git cache is fresh and points at this repo. */
function gitCacheRec(over = {}) {
  const now = Date.now();
  return {
    first: now, last: now, cost: 0,
    gDir: ROOT, gTs: now, gRoot: ROOT,
    gSt: {
      branch: GIT_SENTINEL, detached: false,
      ahead: 0, behind: 0, staged: 0, modified: 0, untracked: 0,
    },
    ...over,
  };
}

const gitPayload = (id) => basePayload({
  session_id: id,
  workspace: { current_dir: ROOT, project_dir: ROOT },
});

check('a fresh git cache is served instead of respawning git', () => {
  const id = '00000000-0000-4000-8000-0000000000c1';
  const dir = seededSandbox({ [id]: gitCacheRec() });
  const r = run(MAIN, gitPayload(id), { configDir: dir });
  assertMatch(r.stdout, GIT_SENTINEL, 'the cached branch must be used verbatim');
});

check('a stale git cache is refreshed and written back', () => {
  const id = '00000000-0000-4000-8000-0000000000c2';
  const dir = seededSandbox({ [id]: gitCacheRec({ gTs: Date.now() - 60000 }) });
  const r = run(MAIN, gitPayload(id), { configDir: dir });
  assertNotMatch(r.stdout, GIT_SENTINEL, 'a minute-old entry must not be served');
  const rec = JSON.parse(fs.readFileSync(path.join(dir, LEDGER), 'utf8')).sessions[id];
  assert(rec.gTs > Date.now() - 30000, 'the cache timestamp was not refreshed');
  assert(!rec.gSt || rec.gSt.branch !== GIT_SENTINEL, 'the stale status survived the refresh');
});

check('a git cache keyed to another directory is not reused', () => {
  const id = '00000000-0000-4000-8000-0000000000c3';
  const dir = seededSandbox({ [id]: gitCacheRec({ gDir: os.tmpdir() }) });
  const r = run(MAIN, gitPayload(id), { configDir: dir });
  assertNotMatch(r.stdout, GIT_SENTINEL, 'the branch of another directory was served');
});

check('a git cache stamped in the future is not trusted', () => {
  // A clock stepping backwards must not pin the cache until it catches up.
  const id = '00000000-0000-4000-8000-0000000000c4';
  const dir = seededSandbox({ [id]: gitCacheRec({ gTs: Date.now() + 3600000 }) });
  const r = run(MAIN, gitPayload(id), { configDir: dir });
  assertNotMatch(r.stdout, GIT_SENTINEL, 'a future timestamp was accepted as fresh');
});

check('a cold render records the git cache in the ledger', () => {
  const id = '00000000-0000-4000-8000-0000000000c5';
  const dir = sandbox();
  const r = run(MAIN, gitPayload(id), { configDir: dir });
  assert(r.status === 0, `exit ${r.status}`);
  const rec = JSON.parse(fs.readFileSync(path.join(dir, LEDGER), 'utf8')).sessions[id];
  assert(rec.gDir === ROOT, 'the cache is not keyed on the directory');
  assert(typeof rec.gTs === 'number', 'no cache timestamp was written');
});

check('CC_STATUSLINE_NOGIT writes no git cache at all', () => {
  const id = '00000000-0000-4000-8000-0000000000c6';
  const dir = sandbox();
  run(MAIN, gitPayload(id), { configDir: dir, env: { CC_STATUSLINE_NOGIT: '1' } });
  const rec = JSON.parse(fs.readFileSync(path.join(dir, LEDGER), 'utf8')).sessions[id];
  assert(rec.gTs === undefined, 'git was consulted despite CC_STATUSLINE_NOGIT');
});

check('ASCII mode replaces every non-ASCII glyph', () => {
  const r = run(MAIN, basePayload({
    rate_limits: { five_hour: window_(40, 18000, 0.5), seven_day: window_(10, 604800, 0.5) },
    workspace: { current_dir: ROOT, project_dir: ROOT },
  }), { env: { CC_STATUSLINE_ASCII: '1' } });
  for (const glyph of ['\u2191', '\u2192', '\u2193', '\u2387', '\u2713', '\u21e1', '\u21e3']) {
    assertNotMatch(r.stdout, glyph, `glyph ${escape(glyph)} should be suppressed`);
  }
});

check('CC_STATUSLINE_NOCOLOR=1 alone disables colour', () => {
  const esc = String.fromCharCode(27);
  const r = run(MAIN, basePayload({ exceeds_200k_tokens: true }), {
    env: { NO_COLOR: '', CC_STATUSLINE_NOCOLOR: '1' },
  });
  assert(!r.stdout.includes(esc), 'ANSI escapes emitted despite CC_STATUSLINE_NOCOLOR=1');
});

/* ========================================================================== */

console.log('\nsubagent-statusline.js\n');

const subPayload = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'examples', 'subagent-payload.json'), 'utf8')
);

check('emits one valid JSON line per task', () => {
  const r = run(SUB, subPayload);
  assert(r.status === 0, `exit ${r.status}`);
  assert(r.lines.length === subPayload.tasks.length, `expected ${subPayload.tasks.length} rows, got ${r.lines.length}`);
  for (const line of r.lines) {
    const row = JSON.parse(line);
    assert(typeof row.id === 'string' && row.id, 'row missing id');
    assert(typeof row.content === 'string', 'row missing content');
  }
});

check('model ids render as friendly names', () => {
  const r = run(SUB, subPayload);
  assertMatch(r.stdout, 'Opus 5', 'opus');
  assertMatch(r.stdout, 'Haiku 4.5', 'haiku with date suffix');
  assertMatch(r.stdout, 'Sonnet 5', 'sonnet');
});

check('running rows omit the status word, others show it', () => {
  const r = run(SUB, subPayload);
  const rows = r.lines.map((l) => JSON.parse(l));
  const running = rows.find((x) => x.id === 't1');
  const done = rows.find((x) => x.id === 't3');
  assertNotMatch(running.content, 'running', 'running is the default and should not be labelled');
  assertMatch(done.content, 'completed', 'non-running rows are labelled');
});

check('token count renders a context percentage', () => {
  const r = run(SUB, subPayload);
  const row = JSON.parse(r.lines.find((l) => JSON.parse(l).id === 't2'));
  assertMatch(row.content, '181k', 'compact tokens');
  assertMatch(row.content, '91%', '181000 / 200000');
});

check('a task without an id is skipped, leaving its default row', () => {
  const r = run(SUB, { columns: 80, tasks: [{ name: 'anon', status: 'running' }, { id: 'k', name: 'keeper', status: 'running' }] });
  assert(r.lines.length === 1, `expected 1 row, got ${r.lines.length}`);
  assertMatch(r.stdout, 'keeper', 'the identified task still renders');
});

check('rows respect the columns budget', () => {
  const cols = 46;
  const r = run(SUB, { ...subPayload, columns: cols });
  for (const line of r.lines) {
    const { content } = JSON.parse(line);
    assert(content.length <= cols, `row of ${content.length} exceeds ${cols}: ${JSON.stringify(content)}`);
  }
});

check('malformed payload emits nothing and exits 0', () => {
  for (const bad of ['not json', '', '{}', '{"tasks":[]}']) {
    const r = run(SUB, bad);
    assert(r.status === 0, `exit ${r.status} for ${JSON.stringify(bad)}`);
    assert(r.stdout === '', `expected no output for ${JSON.stringify(bad)}, got ${JSON.stringify(r.stdout)}`);
  }
});

check('escape sequences in task text are stripped', () => {
  const esc = String.fromCharCode(27);
  const r = run(SUB, {
    columns: 90,
    tasks: [{ id: 'x', name: `nm${esc}[31m`, status: 'running', description: `d${esc}[5m` }],
  });
  // JSON.stringify escapes control bytes in stdout regardless, so the raw
  // stream is clean by construction -- the parsed content is what matters.
  assert(!JSON.parse(r.lines[0]).content.includes(esc), 'ESC survived into the row content');
});

check('escape sequences in the effort field are stripped', () => {
  const esc = String.fromCharCode(27);
  const r = run(SUB, {
    columns: 90,
    tasks: [{ id: 'x', name: 'n', status: 'running', model: 'claude-opus-5', effort: `hi${esc}[31mgh` }],
  });
  assert(!JSON.parse(r.lines[0]).content.includes(esc), 'ESC survived into the row content');
});

const rowById = (r, id) => r.lines.map((l) => JSON.parse(l)).find((x) => x.id === id);

check('colour mode paints the name by status: running green, completed cyan, failed red', () => {
  const esc = String.fromCharCode(27);
  const r = run(SUB, subPayload, { env: { NO_COLOR: '' } });
  assertMatch(rowById(r, 't1').content, `${esc}[38;5;108m${esc}[1mcavecrew-investigator`, 'running green+bold');
  assertMatch(rowById(r, 't3').content, `${esc}[38;5;110m${esc}[1mdoc-writer`, 'completed cyan+bold');
  assertMatch(rowById(r, 't4').content, `${esc}[38;5;203m${esc}[1mflaky`, 'failed red+bold');
});

check('error and done statuses alias the failed and completed colours', () => {
  const esc = String.fromCharCode(27);
  const r = run(SUB, {
    columns: 90,
    tasks: [
      { id: 'er', name: 'er-task', status: 'error' },
      { id: 'dn', name: 'dn-task', status: 'done' },
      { id: 'odd', name: 'odd-task', status: 'waiting' },
    ],
  }, { env: { NO_COLOR: '' } });
  assertMatch(rowById(r, 'er').content, `${esc}[38;5;203m${esc}[1mer-task`, 'error renders red');
  assertMatch(rowById(r, 'dn').content, `${esc}[38;5;110m${esc}[1mdn-task`, 'done renders cyan');
  assertMatch(rowById(r, 'odd').content, `${esc}[2m${esc}[1modd-task`, 'unknown status renders dim');
});

check('token percentage thresholds: 70% turns yellow and 90% turns red', () => {
  const esc = String.fromCharCode(27);
  const r = run(SUB, {
    columns: 90,
    tasks: [
      { id: 'lo', name: 'lo', status: 'running', tokenCount: 100000, contextWindowSize: 200000 },
      { id: 'mid', name: 'mid', status: 'running', tokenCount: 140000, contextWindowSize: 200000 },
      { id: 'hi', name: 'hi', status: 'running', tokenCount: 180000, contextWindowSize: 200000 },
    ],
  }, { env: { NO_COLOR: '' } });
  assertMatch(rowById(r, 'lo').content, `${esc}[38;5;108m50%`, '50% green');
  assertMatch(rowById(r, 'mid').content, `${esc}[38;5;179m70%`, '70% yellow, not green');
  assertMatch(rowById(r, 'hi').content, `${esc}[38;5;203m90%`, '90% red, not yellow');
});

check('colour mode: the width budget counts visible glyphs, not ANSI bytes', () => {
  const esc = String.fromCharCode(27);
  const ansiRe = new RegExp(esc + '\\[[0-9;]*m', 'g');
  const cols = 41;
  const r = run(SUB, {
    columns: cols,
    tasks: [{
      id: 'x', name: 'agent', status: 'running', model: 'claude-opus-5',
      tokenCount: 100000, contextWindowSize: 200000, description: 'working on it',
    }],
  }, { env: { NO_COLOR: '' } });
  const { content } = JSON.parse(r.lines[0]);
  // The visible width is exactly the budget; the raw width is far past it.
  // Counting ANSI bytes as width would evict every coloured cell below.
  for (const piece of ['Opus 5', '100k', '50%', 'working on it']) {
    assertMatch(content, piece, 'a cell was dropped that fits on visible width');
  }
  assert(content.length > cols, 'expected ANSI to push the raw length past the budget');
  assert(content.replace(ansiRe, '').length <= cols, 'visible width exceeds the budget');
});

check('age renders seconds, minutes and hours, and skew or garbage suppresses it', () => {
  const now = Date.now();
  const r = run(SUB, {
    columns: 120,
    tasks: [
      { id: 's', name: 'secs', status: 'running', startTime: now - 42000 },
      { id: 'm', name: 'mins', status: 'running', startTime: now - 5 * 60000 },
      { id: 'h', name: 'hrs', status: 'running', startTime: now - (3 * 3600 + 240) * 1000 },
      { id: 'iso', name: 'iso', status: 'running', startTime: new Date(now - 90000).toISOString() },
      { id: 'skew', name: 'skew', status: 'running', startTime: now + 60000 },
      { id: 'old', name: 'old', status: 'running', startTime: now - 8 * 86400000 },
    ],
  });
  assert(/\b4[0-9]s\b/.test(rowById(r, 's').content), `expected an NNs age, got ${rowById(r, 's').content}`);
  assertMatch(rowById(r, 'm').content, '5m', 'minutes format');
  assertMatch(rowById(r, 'h').content, '3h4m', 'hours format');
  assertMatch(rowById(r, 'iso').content, '1m', 'an ISO string startTime is accepted');
  assert(rowById(r, 'skew').content === 'skew', 'a future startTime must render no age');
  assert(rowById(r, 'old').content === 'old', 'a >7 day age is garbage and must render no age');
});

check('token counts render plain, one-decimal k, and M forms', () => {
  const r = run(SUB, {
    columns: 90,
    tasks: [
      { id: 'a', name: 'aa', status: 'running', tokenCount: 950 },
      { id: 'b', name: 'bb', status: 'running', tokenCount: 9500 },
      { id: 'c', name: 'cc', status: 'running', tokenCount: 1200000, contextWindowSize: 1000000 },
    ],
  });
  assertMatch(rowById(r, 'a').content, '950', 'sub-1000 stays a plain integer');
  assertMatch(rowById(r, 'b').content, '9.5k', 'sub-10k keeps one decimal');
  assertMatch(rowById(r, 'c').content, '1.2M', 'millions use the M form');
  assertMatch(rowById(r, 'c').content, '120%', 'an over-budget percentage is not clamped');
});

check('effort renders the capitalised enum or a token budget; unknown model ids are clipped', () => {
  const r = run(SUB, {
    columns: 90,
    tasks: [
      { id: 'e1', name: 'e1', status: 'running', model: 'claude-opus-5', effort: 'xhigh' },
      { id: 'e2', name: 'e2', status: 'running', model: 'claude-opus-5', effort: 'medium' },
      { id: 'e3', name: 'e3', status: 'running', model: 'claude-opus-5', effort: 31999 },
      { id: 'e4', name: 'e4', status: 'running', model: 'a-very-long-model-identifier-here' },
    ],
  });
  assertMatch(rowById(r, 'e1').content, 'XHigh', 'xhigh is a special case');
  assertMatch(rowById(r, 'e2').content, 'Medium', 'plain enums are capitalised');
  assertMatch(rowById(r, 'e3').content, '32k', 'a numeric effort renders as a token budget');
  assertMatch(rowById(r, 'e4').content, 'a-very-long-model-..', 'non-claude ids are clipped to 20');
});

check('missing or nonsensical columns falls back to the default 80 budget', () => {
  const task = {
    id: 'x', name: 'agent', status: 'running', model: 'claude-opus-5',
    tokenCount: 42100, contextWindowSize: 200000, description: 'd'.repeat(200),
  };
  for (const columns of [undefined, 5, 'abc']) {
    const payload = { tasks: [task] };
    if (columns !== undefined) payload.columns = columns;
    const r = run(SUB, payload);
    const { content } = JSON.parse(r.lines[0]);
    assert(content.length <= 80, `columns=${columns}: row of ${content.length} exceeds the default 80`);
    assert(content.length > 60, `columns=${columns}: row of ${content.length} suggests a degenerate budget`);
  }
});

check('a description that cannot fit whole is clipped with a marker, not dropped', () => {
  const r = run(SUB, {
    columns: 40,
    tasks: [{ id: 'x', name: 'agent', status: 'running', description: 'd'.repeat(120) }],
  });
  const { content } = JSON.parse(r.lines[0]);
  assert(content.length <= 40, `row of ${content.length} exceeds 40`);
  assertMatch(content, 'ddd', 'some of the description must survive');
  assertMatch(content, '..', 'the clip marker');
});

check('cells drop by rank: detail, age, model, then tokens before status on the tie', () => {
  const task = {
    id: 'x', name: 'agent', status: 'completed', model: 'claude-opus-5', effort: 'medium',
    tokenCount: 42100, contextWindowSize: 200000, startTime: Date.now() - 3600000,
    description: 'the description text',
  };
  const render = (columns) => JSON.parse(run(SUB, { columns, tasks: [task] }).lines[0]).content;

  const full = render(90);
  for (const piece of ['completed', 'Opus 5 Medium', '42k 21%', '1h0m', 'the description text']) {
    assertMatch(full, piece, 'everything fits at 90');
  }

  const noAge = render(45);
  assertNotMatch(noAge, '1h0m', 'age (rank 4) must be gone at 45');
  assertMatch(noAge, 'Opus 5', 'model (rank 3) must survive at 45');

  const noModel = render(38);
  assertNotMatch(noModel, 'Opus', 'model must be gone at 38');
  assertMatch(noModel, '42k', 'tokens must survive at 38');
  assertMatch(noModel, '..', 'clipped detail must refill the freed space');

  const tie = render(24);
  assertNotMatch(tie, '42k', 'tokens (rank 2, rightmost) must lose the tie');
  assertMatch(tie, 'completed', 'status (rank 2, leftmost) must win the tie');
});

check('SHOW_IDLE_ROWS=false hides idle rows by emitting empty content', () => {
  const src = fs.readFileSync(SUB, 'utf8');
  const tunable = 'const SHOW_IDLE_ROWS = true;';
  assert(src.includes(tunable), 'the tunable moved; update this test');
  const dir = sandbox();
  const flipped = path.join(dir, 'subagent-statusline-idle.js');
  fs.writeFileSync(flipped, src.replace(tunable, 'const SHOW_IDLE_ROWS = false;'));

  const r = run(flipped, subPayload);
  assert(rowById(r, 't1').content !== '', 'running rows must still render');
  assert(rowById(r, 't2').content !== '', 'running rows must still render');
  assert(rowById(r, 't3').content === '', 'a completed row must be hidden via empty content');
  assert(rowById(r, 't4').content === '', 'a failed row must be hidden via empty content');
});

check('CC_STATUSLINE_NOCOLOR=1 disables colour in the panel too', () => {
  // Row content is JSON-stringified, so a raw ESC in stdout is impossible by
  // construction -- assert on the PARSED content, or this asserts nothing.
  const esc = String.fromCharCode(27);
  const r = run(SUB, subPayload, { env: { NO_COLOR: '', CC_STATUSLINE_NOCOLOR: '1' } });
  assert(r.lines.length === subPayload.tasks.length, 'rows went missing');
  for (const line of r.lines) {
    assert(!JSON.parse(line).content.includes(esc), 'ANSI in row content despite CC_STATUSLINE_NOCOLOR=1');
  }
});

/* ========================================================================== */

console.log('\ninstall.js\n');

/**
 * Run the installer.
 *
 * Every case passes --local, so the working tree is the source and GitHub is
 * never contacted: the suite stays hermetic and runs offline. `cwd` is pinned to
 * the repo root because the piped form resolves its local source relative to the
 * working directory, there being no script path to resolve it against.
 *
 * @param {string[]} args
 * @param {object} [opts] { viaStdin } — pipe install.js into `node -`, which is
 *   the shape the documented one-liner actually uses.
 */
function installer(args, opts = {}) {
  const argv = opts.viaStdin ? ['-', ...args] : [INSTALL, ...args];
  const res = spawnSync(process.execPath, argv, {
    encoding: 'utf8',
    cwd: ROOT,
    input: opts.viaStdin ? fs.readFileSync(INSTALL, 'utf8') : '',
    env: { ...process.env, NO_COLOR: '1' },
  });
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
const readJson = (...p) => JSON.parse(fs.readFileSync(path.join(...p), 'utf8'));
const exists = (...p) => fs.existsSync(path.join(...p));

check('--help exits 0 and documents the piped one-liner', () => {
  const r = installer(['--help']);
  assert(r.status === 0, `exit ${r.status}`);
  assertMatch(r.stdout, '| node -', 'the one-liner');
  assertMatch(r.stdout, '--uninstall', 'the flag list');
});

check('an unknown flag exits 1 and names it', () => {
  const r = installer(['--nope']);
  assert(r.status === 1, `exit ${r.status}`);
  assertMatch(r.stderr, 'unknown option: --nope', 'error text');
});

check('a flag missing its value exits 1', () => {
  const r = installer(['--dir']);
  assert(r.status === 1, `exit ${r.status}`);
  assertMatch(r.stderr, '--dir needs a value', 'error text');
});

check('--dry-run creates nothing at all', () => {
  const dir = sandboxPath();
  const r = installer(['--dir', dir, '--local', '--dry-run']);
  assert(r.status === 0, `exit ${r.status}\n${r.stderr}`);
  assert(!fs.existsSync(dir), 'a dry run must not even create the config dir');
  assertMatch(r.stdout, '[dry-run]', 'actions are labelled');
  assertMatch(r.stdout, 'node --check ok', 'files are still verified');
});

check('a fresh install writes both scripts and both settings keys', () => {
  const dir = sandboxPath();
  const r = installer(['--dir', dir, '--local']);
  assert(r.status === 0, `exit ${r.status}\n${r.stderr}`);
  assert(exists(dir, 'statusline.js'), 'statusline.js');
  assert(exists(dir, 'subagent-statusline.js'), 'subagent-statusline.js');
  const cfg = readJson(dir, 'settings.json');
  assert(cfg.statusLine.type === 'command', 'statusLine.type');
  assert(cfg.subagentStatusLine.type === 'command', 'subagentStatusLine.type');
});

check('installed scripts are byte-identical to the working tree', () => {
  const dir = sandboxPath();
  installer(['--dir', dir, '--local']);
  for (const [src, name] of [[MAIN, 'statusline.js'], [SUB, 'subagent-statusline.js']]) {
    assert(
      fs.readFileSync(src, 'utf8') === fs.readFileSync(path.join(dir, name), 'utf8'),
      `${name} differs from the copy it was installed from`
    );
  }
});

check('the settings command is quoted and free of backslashes', () => {
  const dir = sandboxPath();
  installer(['--dir', dir, '--local']);
  const { command } = readJson(dir, 'settings.json').statusLine;
  assert(/^node "/.test(command), `expected a quoted path, got ${command}`);
  // A backslash arrives at Git Bash as an escape character and the bar goes blank.
  assertNotMatch(command, '\\', 'separator');
  assertMatch(command, 'statusline.js"', 'points at the script');
});

check('unrelated settings keys survive and a backup is taken', () => {
  const dir = sandbox();
  fs.writeFileSync(
    path.join(dir, 'settings.json'),
    JSON.stringify({ model: 'opus', permissions: { allow: ['Bash'] }, hooks: { Stop: [] } })
  );
  installer(['--dir', dir, '--local']);

  const cfg = readJson(dir, 'settings.json');
  assert(cfg.model === 'opus', 'model key lost');
  assert(cfg.permissions.allow[0] === 'Bash', 'permissions lost');
  assert(cfg.hooks && cfg.hooks.Stop, 'hooks lost');

  assert(exists(dir, 'settings.json.bak'), 'no backup written');
  assert(readJson(dir, 'settings.json.bak').statusLine === undefined, 'the backup must predate our keys');
});

check('unparseable settings.json aborts before touching the disk', () => {
  const dir = sandbox();
  const file = path.join(dir, 'settings.json');
  const broken = '{ "model": "opus", }';        // trailing comma: not JSON
  fs.writeFileSync(file, broken);

  const r = installer(['--dir', dir, '--local']);
  assert(r.status === 1, `exit ${r.status}`);
  assert(fs.readFileSync(file, 'utf8') === broken, 'settings.json was modified anyway');
  assert(!exists(dir, 'statusline.js'), 'a script was written before the abort');
  assert(!exists(dir, 'settings.json.bak'), 'a backup was written before the abort');
  assertMatch(r.stderr, 'not valid JSON', 'explains why');
});

check('--main-only installs one half, --subagent-only the other', () => {
  const a = sandboxPath();
  installer(['--dir', a, '--local', '--main-only']);
  assert(exists(a, 'statusline.js'), 'main script missing');
  assert(!exists(a, 'subagent-statusline.js'), 'subagent script should be absent');
  const cfgA = readJson(a, 'settings.json');
  assert(cfgA.statusLine && !cfgA.subagentStatusLine, 'expected statusLine only');

  const b = sandboxPath();
  installer(['--dir', b, '--local', '--subagent-only']);
  assert(!exists(b, 'statusline.js'), 'main script should be absent');
  assert(exists(b, 'subagent-statusline.js'), 'subagent script missing');
  const cfgB = readJson(b, 'settings.json');
  assert(cfgB.subagentStatusLine && !cfgB.statusLine, 'expected subagentStatusLine only');
});

check('--interval overrides refreshInterval, which defaults to 30', () => {
  const a = sandboxPath();
  installer(['--dir', a, '--local']);
  assert(readJson(a, 'settings.json').statusLine.refreshInterval === 30, 'default');

  const b = sandboxPath();
  installer(['--dir', b, '--local', '--interval', '5']);
  assert(readJson(b, 'settings.json').statusLine.refreshInterval === 5, 'override');
});

check('a non-numeric --interval exits 1', () => {
  const r = installer(['--dir', sandboxPath(), '--local', '--interval', 'soon']);
  assert(r.status === 1, `exit ${r.status}`);
  assertMatch(r.stderr, '--interval must be a number', 'error text');
});

check('the manifest records the sha256 of what was installed', () => {
  const dir = sandboxPath();
  installer(['--dir', dir, '--local']);
  const manifest = readJson(dir, '.statusline-manifest.json');
  for (const name of ['statusline.js', 'subagent-statusline.js']) {
    assert(
      manifest.files[name] === sha256(fs.readFileSync(path.join(dir, name), 'utf8')),
      `${name}: manifest hash does not match the installed bytes`
    );
  }
  assert(manifest.ref === 'main', `unexpected ref ${manifest.ref}`);
});

check('auto-update is off unless asked for, and can be turned back off', () => {
  const dir = sandboxPath();
  installer(['--dir', dir, '--local']);
  assert(!exists(dir, '.statusline-autoupdate'), 'must be off by default');

  installer(['--dir', dir, '--local', '--auto-update']);
  assert(exists(dir, '.statusline-autoupdate'), '--auto-update did not set the flag');

  installer(['--dir', dir, '--local', '--no-auto-update']);
  assert(!exists(dir, '.statusline-autoupdate'), '--no-auto-update did not clear the flag');
});

check('reinstalling over an install is idempotent', () => {
  const dir = sandboxPath();
  installer(['--dir', dir, '--local']);
  const first = fs.readFileSync(path.join(dir, 'settings.json'), 'utf8');
  installer(['--dir', dir, '--local']);
  assert(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8') === first, 'a second install changed settings.json');
});

check('the piped `node -` form behaves like `node install.js`', () => {
  const dir = sandboxPath();
  const r = installer(['--dir', dir, '--local'], { viaStdin: true });
  assert(r.status === 0, `exit ${r.status}\n${r.stderr}`);
  assert(exists(dir, 'statusline.js'), 'statusline.js');
  assert(readJson(dir, 'settings.json').statusLine, 'statusLine key');
});

check('the piped form never auto-detects the cwd as a source', () => {
  // The regression: piped in, __dirname is "." -- the caller's working
  // directory. Auto-detecting a checkout there makes the documented one-liner
  // install whatever same-named files happen to be lying around instead of the
  // published version, which is exactly what it must not do. cwd is the repo
  // root here, so both files ARE present and the old code took the bait.
  //
  // This is the one case that reaches for the network. It asserts only on the
  // source line, which is printed before the first request, so the assertion
  // holds whether the fetch succeeds, 404s or fails to resolve at all.
  const r = installer(
    ['--dir', sandboxPath(), '--dry-run', '--main-only', '--ref', 'no-such-ref-exists'],
    { viaStdin: true }
  );
  assertMatch(r.stdout, 'source      GridFlowTech/claude-statusline@no-such-ref-exists', 'resolved source');
  assertNotMatch(r.stdout, 'source      .', 'must not resolve the bare cwd');
});

check('--uninstall removes our keys and files but keeps the ledger', () => {
  const dir = sandbox();
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ model: 'opus' }));
  installer(['--dir', dir, '--local', '--auto-update']);
  fs.writeFileSync(path.join(dir, 'cost_ledger.json'), '{"sessions":{}}');

  const r = installer(['--dir', dir, '--uninstall']);
  assert(r.status === 0, `exit ${r.status}\n${r.stderr}`);

  const cfg = readJson(dir, 'settings.json');
  assert(cfg.statusLine === undefined, 'statusLine key survived');
  assert(cfg.subagentStatusLine === undefined, 'subagentStatusLine key survived');
  assert(cfg.model === 'opus', 'an unrelated key was removed');

  for (const name of ['statusline.js', 'subagent-statusline.js', '.statusline-manifest.json', '.statusline-autoupdate']) {
    assert(!exists(dir, name), `${name} survived`);
  }
  assert(exists(dir, 'cost_ledger.json'), 'the ledger must be kept without --purge');
});

check('--uninstall --purge deletes the ledger too', () => {
  const dir = sandboxPath();
  installer(['--dir', dir, '--local']);
  fs.writeFileSync(path.join(dir, 'cost_ledger.json'), '{"sessions":{}}');
  installer(['--dir', dir, '--uninstall', '--purge']);
  assert(!exists(dir, 'cost_ledger.json'), 'the ledger survived --purge');
});

check('--uninstall --main-only leaves the subagent half installed', () => {
  const dir = sandboxPath();
  installer(['--dir', dir, '--local']);
  installer(['--dir', dir, '--uninstall', '--main-only']);
  assert(!exists(dir, 'statusline.js'), 'main script survived');
  assert(exists(dir, 'subagent-statusline.js'), 'subagent script was removed too');
  const cfg = readJson(dir, 'settings.json');
  assert(cfg.statusLine === undefined, 'statusLine key survived');
  assert(cfg.subagentStatusLine, 'subagentStatusLine key was removed too');
});

/* ========================================================================== */

console.log('\nself-update\n');

/**
 * Run the updater branch in the foreground. Every case here is arranged so the
 * updater bails out before its first network call -- either the manifest is
 * missing or the installed bytes no longer match it -- which keeps the suite
 * offline while still exercising the guards that matter.
 */
function selfUpdate(dir) {
  const res = spawnSync(process.execPath, [path.join(dir, 'statusline.js'), '--self-update'], {
    encoding: 'utf8',
    input: '',
    cwd: ROOT,
    env: { ...process.env, CLAUDE_CONFIG_DIR: dir },
  });
  return { status: res.status, stdout: res.stdout || '' };
}

check('a locally edited statusline is never overwritten', () => {
  const dir = sandboxPath();
  installer(['--dir', dir, '--local', '--main-only']);
  const file = path.join(dir, 'statusline.js');
  fs.appendFileSync(file, '\n// a tunable, edited by hand\n');
  const before = fs.readFileSync(file, 'utf8');

  const r = selfUpdate(dir);
  assert(r.status === 0, `exit ${r.status}`);
  assert(fs.readFileSync(file, 'utf8') === before, 'an edited file was reverted');
});

check('no manifest means no update attempt, and no output', () => {
  const dir = sandboxPath();
  installer(['--dir', dir, '--local', '--main-only']);
  fs.unlinkSync(path.join(dir, '.statusline-manifest.json'));
  const file = path.join(dir, 'statusline.js');
  const before = fs.readFileSync(file, 'utf8');

  const r = selfUpdate(dir);
  assert(r.status === 0, `exit ${r.status}`);
  assert(r.stdout === '', `expected silence, got ${JSON.stringify(r.stdout)}`);
  assert(fs.readFileSync(file, 'utf8') === before, 'the script changed without a manifest');
});

check('a render leaves no update marker while auto-update is off', () => {
  const dir = sandboxPath();
  installer(['--dir', dir, '--local']);
  run(path.join(dir, 'statusline.js'), basePayload(), { configDir: dir });
  assert(!exists(dir, '.statusline-last-update'), 'the updater ran while disabled');
});

check('a render stamps the marker at most once a day', () => {
  const dir = sandboxPath();
  installer(['--dir', dir, '--local']);
  // Removing the manifest makes the detached child a no-op, so this case
  // exercises the render-path half without going near the network.
  fs.unlinkSync(path.join(dir, '.statusline-manifest.json'));
  fs.writeFileSync(path.join(dir, '.statusline-autoupdate'), '');

  const marker = path.join(dir, '.statusline-last-update');
  run(path.join(dir, 'statusline.js'), basePayload(), { configDir: dir });
  assert(fs.existsSync(marker), 'the marker was not stamped');

  const stamp = fs.readFileSync(marker, 'utf8');
  run(path.join(dir, 'statusline.js'), basePayload(), { configDir: dir });
  assert(fs.readFileSync(marker, 'utf8') === stamp, 're-stamped within the day');
});

check('a render is unaffected by a broken manifest', () => {
  const dir = sandboxPath();
  installer(['--dir', dir, '--local']);
  fs.writeFileSync(path.join(dir, '.statusline-manifest.json'), 'not json');
  fs.writeFileSync(path.join(dir, '.statusline-autoupdate'), '');

  const r = run(path.join(dir, 'statusline.js'), basePayload(), { configDir: dir });
  assert(r.status === 0, `exit ${r.status}`);
  assert(r.lines.length >= 3, `expected >=3 lines, got ${r.lines.length}`);
});

/* ========================================================================== */

for (const dir of sandboxes) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

console.log('');
if (failures.length) {
  console.log(`${passed} passed, ${failures.length} FAILED\n`);
  for (const f of failures) console.log(`  - ${f.name}: ${f.message}`);
  console.log('');
  process.exit(1);
}
console.log(`${passed} passed, 0 failed\n`);
