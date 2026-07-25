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
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const MAIN = path.join(ROOT, 'statusline.js');
const SUB = path.join(ROOT, 'subagent-statusline.js');
const TRANSCRIPT = path.join(ROOT, 'examples', 'transcript.jsonl');

let sandboxCounter = 0;
const sandboxes = [];

/** A fresh config dir per run: no shared ledger state between cases. */
function sandbox() {
  const dir = path.join(os.tmpdir(), `cs-test-${process.pid}-${sandboxCounter++}`);
  fs.mkdirSync(dir, { recursive: true });
  sandboxes.push(dir);
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
  const r = run(MAIN, basePayload({ rate_limits: null }));
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
  assertNotMatch(r.stdout, 'LngCtx 101%', 'LngCtx must not include cumulative output');
});

check('exceeds_200k_tokens colours the LngCtx label red', () => {
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

check('a named agent adds the trailing row', () => {
  const r = run(MAIN, basePayload({ agent: { name: 'cavecrew-reviewer' } }));
  assertMatch(r.stdout, 'Subagent Active: cavecrew-reviewer', 'agent row');
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

check('ASCII mode replaces every non-ASCII glyph', () => {
  const r = run(MAIN, basePayload({
    rate_limits: { five_hour: window_(40, 18000, 0.5), seven_day: window_(10, 604800, 0.5) },
    workspace: { current_dir: ROOT, project_dir: ROOT },
  }), { env: { CC_STATUSLINE_ASCII: '1' } });
  for (const glyph of ['\u2191', '\u2192', '\u2193', '\u2387', '\u2713', '\u21e1', '\u21e3']) {
    assertNotMatch(r.stdout, glyph, `glyph ${escape(glyph)} should be suppressed`);
  }
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
  assert(!r.stdout.includes(esc), 'raw ESC reached stdout');
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
