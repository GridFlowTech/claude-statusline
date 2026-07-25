#!/usr/bin/env node
'use strict';
/* ============================================================================
 * claude-statusline installer
 * ----------------------------------------------------------------------------
 * ONE FILE, THREE ENTRY POINTS
 *   curl -fsSL <raw>/install.js | node -          remote, fetches from GitHub
 *   irm <raw>/install.js | node -                 same, PowerShell
 *   node install.js                               inside a clone, copies local
 *
 *   Which source is used depends on how the installer was started, not on what
 *   happens to be in the working directory: piped in, it always fetches. See
 *   resolveSource(). `--local` and `--remote` override either way.
 *
 * WHY NODE AND NOT install.sh + install.ps1
 *   Node >= 14.17 is already a hard requirement of the thing being installed,
 *   so a Node installer adds no new runtime and — unlike a shell pair — cannot
 *   drift between platforms. `node -` reads a script from stdin, which is what
 *   makes the piped one-liner work identically in bash, zsh and PowerShell.
 *
 * WHAT IT TOUCHES
 *   <config>/statusline.js              written (atomic rename)
 *   <config>/subagent-statusline.js     written (atomic rename)
 *   <config>/settings.json              statusLine + subagentStatusLine keys,
 *                                       backed up to settings.json.bak first,
 *                                       every other key preserved
 *   <config>/.statusline-manifest.json  sha256 of what we installed, so the
 *                                       auto-updater can detect local edits
 *   <config>/.statusline-autoupdate     flag file, only with --auto-update
 *
 *   <config> is $CLAUDE_CONFIG_DIR, else ~/.claude. Never anything outside it.
 *   The cost ledger is user data and is never written or deleted by default.
 *
 * SAFETY
 *   Nothing is installed until every file has been fetched AND passed
 *   `node --check`. A truncated download, an HTML error page or a 404 body
 *   fails the run before the first byte is written.
 * ========================================================================== */

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

/* ---------------------------------------------------------------------------
 * Constants
 * ------------------------------------------------------------------------ */

const REPO = 'GridFlowTech/claude-statusline';
const MAIN = 'statusline.js';
const SUB = 'subagent-statusline.js';

const MANIFEST = '.statusline-manifest.json';
const AUTOUPDATE_FLAG = '.statusline-autoupdate';
const UPDATE_MARKER = '.statusline-last-update';

// Minimum plausible size for either script. A 404 body, a Cloudflare interstitial
// or a truncated transfer all land far under this.
const MIN_BYTES = 4096;

// Ceiling on any single download. Both scripts are ~40 KB; a response in the
// megabytes is not this project and must not be buffered into memory.
const MAX_DOWNLOAD_BYTES = 5 * 1024 * 1024;

const NODE_MIN = [14, 17];

const rawUrl = (ref, name) =>
  `https://raw.githubusercontent.com/${REPO}/${encodeURIComponent(ref)}/${name}`;

/* ---------------------------------------------------------------------------
 * Argument parsing
 * ----------------------------------------------------------------------------
 * argv differs between `node install.js --x` (argv[1] is the path) and
 * `node - --x` (argv[1] is "-"), so rather than guess an offset we slice from
 * the first `--` token. Every flag starts with `--`; only their values do not.
 * ------------------------------------------------------------------------ */

function parseArgs(argv) {
  const first = argv.findIndex((a) => a.startsWith('--'));
  const tokens = first === -1 ? [] : argv.slice(first);

  const opts = {
    dir: null,
    ref: 'main',
    interval: 30,
    source: 'auto',      // auto | local | remote
    scope: 'both',       // both | main | subagent
    autoUpdate: false,
    dryRun: false,
    uninstall: false,
    purge: false,
    help: false,
  };

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const value = () => {
      const v = tokens[i + 1];
      if (v === undefined || v.startsWith('--')) die(`${t} needs a value`);
      i++;
      return v;
    };

    switch (t) {
      case '--dir': opts.dir = value(); break;
      case '--ref': opts.ref = value(); break;
      case '--interval': {
        const n = Number(value());
        if (!Number.isFinite(n) || n < 0) die('--interval must be a number of seconds');
        opts.interval = Math.round(n);
        break;
      }
      case '--local': opts.source = 'local'; break;
      case '--remote': opts.source = 'remote'; break;
      case '--main-only': opts.scope = 'main'; break;
      case '--subagent-only': opts.scope = 'subagent'; break;
      case '--auto-update': opts.autoUpdate = true; break;
      case '--no-auto-update': opts.autoUpdate = false; break;
      case '--dry-run': opts.dryRun = true; break;
      case '--uninstall': opts.uninstall = true; break;
      case '--purge': opts.purge = true; break;
      case '--help': case '-h': opts.help = true; break;
      default: die(`unknown option: ${t}\nRun with --help for the list.`);
    }
  }

  return opts;
}

const HELP = `
claude-statusline installer

  curl -fsSL https://raw.githubusercontent.com/${REPO}/main/install.js | node -
  irm https://raw.githubusercontent.com/${REPO}/main/install.js | node -
  node install.js                       (from a clone)

Options
  --dry-run           print every action, change nothing
  --auto-update       check GitHub for a newer statusline once a day (off by default)
  --no-auto-update    turn a previously enabled auto-update back off
  --main-only         install the status line, not the subagent panel
  --subagent-only     install the subagent panel, not the status line
  --interval <sec>    statusLine refreshInterval (default 30)
  --ref <branch|tag>  install from a specific ref (default main)
  --dir <path>        target config dir (default $CLAUDE_CONFIG_DIR or ~/.claude)
  --local | --remote  force copying from this checkout, or downloading
  --uninstall         remove the settings keys and the installed scripts
  --purge             with --uninstall, also delete cost_ledger.json (cost history)
  --help              this text
`.trim();

/* ---------------------------------------------------------------------------
 * Small helpers
 * ------------------------------------------------------------------------ */

function die(message) {
  process.stderr.write(`\ninstall failed: ${message}\n`);
  process.exit(1);
}

function say(message) {
  process.stdout.write(message + '\n');
}

/** Forward slashes, always: Git Bash eats backslashes in statusline commands. */
function posix(p) {
  return p.split(path.sep).join('/');
}

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function checkNode() {
  const [maj, min] = process.versions.node.split('.').map(Number);
  const [wantMaj, wantMin] = NODE_MIN;
  if (maj > wantMaj || (maj === wantMaj && min >= wantMin)) return;
  die(
    `Node ${wantMaj}.${wantMin} or newer is required, this is ${process.versions.node}.\n` +
    'The statusline itself has the same floor, so upgrading Node is the fix.'
  );
}

function configDir(opts) {
  if (opts.dir) return path.resolve(opts.dir);
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

function wantedFiles(opts) {
  if (opts.scope === 'main') return [MAIN];
  if (opts.scope === 'subagent') return [SUB];
  return [MAIN, SUB];
}

/* ---------------------------------------------------------------------------
 * Fetching
 * ------------------------------------------------------------------------ */

/** GET a URL as UTF-8 text. Follows redirects; rejects on any non-200. */
function get(url, redirects = 5) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { headers: { 'User-Agent': 'claude-statusline-installer', Accept: 'text/plain' } },
      (res) => {
        const { statusCode, headers } = res;

        if (statusCode >= 300 && statusCode < 400 && headers.location) {
          res.resume();
          if (redirects <= 0) return reject(new Error(`too many redirects for ${url}`));
          const next = new URL(headers.location, url).toString();
          // https only: a redirect must not downgrade the transport that the
          // whole install's integrity hangs on.
          if (!next.startsWith('https://')) return reject(new Error(`refusing insecure redirect for ${url}`));
          return resolve(get(next, redirects - 1));
        }

        if (statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${statusCode} for ${url}`));
        }

        const chunks = [];
        let total = 0;
        res.on('data', (c) => {
          total += c.length;
          if (total > MAX_DOWNLOAD_BYTES) {
            res.destroy();
            return reject(new Error(`response exceeded ${MAX_DOWNLOAD_BYTES} bytes for ${url}`));
          }
          chunks.push(c);
        });
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        res.on('error', reject);
      }
    );

    req.setTimeout(20000, () => req.destroy(new Error(`timed out fetching ${url}`)));
    req.on('error', reject);
  });
}

/**
 * True when this script is a real file on disk (`node install.js`), false when
 * it arrived on stdin (`curl … | node -`). Piped, Node reports `__filename` as
 * the literal string "[stdin]" and `__dirname` as ".".
 */
function ranAsFile() {
  return path.isAbsolute(__dirname) && fs.existsSync(__filename);
}

/**
 * Where to read the scripts from.
 *
 * Run as a file, `__dirname` is a checkout and copying from it is the whole
 * point of `node install.js`. Piped, there is no checkout: `__dirname` is only
 * the caller's working directory, and auto-detecting "local" there would
 * silently install whatever same-named files happen to be sitting in it —
 * a stale working tree, or someone else's script entirely. The documented
 * one-liner means "install the published version", so piped auto-detection
 * resolves remote and `--local` becomes the explicit opt-in.
 *
 * "Local" means every wanted file is present, not merely one of them.
 */
function resolveSource(opts) {
  if (opts.source === 'remote') return { mode: 'remote', dir: null };
  if (opts.source === 'auto' && !ranAsFile()) return { mode: 'remote', dir: null };

  // path.resolve() so an explicit --local while piped reports a real path
  // rather than the bare "." Node hands us.
  const here = path.resolve(__dirname);
  const allPresent = wantedFiles(opts).every((n) => {
    try { return fs.statSync(path.join(here, n)).isFile(); } catch { return false; }
  });

  if (allPresent) return { mode: 'local', dir: here };
  if (opts.source === 'local') die(`--local was given but ${wantedFiles(opts).join(' and ')} are not in ${here}`);
  return { mode: 'remote', dir: null };
}

async function loadFile(name, src, opts) {
  if (src.mode === 'local') return fs.readFileSync(path.join(src.dir, name), 'utf8');
  return get(rawUrl(opts.ref, name));
}

/* ---------------------------------------------------------------------------
 * Validation
 * ----------------------------------------------------------------------------
 * Three gates, cheapest first. The last one is the real one: `node --check`
 * parses the file exactly as Node will at render time, which catches a
 * half-transferred body that still happens to start with a shebang.
 * ------------------------------------------------------------------------ */

function validate(name, content, targetDir) {
  // Byte length, not string length: both scripts are full of multi-byte glyphs
  // (· ⎇ ↑), so `content.length` counts characters and under-reports the file
  // by ~30 bytes. Small enough not to matter to the threshold, big enough to
  // make the number printed next to it wrong.
  const bytes = content ? Buffer.byteLength(content, 'utf8') : 0;
  if (bytes < MIN_BYTES) {
    die(`${name} came back as ${bytes} bytes — too small to be real. Nothing was written.`);
  }
  if (!content.startsWith('#!/usr/bin/env node')) {
    die(`${name} does not start with the expected shebang — refusing to install it. Nothing was written.`);
  }

  // The `.js` suffix is load-bearing: Node 20+ resolves a module format from the
  // extension before parsing, and `node --check foo.12345` dies on the extension
  // rather than on the syntax it was asked about.
  // Random suffix, not the pid: a dry run verifies in the shared OS temp dir,
  // where a predictable name could be pre-planted as a symlink by another user.
  const tmp = path.join(targetDir, `.${name}.verify.${crypto.randomBytes(6).toString('hex')}.js`);
  try {
    fs.writeFileSync(tmp, content, 'utf8');
    const res = spawnSync(process.execPath, ['--check', tmp], { encoding: 'utf8', windowsHide: true });
    if (res.status !== 0) {
      die(`${name} failed \`node --check\`:\n${(res.stderr || '').trim()}\nNothing was written.`);
    }
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* best effort */ }
  }
}

/* ---------------------------------------------------------------------------
 * Writing
 * ------------------------------------------------------------------------ */

/** Write via temp file + rename so a killed installer cannot leave a half file. */
function writeAtomic(dest, content) {
  const tmp = `${dest}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, dest);
}

function readSettings(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return {};                       // no settings.json yet: we create it
  }
  if (!raw.trim()) return {};

  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    die(`${file} is valid JSON but not an object. Refusing to overwrite it.`);
  } catch (err) {
    // Deliberately not "repaired". Overwriting a settings file we could not
    // parse would destroy hooks, permissions and MCP servers.
    die(
      `${file} is not valid JSON (${err.message}).\n` +
      'Refusing to touch it. Fix the syntax and re-run, or add these keys by hand:\n\n' +
      '  "statusLine": { "type": "command", "command": "node \\"~/.claude/statusline.js\\"", "refreshInterval": 30 },\n' +
      '  "subagentStatusLine": { "type": "command", "command": "node \\"~/.claude/subagent-statusline.js\\"" }'
    );
  }
}

/* ---------------------------------------------------------------------------
 * Install
 * ------------------------------------------------------------------------ */

async function install(opts) {
  const dir = configDir(opts);
  const src = resolveSource(opts);
  const files = wantedFiles(opts);
  const tag = opts.dryRun ? '[dry-run] ' : '';

  say(`\nclaude-statusline installer`);
  say(`  config dir  ${posix(dir)}`);
  say(`  source      ${src.mode === 'local' ? posix(src.dir) : `${REPO}@${opts.ref}`}`);
  say(`  installing  ${files.join(', ')}`);
  say(`  auto-update ${opts.autoUpdate ? 'on (daily)' : 'off'}\n`);

  // Parse settings.json BEFORE anything is fetched or written. If it is not
  // valid JSON this run is going to abort, and it should abort having left the
  // disk exactly as it found it.
  const settingsFile = path.join(dir, 'settings.json');
  const cfg = readSettings(settingsFile);

  if (!opts.dryRun) fs.mkdirSync(dir, { recursive: true });

  // Fetch and verify everything before writing anything.
  const loaded = {};
  for (const name of files) {
    say(`${tag}fetch    ${name}`);
    try {
      loaded[name] = await loadFile(name, src, opts);
    } catch (err) {
      die(`${err.message}\nNothing was written.`);
    }
  }

  // `node --check` needs somewhere to put its temp file; in a dry run the
  // config dir may not exist yet, so verify in the OS temp dir instead.
  const verifyDir = opts.dryRun && !fs.existsSync(dir) ? os.tmpdir() : dir;
  if (!opts.dryRun || fs.existsSync(verifyDir)) {
    for (const name of files) {
      validate(name, loaded[name], verifyDir);
      say(`${tag}verified ${name}  (${Buffer.byteLength(loaded[name], 'utf8')} bytes, node --check ok)`);
    }
  }

  // Files.
  const manifest = { repo: REPO, ref: opts.ref, installedAt: new Date().toISOString(), files: {} };
  for (const name of files) {
    const dest = path.join(dir, name);
    manifest.files[name] = sha256(loaded[name]);
    if (!opts.dryRun) writeAtomic(dest, loaded[name]);
    say(`${tag}wrote    ${posix(dest)}`);
  }

  // settings.json. Already parsed and validated above.
  if (fs.existsSync(settingsFile) && !opts.dryRun) {
    fs.copyFileSync(settingsFile, settingsFile + '.bak');
    say(`${tag}backup   ${posix(settingsFile)}.bak`);
  }

  const cmd = (name) => `node "${posix(path.join(dir, name))}"`;
  if (files.includes(MAIN)) {
    cfg.statusLine = { type: 'command', command: cmd(MAIN), refreshInterval: opts.interval };
    say(`${tag}set      statusLine -> ${cfg.statusLine.command}`);
  }
  if (files.includes(SUB)) {
    cfg.subagentStatusLine = { type: 'command', command: cmd(SUB) };
    say(`${tag}set      subagentStatusLine -> ${cfg.subagentStatusLine.command}`);
  }

  if (!opts.dryRun) {
    writeAtomic(settingsFile, JSON.stringify(cfg, null, 2) + '\n');
    // The manifest records what a clean install looks like. The auto-updater
    // compares against it and stands down if you have edited a file since.
    writeAtomic(path.join(dir, MANIFEST), JSON.stringify(manifest, null, 2) + '\n');
  }

  // Auto-update flag.
  const flag = path.join(dir, AUTOUPDATE_FLAG);
  if (opts.autoUpdate) {
    if (!opts.dryRun) writeAtomic(flag, `${manifest.installedAt}\n`);
    say(`${tag}enabled  daily auto-update (${AUTOUPDATE_FLAG})`);
  } else if (fs.existsSync(flag)) {
    if (!opts.dryRun) { try { fs.unlinkSync(flag); } catch { /* best effort */ } }
    say(`${tag}disabled auto-update`);
  }

  say(
    opts.dryRun
      ? '\nDry run. Nothing changed. Drop --dry-run to apply.\n'
      : '\nDone. The bar appears on the next assistant message — no restart needed.\n' +
        'Verify with:  node ' + posix(path.join(dir, MAIN)) + ' < examples/payload.json\n'
  );
}

/* ---------------------------------------------------------------------------
 * Uninstall
 * ------------------------------------------------------------------------ */

function uninstall(opts) {
  const dir = configDir(opts);
  const files = wantedFiles(opts);
  const tag = opts.dryRun ? '[dry-run] ' : '';

  say(`\nclaude-statusline uninstall`);
  say(`  config dir  ${posix(dir)}\n`);

  const settingsFile = path.join(dir, 'settings.json');
  if (fs.existsSync(settingsFile)) {
    const cfg = readSettings(settingsFile);
    if (!opts.dryRun) {
      fs.copyFileSync(settingsFile, settingsFile + '.bak');
      say(`${tag}backup   ${posix(settingsFile)}.bak`);
    }
    if (files.includes(MAIN)) { delete cfg.statusLine; say(`${tag}removed  statusLine key`); }
    if (files.includes(SUB)) { delete cfg.subagentStatusLine; say(`${tag}removed  subagentStatusLine key`); }
    if (!opts.dryRun) writeAtomic(settingsFile, JSON.stringify(cfg, null, 2) + '\n');
  }

  // Markers only go when the whole thing goes.
  const extras = opts.scope === 'both' ? [MANIFEST, AUTOUPDATE_FLAG, UPDATE_MARKER] : [];
  // cost_ledger.json is your cost history, not our file. --purge only.
  const ledger = opts.purge ? ['cost_ledger.json'] : [];

  for (const name of [...files, ...extras, ...ledger]) {
    const target = path.join(dir, name);
    if (!fs.existsSync(target)) continue;
    if (!opts.dryRun) { try { fs.unlinkSync(target); } catch { continue; } }
    say(`${tag}deleted  ${posix(target)}`);
  }

  if (!opts.purge && fs.existsSync(path.join(dir, 'cost_ledger.json'))) {
    say(`${tag}kept     cost_ledger.json (your cost history — --purge deletes it)`);
  }

  say(opts.dryRun ? '\nDry run. Nothing changed.\n' : '\nDone.\n');
}

/* ---------------------------------------------------------------------------
 * Main
 * ------------------------------------------------------------------------ */

async function main() {
  const opts = parseArgs(process.argv);
  if (opts.help) { say(HELP); return; }
  checkNode();
  if (opts.uninstall) uninstall(opts);
  else await install(opts);
}

main().catch((err) => die(err && err.stack ? err.stack : String(err)));
