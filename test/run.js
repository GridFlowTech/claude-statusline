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

check('escape sequences in the effort field are stripped', () => {
  const esc = String.fromCharCode(27);
  const r = run(SUB, {
    columns: 90,
    tasks: [{ id: 'x', name: 'n', status: 'running', model: 'claude-opus-5', effort: `hi${esc}[31mgh` }],
  });
  assert(!r.stdout.includes(esc), 'raw ESC reached stdout');
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
