# Claude Code Statusline

A Node.js statusline for Claude Code. Renders model identity, context runway,
rate-limit pace, a persistent multi-window cost ledger, and repo and git state
in four lines. Runs on Windows, macOS and Linux from the same files.

![Four rendered examples. An everyday session on a Pro or Max subscription, with both rate-limit windows cool and one untracked file in the tree. A billed plan (API key, Bedrock, Vertex, Enterprise) where the windows give way to a spend gauge against a $750 monthly allocation and the blended cost per million tokens. The companion subagent statusline, with one row per visible teammate below the prompt. And every field rendered at once: model identity with the 1M-context, effort, thinking, fast and plugin tags; context, cache, long-context and both rate-limit windows with pace arrows; the four cost windows with burn rate and API share; repo, branch, working-tree and worktree state; and the session agent](assets/statusline-overview.png)

|           |                                                                                                                                            |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Install   | One piped command - see [Installation](#installation)                                                                                      |
| Scripts   | `~/.claude/statusline.js` (2124 lines) · `~/.claude/subagent-statusline.js` (336 lines)                                                    |
| Ledger    | `~/.claude/cost_ledger.json` (created on first run)                                                                                        |
| Config    | `statusLine` and `subagentStatusLine` blocks in `~/.claude/settings.json`                                                                  |
| Runtime   | Node.js ≥ 14.17 - built-ins only (`fs`, `path`, `os`, `child_process`; `https`/`crypto` lazily, in the optional updater). No dependencies. |
| Platforms | Windows, macOS, Linux                                                                                                                      |
| Cost      | ~120 ms for a render that respawns git, ~65 ms for one served from the git cache, ~63 ms outside a repo. ~66 ms for the subagent panel. No API tokens. |
| Licence   | MIT                                                                                                                                        |

---

## What's in this repo

```text
statusline.js             the status line above the footer
subagent-statusline.js    one row per subagent in the agent panel
install.js                installer, updater and uninstaller in one file
examples/                 mock payloads, plus a transcript that proves the dedup
test/run.js               99 assertions, no framework
```

---

## Platform support

All three files are plain Node with no native modules, no shell invocation, and
no platform-specific file layout. The entire platform-conditional surface is
these two lines:

| Location                                                | What it does elsewhere                                                                                                                  |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `process.platform === 'win32'` guard around `%APPDATA%` | Skipped; plugin config resolves via `$XDG_CONFIG_HOME` then `~/.config/<plugin>/`, which is where the plugins put it on macOS and Linux |
| `windowsHide: true` on the spawns                       | Ignored by POSIX                                                                                                                        |

The installer is the same story: `node -` reads a script from stdin identically
in bash, zsh and PowerShell, which is the whole reason it is one file and not a
`.sh`/`.ps1` pair.

Everything else - `os.homedir()`, `path.join`, the `git` lookup, atomic rename,
detached background spawn, the transcript byte offsets - behaves identically.
`fs.readSync(0, …)` with `EAGAIN` retry matters _more_ on POSIX, where a
non-blocking stdin pipe is the common case.

The Node floor is 14.17, set by `fs.statSync(…, { throwIfNoEntry: false })`.
Nothing else in either file is newer.

Two honest caveats:

- **The timings above were measured on Windows.** Process spawn is cheaper on
  macOS and Linux, so the git-enabled figure should come in lower there. The
  non-git path is dominated by Node startup and will be similar.
- **These scripts have been executed and regression-tested on Windows only.**
  Nothing in them is Windows-dependent, but that is an audit result, not a test
  result.

---

## Installation

One command. Node ≥ 14.17 is the only prerequisite, and it is one you already
have if the statusline is going to run at all.

### macOS · Linux · WSL · Git Bash

```bash
curl -fsSL https://raw.githubusercontent.com/GridFlowTech/claude-statusline/main/install.js | node -
```

### Windows PowerShell

```powershell
irm https://raw.githubusercontent.com/GridFlowTech/claude-statusline/main/install.js | node -
```

### From a clone

```bash
git clone https://github.com/GridFlowTech/claude-statusline
cd claude-statusline
node install.js
```

All three run the same `install.js`. Copying the two scripts into
`$CLAUDE_CONFIG_DIR` (or `~/.claude`), adding `statusLine` and
`subagentStatusLine` to `settings.json`, and backing that file up first are all
part of the one command - there are no manual steps left.

They differ in one respect, and it is decided by how the installer was started
rather than by what is in your working directory:

- **Piped** - always downloads the published scripts. It does this even if you
  happen to be standing in a checkout, because the one-liner means "install the
  published version", and quietly picking up a stale working tree instead would
  be a nasty surprise.
- **`node install.js`** - installs the checkout it lives in.

`--local` and `--remote` override either way.

The bar appears on the next assistant message. No restart.

### Why one Node file and not `install.sh` + `install.ps1`

`node -` reads a script from stdin, so the same file is both the piped one-liner
and the local installer, in every shell, on every platform. A shell pair would
be two implementations of one contract that drift the moment only one of them
gets a fix. And the runtime is free: Node is already a hard requirement.

### Options

```text
--dry-run           print every action, change nothing
--auto-update       check GitHub for a newer statusline once a day (off by default)
--no-auto-update    turn a previously enabled auto-update back off
--usage             read the server's own per-model weekly limit from the
                    Claude OAuth usage endpoint (off by default). Costs no
                    tokens; refreshes in the background about once a minute.
                    On macOS the first refresh raises one Keychain prompt --
                    answer "Always Allow" and it never returns.
--no-usage          turn the usage endpoint back off and delete its cache
--main-only         install the status line, not the subagent panel
--subagent-only     install the subagent panel, not the status line
--interval <sec>    statusLine refreshInterval (default 30)
--ref <branch|tag>  install from a specific ref (default main)
--dir <path>        target config dir (default $CLAUDE_CONFIG_DIR or ~/.claude)
--local | --remote  force copying from this checkout, or downloading
--uninstall         remove the settings keys and the installed scripts
--purge             with --uninstall, also delete cost_ledger.json
--help              the list above
```

Flags pass through the pipe. Read before you run:

```bash
curl -fsSL https://raw.githubusercontent.com/GridFlowTech/claude-statusline/main/install.js | node - --dry-run
```

The two halves are independent - `--main-only` and `--subagent-only` install
either without the other. See
[Subagent status lines](#subagent-status-lines-a-separate-feature).

### What it writes

| Path                                 | What                                                                |
| ------------------------------------ | ------------------------------------------------------------------- |
| `<config>/statusline.js`             | the status line, written by atomic rename                           |
| `<config>/subagent-statusline.js`    | the subagent panel, same                                            |
| `<config>/settings.json`             | `statusLine` + `subagentStatusLine` keys; every other key preserved |
| `<config>/settings.json.bak`         | copy of your settings taken before the write                        |
| `<config>/.statusline-manifest.json` | sha256 of what was installed, for the update edit-check             |
| `<config>/.statusline-autoupdate`    | flag file, only with `--auto-update`                                |
| `<config>/.statusline-usage`         | flag file, only with `--usage`                                      |

`<config>` is `$CLAUDE_CONFIG_DIR` if set, else `~/.claude`. Nothing outside it
is ever touched, and `cost_ledger.json` is never written or deleted by the
installer.

Nothing is installed until **every** file has been fetched _and_ has passed
`node --check`. A truncated transfer, a captive-portal login page or a 404 body
fails the run before the first byte is written. The `node --check` gate is the
one that matters: it parses each file exactly as Node will at render time.

If `settings.json` is not valid JSON, the installer refuses to touch it and
prints the two keys to add by hand. Overwriting a settings file it could not
parse would destroy your hooks, permissions and MCP servers.

### Windows path caveat

The installer handles this; it is documented because it explains the shape of
what lands in `settings.json`, and it still applies if you hand-edit.

On Windows, Claude Code routes statusline commands **through Git Bash when Git
Bash is installed**, and through PowerShell only when it is absent.

- **Forward slashes** (`C:/Users/you/.claude/statusline.js`) or `~`. Git Bash
  treats unquoted backslashes as escape characters, so a path written
  `C:\Users\you\.claude\statusline.js` arrives with its separators stripped and
  the command fails with no visible error - the bar just goes blank. The
  installer always writes forward slashes.
- **Never `%USERPROFILE%`.** cmd-style variables are not expanded by Git Bash.
  On macOS and Linux, `$HOME` has the same problem in reverse; `~` works
  everywhere.

No `chmod` is needed on any platform: the scripts are invoked as `node <path>`,
not executed directly, so the shebang and the executable bit are never used.

### By hand

Still two files and one key, if you would rather. Copy `statusline.js` and
`subagent-statusline.js` into `~/.claude/`, then add:

```json
{
  "statusLine": {
    "type": "command",
    "command": "node \"~/.claude/statusline.js\"",
    "refreshInterval": 30
  },
  "subagentStatusLine": {
    "type": "command",
    "command": "node \"~/.claude/subagent-statusline.js\""
  }
}
```

`~` is expanded by Claude Code on every platform, including Windows. A manual
install has no manifest, so [auto-update](#auto-update) stays off for it.

---

## Uninstall

Same one-liner, one flag:

```bash
curl -fsSL https://raw.githubusercontent.com/GridFlowTech/claude-statusline/main/install.js | node - --uninstall
```

```powershell
irm https://raw.githubusercontent.com/GridFlowTech/claude-statusline/main/install.js | node - --uninstall
```

It removes both settings keys, both scripts, and the manifest, flag and marker
files for [auto-update](#auto-update) and the [usage endpoint](#usage-endpoint) -
including the cached usage snapshot - backing `settings.json` up first and
leaving every other key alone.

**`cost_ledger.json` is kept.** It is your cost history, not part of the
install, and a reinstall picks up exactly where you left off. Add `--purge` to
delete it too - that is not reversible.

`--main-only` and `--subagent-only` work here as well, if you want to remove one
half and keep the other.

Inside Claude Code, `/statusline delete` removes the `statusLine` key for you,
but it does not touch `subagentStatusLine` or delete any files.

---

## Auto-update

**Off by default.** Turn it on at install time:

```bash
curl -fsSL https://raw.githubusercontent.com/GridFlowTech/claude-statusline/main/install.js | node - --auto-update
```

Off by default because the honest description of the feature is _this machine
runs code downloaded from GitHub on a schedule, without asking_. That is a
reasonable trade for a statusline you want to keep current, and a bad default to
impose on someone who did not ask for it. `--no-auto-update` turns it back off;
so does deleting `~/.claude/.statusline-autoupdate`.

When it is off, the whole feature costs one `statSync` per render.

When it is on, the render path still does no network I/O. It checks the age of a
marker file and, at most once a day, spawns a **detached** child that outlives
the render - the bar is already printed by the time the child does anything. The
child then refuses to install anything that is not, in order:

1. listed in the manifest written at install time,
2. byte-identical to what that install put on disk,
3. over 4 KB and starting with the expected shebang,
4. parseable by `node --check`.

Only then does it rename the new file into place, atomically.

Step 2 is the one worth knowing about: **if you have edited your copy, the
updater leaves it alone, permanently.** The tunables at the top of
`statusline.js` are meant to be edited, and an updater that silently reverted
them would be a bug. To get back on the update track after editing, re-run the
installer.

`--ref v1.2` pins an install to a tag, and the updater follows that same ref
rather than jumping to `main`.

To update once, by hand, without ever enabling the daily check - re-run the
installer. It is the same command as a fresh install.

### `refreshInterval`

Statusline updates are event-driven, and the events go quiet exactly when you
want the bar most - while background subagents run and the main session sits
idle. `refreshInterval: 30` re-runs the command every 30 s so rate-limit
percentages, projected-exhaustion times, and time-until-reset stay current.
Minimum is `1`; omit the field for event-only updates.

### Verify

Run the script directly with a mock payload - this works on any platform and
needs no editor:

```bash
echo "{\"model\":{\"display_name\":\"Opus\"},\"context_window\":{\"used_percentage\":25}}" | node ~/.claude/statusline.js
```

Then confirm it is live inside Claude Code:

```bash
node -e "console.log(require(require('os').homedir()+'/.claude/cost_ledger.json'))"
```

If the ledger exists and contains your current session id, the statusline is
running. Settings reload automatically, but a change only appears on the next
render trigger.

---

## Layout reference

Cells are separated by `·`. Any cell whose underlying data is absent is
omitted entirely rather than rendered empty, and a line that produces nothing at
all is dropped rather than printed blank.

### Line 1 - identity and modes

```text
Opus 5 (1M context) XHigh Thinking [FAST] [CAVEMAN:ULTRA] [PONYTAIL:ULTRA]
```

| Cell           | Source                                          | Notes                                                                                                                                                                            |
| -------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Model          | `model.display_name`                            | Bold. Falls back to `Claude`.                                                                                                                                                    |
| `(1M context)` | `context_window.context_window_size == 1000000` | **Suppressed when `display_name` already says `1M`**, so `Opus 5 (1M context)` never doubles up. Placed before effort so a synthesised tag lands where Opus's baked-in one does. |
| Effort         | `effort.level`                                  | Capitalised; `xhigh` renders `XHigh`. Absent on models without an effort parameter.                                                                                              |
| `Thinking`     | `thinking.enabled === true`                     |                                                                                                                                                                                  |
| `[FAST]`       | `fast_mode === true`                            | Fast mode changes throughput and therefore rate-limit burn.                                                                                                                      |
| `[CAVEMAN:x]`  | plugin state                                    | See [Plugin mode detection](#plugin-mode-detection).                                                                                                                             |
| `[PONYTAIL:x]` | plugin state                                    |                                                                                                                                                                                  |

### Line 2 - runway

```text
Ctx 15% · In 152,002 Out 153,470 · Cache 98% · LngCtx 76% · 5h 90%:20%↑ 02:41:4h · 7d 52%:50%→ 08:06:3d
```

| Cell        | Source                              | Notes                                                                  |
| ----------- | ----------------------------------- | ---------------------------------------------------------------------- |
| `Ctx n%`    | `context_window.used_percentage`    | Green < 70, yellow ≥ 70, red ≥ 90. `0%` before the first response, `↺` in the gap after `/compact`. |
| `In`        | `context_window.total_input_tokens` | Tokens currently in the window. `↺` while the post-`/compact` size is unknown. |
| `Out`       | **transcript**                      | Session-cumulative output. Not available from the payload - see below. |
| `Cache n%`  | **transcript**                      | Session-cumulative hit rate. Inverted colour scale - high is good.     |
| `LngCtx n%` | computed, `exceeds_200k_tokens`     | Progress toward the fixed 200k threshold. Extended windows only.       |
| `5h`        | `rate_limits.five_hour`             | Threshold-coloured. Subscription plans only.                           |
| `7d`        | `rate_limits.seven_day`             | Subscription plans only.                                               |
| `Bgt`       | ledger + `CC_STATUSLINE_BUDGET`     | Billed plans only, and only with a budget set. See below.              |
| `$/Mtok`    | `cost` + **transcript**             | Billed plans only, and only with a readable transcript.                |
| `Fable n%`  | [usage endpoint](#usage-endpoint)   | Share of the Fable allowance spent, straight from the server. Trails the line. See below. |
| `Fable ~n%` | ledger + `rate_limits.seven_day`    | The same figure *estimated* locally, when the server's is unavailable. The tilde is the difference. Only while Fable is the active model. |

Context and rate limits share one line because they answer the same question -
how much runway is left - and because merging them lets the width budget be
allocated across all of it at once.

The constraint slots hold whichever pair is real. `rate_limits` is sent only to
Claude.ai subscribers, so on an API key, Bedrock, Vertex or Enterprise
deployment the windows are replaced by the budget gauge and the blended token
rate rather than sitting there reading `n/a` forever:

```text
Ctx 76% · In 152,002 Out 153,470 · Cache 98% · Bgt $24.36/250:11h · $/Mtok 12.83
```

That one is a 200k model, which is also why `LngCtx` is absent - see
[LngCtx](#lngctx).

`Fable` trails the constraint pair rather than sitting beside `LngCtx`, so all
three limit gauges read left to right as one group:

```text
Ctx 15% · In 152,002 Out 878 · Cache 92% · 5h 6%:34%↓:3h · 7d 41%:50%↓:3d · Fable 82%
```

### Line 3 - money

```text
S $4.87 · D $24.14 · W $88.02 · M $412.60 · $19.48/hr · API 25%
```

| Cell     | Meaning                                            |
| -------- | -------------------------------------------------- |
| `S`      | This session. Straight from `cost.total_cost_usd`. |
| `D`      | Today.                                             |
| `W`      | Last 7 days (today plus the previous 6).           |
| `M`      | Current calendar month.                            |
| `$n/hr`  | Burn rate - see below.                             |
| `API n%` | Share of wall-clock time spent waiting on the API. |

`D`, `W`, and `M` come from the local ledger, not the payload.

### Line 4 - place

```text
my-project · ⎇ main +2 ~1 ?3 ⇡1 ⇣2 · [feature-xyz] · statusline-hardening
```

| Cell           | Source                   | Notes                                                                                                                                                             |
| -------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repo           | `workspace.repo.name`    | Parsed host-side from the `origin` remote, so it costs nothing. Falls back to the basename of `workspace.project_dir`.                                            |
| Branch + state | `git status`             | See [Git state](#git-state).                                                                                                                                      |
| `[worktree]`   | `workspace.git_worktree` | Magenta. Present for **any** linked worktree made with `git worktree add`, absent in the main working tree - so it only appears when it is telling you something. |
| Session name   | `session_name`           | Dim, **unclipped**. Absent unless set via `--name`, `/rename`, or an AI-generated title - the default `my-app-3f` style name does **not** populate this field.    |

The worktree cell deliberately reads `workspace.git_worktree` and **not**
`worktree.name`. The latter is populated only for `--worktree` sessions and
would silently miss a worktree you created by hand - which is the case where
you most want the reminder. It also outranks the session name for truncation:
which worktree you are in changes what your edits affect.

Outside a git repo the branch cell disappears and the repo cell falls back to
the directory name. With no repo, no directory and no session name, the entire
line is dropped rather than printed blank.

### Line 5 - named agent (conditional)

```text
Session Agent: cavecrew-reviewer
```

Rendered only when `agent.name` is present.

**This is not a Task-tool subagent.** `agent.name` is the _session's own_ agent
identity - set by the `--agent` flag or by agent settings - so this row means
"this whole session is running as a named agent", not "a subagent is currently
working". Rows for individual subagents are a completely separate feature; see
[Subagent status lines](#subagent-status-lines-a-separate-feature).

---

## Git state

```text
⎇ main +2 ~1 ?3 ⇡1 ⇣2
⎇ main ✓
⎇ detached ✓
```

| Symbol      | Colour    | Meaning                       |
| ----------- | --------- | ----------------------------- |
| `⎇`         | dim       | Branch prefix                 |
| branch name | magenta   | Current branch, or `detached` |
| `✓`         | dim green | Working tree clean            |
| `+N`        | green     | Staged                        |
| `~N`        | yellow    | Modified but unstaged         |
| `?N`        | dim       | Untracked                     |
| `⇡N`        | orange    | Commits not yet pushed        |
| `⇣N`        | cyan      | Commits available to pull     |

`✓` and the `+N ~N ?N` group are mutually exclusive. Any counter at zero is
omitted.

### One subprocess, not four

The reference bash implementation shells out four times per render:
`symbolic-ref` for the branch, `status --porcelain` for dirty state, and two
`rev-list --count` calls for ahead and behind. Each process spawn costs 30–60 ms
on Windows - cheaper on macOS and Linux, but never free - so four of them would
treble the render budget on their own.

`git status --porcelain=v1 --branch` returns all four answers in **one**
process. Its header line carries the branch and the tracking gap:

```text
## main...origin/main [ahead 1, behind 2]
```

and the body carries every file's `XY` status, from which staged / modified /
untracked are counted directly.

The repo root - needed for the fetch lock - is found by walking up for `.git` in
pure JS rather than spending a fifth process on `rev-parse --show-toplevel`.
This handles linked worktrees too, where `.git` is a file rather than a
directory.

A hung git (network filesystem, `index.lock` contention) is killed at an 800 ms
`spawnSync` timeout and the branch cell simply disappears for that render.

Header forms handled: normal, `[gone]` upstream, no upstream, `HEAD (no
branch)`, and `No commits yet on <branch>`. Branch names may legally contain
dots, so the `...upstream` split takes the **last** occurrence.

### One subprocess per 3 s, not one per render

One spawn is still one spawn, and Claude Code re-renders on every assistant
message, permission-mode change and vim-mode toggle - debounced at 300 ms, so a
busy turn fires renders roughly ten times a second against a working tree that
has not moved. The result is cached for **3 s** (`GIT_CACHE_MS`), which takes a
warm render down to what it costs with git disabled entirely:

| Render                          | Median  |
| ------------------------------- | ------- |
| Cold, or a cache older than 3 s | ~120 ms |
| Served from the cache           | ~65 ms  |
| `CC_STATUSLINE_NOGIT=1`         | ~63 ms  |

The cache lives in the **session's own ledger record**, not in a temp file of
its own. That record is already read once and written at most once per render,
so this adds no file I/O at all - and it is keyed by `session_id`, the only
identifier that is both stable across the renders of one session and distinct
between concurrent sessions in different repositories. `process.pid` changes on
every render and would defeat the cache entirely.

Four fields carry it: `gDir` (the directory the answer describes), `gTs` (when
it was taken), `gSt` (the parsed status) and `gRoot` (the repo root, which
otherwise costs an `existsSync` walk of up to 64 levels on every render for the
sake of a fetch check that fires once per 600 s).

An entry is discarded when the directory changed, when it is older than 3 s, or
when its timestamp is in the **future** - a clock stepping backwards (NTP
correction, VM resume) must not pin the cache until real time catches up.

`null` is cached exactly as eagerly as a hit: outside a repo, or with `git`
missing from `PATH`, the answer still cost a full spawn to establish.

The one cost is that a refresh marks the ledger record dirty, so the ledger is
now written at most once per 3 s rather than only when a cost figure moves.

### Background fetch

Ahead/behind counts are only as fresh as the last `git fetch`. The script kicks
off a detached `git fetch --quiet --prune` so the numbers keep meaning
something, under two deliberate restrictions carried over from the reference:

- **Opt-in per repo.** Only repos containing a `local/` directory are fetched.
- **Debounced to 600 s per branch**, tracked in `<repo>/local/.fetch-lock` as
  TSV (`<branch>\t<epoch seconds>`).

The timestamp is stamped **before** the spawn, so a fetch that fails still
debounces - otherwise a broken remote means a fetch attempt on every single
render. The child is detached and `unref`'d, so this process exits immediately
regardless of how long the fetch takes.

Set `CC_STATUSLINE_NOGIT=1` to skip all of this. With the cache in place that
now only reclaims the ~57 ms of a refresh render, not of every render - and it
costs you the branch cell permanently.

---

## The math

### Rate limits

```text
5h 90%:20%↑ 02:41:4h
   |   |  |     |  `- time until this window resets
   |   |  `- projected exhaustion clock
   |   `- on_pace%
   `- used%
```

**used%** is `rate_limits.<window>.used_percentage`, rounded.

**on_pace%** is what the meter _would_ read right now for a perfectly linear
burn that lands exactly on 100% at reset:

```text
on_pace% = elapsed / duration * 100
```

Reading the two numbers side by side is the whole point. `90%:20%` means you
have consumed 90% of the window's budget in the first 20% of its time.

**time until reset** uses days above 48 h, hours above 99 min, minutes below
that. The reference caps at hours, which renders a fresh 7-day window as `142h`.

**Colours:** the 5-hour `used%` is threshold-coloured (red ≥ 80, yellow ≥ 50,
cyan below); the 7-day cell is flat cyan. Both match the reference.

on_pace% and the arrow are suppressed together during the opening 2% of a
window - showing half the trio would read as a bug.

### Pace arrows

Both the `5h` and `7d` cells carry a pace arrow. It answers one question:
**at the current burn rate, will this window run out before it resets?**

The arrow is not a restatement of `used%`. 90% consumed is fine at hour 4 of 5
and a five-alarm fire at minute 20 - only the comparison against elapsed time
tells you which situation you are in. That comparison is the arrow.

#### The three states

| Arrow | Colour | Meaning                                                               | Exhaustion clock                  |
| ----- | ------ | --------------------------------------------------------------------- | --------------------------------- |
| `↑`   | red    | Burning too fast. **The limit will be hit before the window resets.** | Yes - projected time you hit 100% |
| `→`   | yellow | On pace to land almost exactly on 100% at reset.                      | Yes                               |
| `↓`   | green  | Under-consuming. The limit will not be reached this window.           | No - there is nothing to project  |

Worked examples, both from a 5-hour window with 17 minutes left (so ~94% of the
window has elapsed):

```text
5h 8%:94%↓:17m      ample headroom - 8% consumed where linear burn would be at 94%
5h 94%:8%↑ 16:20    critical - 94% consumed in the first 8% of the window
```

The second reading is the one worth catching early. `94%` alone looks survivable
if you assume the window is nearly over; `94%:8%` makes it immediately obvious
that it is not.

#### How the state is chosen

```text
projected% = used% * duration / elapsed
```

"If I keep burning at exactly this rate, where do I land at reset."

| Projected | Arrow |
| --------- | ----- |
| > 115     | `↑`   |
| 85 – 115  | `→`   |
| < 85      | `↓`   |

This is a **ratio** band, not a fixed spread of percentage points. A 5-point
spread is far too tight at hour 4 of a 5-hour window - where a couple of points
of noise flips the arrow - and far too loose at hour 1, where 5 points is a
wildly different trajectory. The ±15% ratio band behaves correctly at both ends.
Thresholds live in `PACE_FAST_PROJECTED` and `PACE_SLOW_PROJECTED`.

#### The exhaustion clock

```text
exhaust_at = start + elapsed * (100 / used%)
where  start = resets_at - duration
```

Shown for `↑` and `→` only. It is provably earlier than `resets_at` exactly when
`used% > on_pace%`, which is precisely when those two arrows appear - so the
time printed is never one the window reset would have preempted.

The clock is coloured independently of the arrow, by how much of the _remaining_
window it eats:

| Time to exhaustion, as a share of time to reset | Colour |
| ----------------------------------------------- | ------ |
| < 33%                                           | red    |
| < 66%                                           | orange |
| otherwise                                       | green  |

So `↑` with a green clock means "you will run out, but not for a while", and
`↑` with a red clock means "you will run out very shortly".

#### Suppression

Both the arrow and `on_pace%` are hidden during the **first 2% of a window**,
because `elapsed` near zero makes `on_pace%` ≈ 0 and the projection explodes:
any usage at all would read as a red `↑` with an absurd exhaustion time. That is
6 minutes into a 5-hour window and roughly 3.4 hours into a 7-day one.
`used%` and `time until reset` still render throughout. Controlled by
`PACE_MIN_ELAPSED_FRACTION`.

Arrows are also suppressed when `resets_at` is stale or implausible - already
past, or more than a full window in the future.

Window lengths: 5-hour = 18,000 s, 7-day = 604,800 s.

### Budget - API, Bedrock, Vertex and Enterprise

`rate_limits` is sent **only to Claude.ai subscribers**, and even then only after
the first API response of the session. Billed deployments are metered in dollars
instead, so the two window cells give way to a spend gauge against an allocation
you set:

```text
Bgt $34.63/250:6h
    |      |   `- time until the allocation runs out at the current burn rate
    |      `- the allocation
    `- spend so far this period
```

**Detection.** Absent `rate_limits` on its own does not mean "billed" - that is
also what every subscription session looks like before its first response. The
swap waits until tokens or cost have actually moved, so a subscription session
never opens on the budget cells and flips to `5h`/`7d` a moment later.

**Spend** comes from the same cost ledger that feeds line 3, summed over the
sessions whose start falls inside the current period, plus
`CC_STATUSLINE_BUDGET_OFFSET`. No second store, no extra file read.

**Colours:** cyan under 50% of the allocation, yellow at 50-80, red above 80.
The trailing span is the same projection the pace arrows make, coloured by how
much of the remaining period it eats (red under 33%, orange under 66%). It
disappears once the allocation is spent - there is nothing left to project.

| Variable                        | Default | Meaning                                              |
| ------------------------------- | ------- | ---------------------------------------------------- |
| `CC_STATUSLINE_BUDGET`          | unset   | The allocation in dollars. Unset hides the cell.     |
| `CC_STATUSLINE_BUDGET_PERIOD`   | `month` | `day`, `week` (Monday-anchored) or `month`.          |
| `CC_STATUSLINE_BUDGET_RESET`    | unset   | `HH:MM` local time the period rolls over.            |
| `CC_STATUSLINE_BUDGET_OFFSET`   | `0`     | Spend the local ledger never saw.                    |

**`CC_STATUSLINE_BUDGET_RESET` is where the Console's billing period gets
matched.** Unset, a `month` period runs from the 1st at midnight. Set, a `month`
period closes on the **last day of the month** at that time - `17:00` gives a
period ending on the last day at 5pm, which is where Console billing actually
lands. For `day` and `week` the reset time applies to the boundary day itself.

`CC_STATUSLINE_BUDGET_OFFSET` exists because the ledger only knows the sessions
it saw: installed mid-period, or billed for work from another machine, it
under-reports. Read the period-to-date figure off the Console once and set the
difference.

```bash
CC_STATUSLINE_BUDGET=250
CC_STATUSLINE_BUDGET_RESET=17:00
CC_STATUSLINE_BUDGET_OFFSET=180.40
```

### `$/Mtok`

Blended cost per million tokens: `total_cost_usd` over every token the session
was billed for, taken from the transcript's cumulative totals (fresh input,
cache creation, cache reads and output).

There is no fallback. The payload's token counts are window-scoped - "token
counts currently in the context window, from the most recent API response" - so
using them would divide a whole session's cost by a single response's tokens and
report a rate several times too high. Without the transcript there is no honest
denominator, and the cell is omitted rather than made up.

Per **million**, not the reference's per 1k: at two decimal places a per-1k
figure collapses to `$0.01` or `$0.02` for every model on the market - one
significant digit, and no way to watch a cache strategy pay off. Per-million
keeps the resolution the number exists for.

### Token counts

The two halves answer different questions and come from different places.

**`In` is window occupancy** - `context_window.total_input_tokens`, the sum of
`input + cache_creation + cache_read` currently in the window. It deliberately
does _not_ use `current_usage.input_tokens`, which is fresh _uncached_ input
only: on a warm session that is a single-digit number (`In 2`) while the context
actually holds a hundred thousand tokens.

**`Out` is the session's cumulative output**, accumulated from the transcript.

There is no payload field for this. `context_window.total_output_tokens` and
`current_usage.output_tokens` are both **the most recent response only** - so a
payload-sourced `Out` sits at a few hundred all session while `In` climbs into
six figures, which is exactly the asymmetry that reads as broken. The transcript
at `transcript_path` is the only place the full history lives.

Two things make reading it cheap and correct:

**Incremental.** The byte offset already consumed is stored in the ledger, so
each render parses only the bytes appended since the last one. Only the first
render of a pre-existing session pays for a full scan - about 9 ms for a 1.3 MB
transcript, because lines without a `"usage"` substring are skipped before
`JSON.parse` is ever called, and those are most of them.

**Deduped.** A single assistant response is written to the transcript several
times as it streams, and **every copy carries the same `usage` object**. Summing
naively overcounts by roughly 1.8×. Records sharing a message id are always
contiguous - verified across a full session, zero non-contiguous repeats - so
tracking the last counted id is sufficient. That id is persisted alongside the
offset, so a chunk that starts mid-run is handled too.

The reader also handles a partial trailing line (the writer may be mid-append:
it rewinds to the last complete line so no bytes are skipped or double-read) and
a shrunk or replaced file (offset resets and the session re-accumulates).

If `transcript_path` is missing or unreadable, `Out` falls back to the payload's
last-response figure.

Subagent output counts toward the session total - it is the session's spend.

### Cache hit rate

```text
cache_read_input_tokens
------------------------------------------------------------------- × 100
input_tokens + cache_creation_input_tokens + cache_read_input_tokens
```

Summed **across the whole session**, from the same transcript scan that produces
`Out`, rather than from the last call alone. The per-call figure swings hard - a
single cache-writing turn reads 92% where the session is running at 98% - and
the session number is the one that says whether the conversation is caching
well. It also keeps `Out` and `Cache` in the same frame of reference.

Falls back to `current_usage` (i.e. the last call) when the transcript is
unreadable. Denominator zero - or any field nullish - yields `0%`. Colours
invert the usual scale: green ≥ 80, cyan ≥ 50, orange below.

Note the denominator differs from implementations using
`read / (read + creation)`. That form omits fresh input and so overstates the
hit rate.

### LngCtx

```text
LngCtx% = (total_input_tokens + last_response_output_tokens) / 200_000 × 100
```

Note the output half is the **last response's** output, not the session-
cumulative `Out` shown two cells to the left. `exceeds_200k_tokens` is defined
against a single response - "input, cache and output tokens combined, from the
most recent API response" - so mixing in the cumulative total would push the
gauge past 100% on any long session regardless of actual request size.

`exceeds_200k_tokens` is a **fixed 200k threshold regardless of the actual
window size**. On a 1M-context model it is therefore reached at roughly 20%
context - long before `Ctx 20%` looks like anything worth noticing. Crossing it
moves requests into the long-context premium tier and accelerates rate-limit
burn.

Showing it as a percentage rather than a boolean flag means the _approach_ is
visible, not just the arrival:

| LngCtx | Colour |
| ------ | ------ |
| < 50%  | green  |
| 50–79% | yellow |
| 80–99% | orange |
| ≥ 100% | red    |

`exceeds_200k_tokens === true` forces red regardless of the arithmetic: it is
computed host-side from the same response and is authoritative at the boundary.
It also turns the **`LngCtx` label itself** red, not just the number - once the
threshold is actually crossed this is a billing-tier change rather than a gauge
reading, and a dim label beside a red figure reads as ordinary.

**The cell only appears on an extended window.** On a 200k model `Ctx` is
already `total_input_tokens / 200_000` - the same numerator over the same
denominator - so `LngCtx` would restate it one response's output higher and
waste a slot on a duplicate. It renders when `context_window_size` is above
200k, or when the size is absent and cannot be ruled out. The one exception is
`exceeds_200k_tokens === true`, which keeps the red label on screen at any
window size: input plus output can overshoot 200k on a 200k model too, and that
crossing is a billing event, not a gauge reading.

### Fable

As of July 2026 a subscription may spend up to half its weekly limit on Fable 5.
That makes the `7d` cell alone useless for pacing Fable: a 40% weekly reading is
comfortable if it is all Sonnet and nearly spent if it is all Fable. So the cell
reports Fable's own bucket against the Fable allowance rather than against the
whole limit.

There are two ways to get that number, and the tilde tells you which one you are
looking at:

| Cell | Source |
|------|--------|
| `Fable 2%` | the server's own figure, from the [usage endpoint](#usage-endpoint) |
| `Fable ~2%` | the local estimate below |

Colours match `Ctx` - green < 70, yellow ≥ 70, red ≥ 90. A server figure carrying
a `warning` or `critical` severity is escalated beyond what its percentage alone
would earn; severity can only ever make the cell *more* alarming, never less.

#### The estimate

Without the usage endpoint the payload carries no model-scoped weekly bucket -
`rate_limits` is exactly `five_hour` and `seven_day` - so the only way to split
the weekly figure by model is to weight it by the model's share of local ledger
spend over the same window:

```text
share  = min(1, ledger.fable / ledger.fableWindow)
raw%   = seven_day.used_percentage × share / CC_STATUSLINE_FABLE_SHARE × 100
Fable% = min(100, raw% × k)
```

The window is anchored on `seven_day.resets_at` minus seven days, not on a local
calendar boundary, so the bucket and the limit it is measured against cover the
same period. Spend is attributed **by delta**: a `/model` switch mid-session
moves only the dollars spent after the switch, rather than retroactively
reassigning the whole session to whichever model happened to be active at the
last render.

`CC_STATUSLINE_FABLE_SHARE` sets the allowance percentage. It is the one number
in `raw%` that is a policy assumption rather than a payload field, which is why
it is the only knob - the default tracks the July 2026 policy and the env var
covers it moving.

#### `k` - the learned correction

`raw%` assumes a dollar of Fable and a dollar of Sonnet consume the same fraction
of the weekly limit. They do not, exactly, and the size of the error depends on
things no formula here can see: whether the server normalises its scoped bucket
against the Fable allowance or against the whole weekly limit, and what model mix
and reasoning effort your account actually runs at.

So it is measured rather than assumed. Every render that has **both** the server
figure and the local estimate records the ratio between them:

```text
k ← 0.75 × k + 0.25 × (server% / raw%)      clamped to [0.2, 5]
```

`k` lives in the ledger as `fcal` and is applied whenever the server figure is
missing - offline, token expired, or the endpoint switched off. Samples below 2%
on either side are discarded: their quotient is dominated by rounding. One render
with the endpoint on is enough to seed it; it converges within an hour of use and
re-converges on its own if your habits change.

Turn the endpoint off and `k` simply stops updating - the last value learned goes
on correcting the estimate.

**The cell reads low on first install.** The Fable bucket is a ledger field
sessions predating it carry no attribution for, so the estimate starts near zero
and becomes accurate once the rolling seven-day window has turned over. The
server figure has no such warm-up. Both collapse entirely on a billed plan, which
is correct: there is no Fable allowance to pace against there, only dollars, and
`Bgt` already covers those.

## Usage endpoint

**Off by default.** Turn it on with `install.js --usage`, off again with
`--no-usage`.

`GET https://api.anthropic.com/api/oauth/usage`, authenticated with the same
OAuth bearer Claude Code already holds, answers the question the statusline
payload cannot:

```json
{ "limits": [
    { "kind": "session",       "percent": 18, "severity": "normal" },
    { "kind": "weekly_all",    "percent":  8, "severity": "normal" },
    { "kind": "weekly_scoped", "percent":  2, "severity": "normal",
      "scope": { "model": { "display_name": "Fable" } } } ] }
```

`weekly_scoped` is the per-model weekly bucket, computed server-side and already
expressed as a percentage of that model's own allowance. It is a measurement
where the `Fable` estimate is an inference, so when it is available it wins - and
it is matched to whatever model you are on by family name, so an account with a
scoped bucket for something other than Fable gets that reported too, under the
server's own label for it.

**It costs no tokens.** There is no inference behind it; it is account metadata,
the same figures `/usage` shows.

### Which plans

| Plan | |
|------|--|
| Pro / Max | Works. This is what it was built against. |
| Team / Enterprise seat | Should work - same OAuth credential, and the response already carries `member_dashboard_available`, an org-seat concept. **Unverified**: developed on a `max` account. An org with no per-model limits gets `session` and `weekly_all` only, no `weekly_scoped`, so the cell collapses and the [gate](#when-it-actually-refreshes) drops to hourly retries. Degrades, does not break. |
| API key, Bedrock, Vertex | Inert **by design**. There is no `claudeAiOauth` credential on those deployments, so the child exits without making a request and no cache is ever written. The bar falls back to the `Bgt` budget cell exactly as before. |

Managed environments get the right defaults without any of this: the feature is
off unless a flag file exists, and `CC_STATUSLINE_USAGE=0` forces it off
fleet-wide through environment policy without touching files.

### How it stays off the render path

The render loop runs on a 300 ms debounce and a TLS round trip inside it would
make the bar stutter. So the work splits exactly the way [auto-update](#auto-update)
does:

| | |
|---|---|
| **render** | one `statSync` on the flag, one on a debounce marker, one small `readFileSync`. When the marker ages past the TTL it is touched and a **detached** child is spawned. This render draws whatever was already cached and never waits. |
| **child** | reads the credential, makes the request, writes the cache, exits. Nothing it does can delay a frame. |

The marker is stamped *before* the spawn, so a request that fails - offline, 401,
rate limited - still debounces for a full TTL instead of re-arming on every
render. A failed refresh leaves the previous snapshot in place.

There is no daemon. Refreshes ride the render loop, so a machine with Claude
Code closed makes no requests at all.

### When it actually refreshes

The endpoint answers for the whole account, but only a model with a scoped
bucket has anything to draw from it. Polling every 90s while on a model that has
none would be traffic bought for nothing, so the full cadence is gated:

| Condition | Cadence |
|-----------|---------|
| Nothing cached yet | one bootstrap request, whatever the model |
| Snapshot older than an hour | one request, whatever the model |
| This model has a scoped bucket, or is Fable | every TTL (90s) |
| Otherwise | none |

The two model-blind escapes are not optional. A model earns a scoped bucket by
appearing in a response, so a gate that only refreshed for models already known
to have one could never discover the first - the hourly retry is what picks up a
bucket Anthropic adds later, at roughly 1/40th the traffic of the full cadence.

Fable stays on the full cadence even with no bucket cached, because its
[fallback estimate](#k---the-learned-correction) is calibrated from exactly these
responses.

Past **one hour** without a successful refresh the cached figure stops counting
as a measurement and the calibrated estimate takes over. An hour of drift on a
seven-day window is negligible; an hour of silence means something is actually
broken, and presenting a stale measurement as current is the one failure worse
than presenting an estimate.

### Credentials

| Platform | Store |
|----------|-------|
| Windows, Linux, WSL | `<config>/.credentials.json` |
| macOS | login Keychain, service `Claude Code-credentials` |

On macOS the child shells out to `security find-generic-password -w`. **The first
refresh raises one Keychain prompt** naming `/usr/bin/security` - answer *Always
Allow* and it never returns. That prompt is precisely why the read happens in the
detached child: a blocking dialog on the render path would freeze the status bar.

The Keychain is consulted only when `CLAUDE_CONFIG_DIR` is unset. A caller that
pointed the statusline at a specific config directory means the credentials in
*that* directory, and honouring it is what keeps a sandboxed config - the test
suite included - from ever reaching the real account.

The token is read, used once, and never stored, logged, or written to the cache.

### Hardening

- **No redirects are followed.** The request carries a bearer token; following a
  302 would hand that credential to whatever host the redirect names. The
  self-updater does follow redirects, because it sends no credential at all -
  the two deliberately do not share a fetch helper.
- The response is capped at 256 KB (the real one is ~1.5 KB) and timed out at 10 s.
- Only the fields the bar draws are cached. Percentages are clamped, severities
  whitelisted, model names stripped to `[\w .+-]` and clipped to 24 chars.
- The cache is re-validated and re-sanitised **on read**, not merely on write. It
  is a file in a shared config directory, and anything that can write it would
  otherwise get a string into your terminal on the next render. Symlinks and
  files over 64 KB are refused outright.
- Written by atomic rename, so a render can never read a half-written cache.

### Files and settings

| Path | |
|------|--|
| `<config>/.statusline-usage` | flag file; the feature is off without it |
| `<config>/.statusline-usage.json` | the cached snapshot, ~300 bytes |
| `<config>/.statusline-usage-check` | refresh debounce marker |

| Variable | Default | |
|----------|---------|--|
| `CC_STATUSLINE_USAGE=0` | - | Kill switch. Forces the feature off even with the flag present. It cannot turn it *on* - opting in is a deliberate on-disk act, so a stray inherited variable can never start network traffic. |
| `CC_STATUSLINE_USAGE_TTL` | `90` | Seconds between refreshes, clamped to `[60, 600]`. The bucket it feeds moves by single-digit percent per *day*, so anything under a minute is waste. |

`--no-usage` deletes the cache along with the flag: leaving account data behind
after you opted out is the wrong default.

### Burn rate

```text
$/hr = session_cost / (total_api_duration_ms / 3_600_000)
```

Divided by **API time, not wall time**. Wall-clock `$/hr` is dominated by
however long you spent reading a diff and says nothing about spend. `session_cost`
is `cost.total_cost_usd` from the payload, so this cell resets to `$0.00` on
`/clear` along with the `S` cell it sits next to. Figures above $1000/hr are
suppressed - at that point it is a sampling artifact of a very short session
(a handful of seconds of API time with a real dollar cost already attached to
it), not information you can act on.

Two sessions can show the same `S $4.87` and mean very different things: one
earned that cost over 20 minutes of steady work, the other over 20 seconds of a
single large tool call. `$/hr` is what tells them apart, and it is the number
worth watching if a plan's spend is capped by dollars rather than by the
rate-limit windows above it.

`API n%` is the complement of the same duration split: `total_api_duration_ms /
total_duration_ms`, i.e. how much of the session's wall-clock time was actually
inference rather than you reading, typing, or looking away. A session at `API
5%` spent the other 95% of its wall time waiting on you, not on the model - the
low number is not a performance problem, it is a description of your own pace.
Neither cell is colour-coded; both are read alongside `S`/`D`/`W`/`M`, not in
place of them.

---

## The cost ledger

The payload exposes `cost.total_cost_usd` for the **current session only**, and
it resets to `$0` when `/clear` starts a new one. Day, week, and month totals
therefore require local state.

### File format

`~/.claude/cost_ledger.json`:

```json
{
  "v": 1,
  "sessions": {
    "e7b47fc8-b328-42cc-96c1-ff341f7944d8": {
      "first": 1784968584699,
      "last": 1784968839965,
      "cost": 4.1637,
      "fab": 0.9102,
      "days": {
        "2026-08-05": [3.2115, 0],
        "2026-08-06": [0.9522, 0.9102]
      },
      "gDir": "C:/G/repos/claude-statusline",
      "gTs": 1784968839102,
      "gRoot": "C:/G/repos/claude-statusline",
      "gSt": { "branch": "main", "detached": false, "ahead": 0, "behind": 0, "staged": 0, "modified": 2, "untracked": 0 },
      "tPath": "~/.claude/projects/<project>/<session>.jsonl",
      "tOff": 1418150,
      "tId": "msg_011CdNbkFr8oMxSYfne14bEe",
      "tOut": 143755,
      "tIn": 3345,
      "tCc": 403986,
      "tCr": 18754674
    }
  },
  "fcal": { "k": 0.5, "at": 1784968839965 }
}
```

| Field                    | Meaning                                                                                    |
| ------------------------ | ------------------------------------------------------------------------------------------ |
| `first`                  | Epoch ms the session was first observed. Only a fallback anchor now - see below.           |
| `last`                   | Epoch ms of the most recent update. Drives retention pruning.                              |
| `cost`                   | Highest `total_cost_usd` ever seen for that id.                                            |
| `fab`                    | Of that total, the part that accrued while Fable was the active model.                     |
| `days`                   | `YYYY-MM-DD` (local) -> `[total, fableShare]` accrued that day. **The bucketing unit.**    |
| `gDir` `gTs`             | Directory the cached `git status` describes, and when it was taken.                        |
| `gSt` `gRoot`            | The cached status itself, and the repo root the fetch debounce needs.                      |
| `tPath`                  | Transcript this session's token totals were accumulated from.                              |
| `tOff`                   | Byte offset consumed so far - the incremental read resumes here.                           |
| `tId`                    | Last counted message id, so streamed duplicates are not recounted across a chunk boundary. |
| `tOut` `tIn` `tCc` `tCr` | Cumulative output / fresh input / cache-creation / cache-read tokens.                      |

`fcal` sits beside `sessions` rather than inside it: it is an account-wide
correction, not a per-session fact. See [`k`](#k---the-learned-correction).

The token fields share this record rather than living in their own store: a
separate file would mean two file round-trips per render for the same session.
For the same reason the ledger is read and written **once** per render and the
result is passed to both the cost line and the runway line.

### Three design decisions worth knowing

**Max-observed, not last-observed.** `total_cost_usd` is monotonic within a
session, but a resumed or forked session can briefly report a lower figure
before its first API call repopulates the field. Taking the max makes the ledger
immune to that without needing to understand why it happened.

**Bucketed per day, not per session.** `total_cost_usd` is a single running
number for a whole session, so the obvious anchors are both wrong. On `last`, a
session that spans midnight drags its entire history into the new day and
yesterday's total silently shrinks. On `first` - what this did until the `days`
map existed - the same session never contributes to today at all: at 00:20, an
hour into a session opened yesterday, `D` reads `$0.00` no matter what you have
spent since midnight.

Neither is fixable by picking the other anchor, so the delta each render already
computes (it has to, to split Fable spend out of a session that switched models
part-way) is accrued into a bucket keyed by the local date instead. D/W/M sum
buckets, a session that spans a boundary is split across it, and historical
buckets are still immutable once the day is over.

Sub-day windows - a 17:00 budget reset, the Fable window anchored on the host's
`resets_at` - cannot be answered exactly at day granularity. A bucket that
**overlaps** such a window counts in full: overstating the boundary day is a
safer failure for a spend gauge than silently dropping it.

Records written before the `days` map existed keep working. The session being
rendered has its running total folded onto the day it started - the same day the
old roll-up credited it to - the first time it renders again; every other record
falls back to the old anchored behaviour until its own session next appears.
Nothing is retroactively re-split, because the ledger never stored the
information needed to do so.

**Writes are atomic and rare.** The file is written to `<path>.<pid>.tmp` and
then `rename()`d, which replaces atomically on both Win32 and POSIX - a render killed mid-write
(Claude Code cancels in-flight statusline processes when a new update arrives)
can never leave truncated JSON behind. And the write is skipped entirely when
the cost has not moved, so most renders at a 300 ms debounce are pure reads.

Sessions are pruned after 45 days, which covers "current month" from any day of
the month. Day buckets share that horizon: the record being rendered has its
expired keys swept in the same pass, so a session left open for months cannot
grow an unbounded map.

### Resetting

Delete the file. It is recreated on the next render, and the transcript token
totals re-accumulate from scratch on the first render of each session.

```bash
node -e "const os=require('os');require('fs').unlinkSync(os.homedir()+'/.claude/cost_ledger.json')"
```

Or just delete `~/.claude/cost_ledger.json` however you like.

A corrupt file is silently discarded and recreated rather than crashing the bar,
so there is no state you can get stuck in.

---

## Plugin mode detection

Both `caveman` and `ponytail` share a design: a flag file under `~/.claude`
holding the live mode, an environment variable holding the _default_ mode, and
an optional `config.json`.

Resolution order:

1. `~/.claude/.caveman-active` / `~/.claude/.ponytail-active` - the **runtime
   source of truth**
2. `CAVEMAN_DEFAULT_MODE` / `PONYTAIL_DEFAULT_MODE` - the default for a _new_
   session, not the current state
3. `config.json` `defaultMode`, searched in `$XDG_CONFIG_HOME/<plugin>/`, then
   `%APPDATA%\<plugin>\`, then `~/.config/<plugin>/`

The flag file is checked first because the env var only says what a fresh
session _starts_ as - after a mid-session `/caveman ultra` the two disagree, and
the flag file is right.

Mode `off` renders no tag at all. Neither does an absent plugin. There are never
empty brackets.

`CLAUDE_CONFIG_DIR` is honoured the same way Claude Code and both plugins honour
it.

---

## Configuration

### Constants (top of `statusline.js`)

| Constant                    | Default | Effect                                                                        |
| --------------------------- | ------- | ----------------------------------------------------------------------------- |
| `SHOW_COST_LABELS`          | `true`  | `S $4.87 · D $24.14` vs bare `$4.87 · $24.14`. `false` is 8 columns narrower. |
| `LEDGER_RETENTION_DAYS`     | `45`    | How long sessions survive in the ledger.                                      |
| `PACE_MIN_ELAPSED_FRACTION` | `1/50`  | Fraction of a window that must elapse before on_pace% and arrows appear.      |
| `PACE_FAST_PROJECTED`       | `115`   | Projected % above which the arrow turns red.                                  |
| `PACE_SLOW_PROJECTED`       | `85`    | Projected % below which the arrow turns green.                                |
| `GIT_TIMEOUT_MS`            | `800`   | Hard kill for a hung `git status`.                                            |
| `FETCH_DEBOUNCE_SECONDS`    | `600`   | Minimum gap between background fetches, per branch.                           |

In `subagent-statusline.js`:

| Constant          | Default | Effect                                                             |
| ----------------- | ------- | ------------------------------------------------------------------ |
| `SHOW_IDLE_ROWS`  | `true`  | `false` hides every teammate that is not actively running.         |
| `DEFAULT_COLUMNS` | `80`    | Width used when the payload's `columns` is missing or nonsensical. |

### Environment variables

| Variable                  | Effect                                                                               |
| ------------------------- | ------------------------------------------------------------------------------------ |
| `CC_STATUSLINE_NOGIT=1`   | Skip the git subprocess entirely. Saves ~79 ms per render.                           |
| `NO_COLOR=1`              | Disable all ANSI colour ([no-color.org](https://no-color.org) convention).           |
| `CC_STATUSLINE_NOCOLOR=1` | Same, without affecting other tools.                                                 |
| `CC_STATUSLINE_ASCII=1`   | Replace `↑ → ↓ ⎇ ✓ ⇡ ⇣ ↺` with `^ = v br ok ^ v ~`. Use if your console font boxes them. |
| `COLUMNS`                 | Set by Claude Code; see below.                                                       |
| `CLAUDE_CONFIG_DIR`       | Relocates `.claude`, including the ledger and plugin flags.                          |
| `CC_STATUSLINE_BUDGET`    | Dollar allocation for billed plans. Turns on the `Bgt` cell. [Details](#budget---api-bedrock-vertex-and-enterprise) |
| `CC_STATUSLINE_BUDGET_PERIOD` | `day`, `week` or `month` (default).                                              |
| `CC_STATUSLINE_BUDGET_RESET`  | `HH:MM` the budget period rolls over. `17:00` matches Console billing.           |
| `CC_STATUSLINE_BUDGET_OFFSET` | Period spend the local ledger never saw.                                         |
| `CC_STATUSLINE_FABLE_SHARE`   | Percent of the weekly limit Fable may use. Default `50`. Drives the `Fable` estimate. |
| `CC_STATUSLINE_USAGE=0`       | Force the [usage endpoint](#usage-endpoint) off. Cannot turn it on - that needs `install.js --usage`. |
| `CC_STATUSLINE_USAGE_TTL`     | Seconds between usage refreshes. Default `90`, clamped to `[60, 600]`.               |

---

## Width adaptation

Claude Code captures stdout instead of attaching it to the terminal, so
`tput cols` and `process.stdout.columns` both read as undefined from inside the
script. The host instead exports `COLUMNS` and `LINES` before running the
command (v2.1.153+).

Wrapping is worse than truncation: a wrapped line costs an entire extra terminal
row and shuffles the bar's position. So each line is assembled as _prioritised
cells_, and cells are dropped - highest rank first, rightmost of a tie first -
until the line fits.

| Rank | Behaviour     |
| ---- | ------------- |
| 0    | Never dropped |
| 1–2  | Dropped last  |
| 3–6  | Dropped first |

Rate limits are ranked 1: on a Max plan the windows are the binding constraint,
so they outlive token counts, the cache rate and LngCtx. `Bgt` inherits that
rank on billed plans for the same reason - it is the constraint that ends the
day's work. `$/Mtok` is ranked 5 and goes early; it is a diagnostic, not a
runway.

`Fable` is ranked 2, the same as `LngCtx`, but sits to its right - so the
tie-break drops `Fable` first. That is the cost of grouping it with the other
two limit gauges instead of placing it mid-line: it buys a line that reads as
one group at full width and gives up a few columns of survival at the narrow
end. Both are estimates of a tier boundary rather than measurements of it, and
neither is worth a rank-1 slot ahead of the windows themselves.

Observed degradation:

```text
COLUMNS=96  Opus 5 (1M context) XHigh Thinking [FAST] [CAVEMAN:ULTRA] [PONYTAIL:ULTRA]
            Ctx 15% · In 152,002 Out 878 · Cache 92% · LngCtx 76% · 5h 6%:34%↓:3h · 7d 1%:17%↓:5d
            S $4.87 · D $24.14 · W $24.14 · M $24.14 · $19.48/hr · API 25%
            my-project · ⎇ main ?1 · statusline-hardening-and-git-state

COLUMNS=74  Opus 5 (1M context) XHigh [FAST] [CAVEMAN:ULTRA] [PONYTAIL:ULTRA]
            Ctx 15% · Cache 92% · LngCtx 76% · 5h 6%:34%↓:3h · 7d 1%:17%↓:5d
            S $4.87 · D $24.14 · W $24.14 · M $24.14 · $19.48/hr · API 25%
            my-project · ⎇ main ?1 · statusline-hardening-and-git-state

COLUMNS=56  Opus 5 (1M context) [CAVEMAN:ULTRA] [PONYTAIL:ULTRA]
            Ctx 15% · LngCtx 76% · 5h 6%:34%↓:3h · 7d 1%:17%↓:5d
            S $4.87 · D $24.14 · W $24.14 · M $24.14 · $19.48/hr
            my-project · ⎇ main ?1

COLUMNS=38  Opus 5 (1M context) [CAVEMAN:ULTRA]
            Ctx 15% · 5h 6%:34%↓:3h
            S $4.87 · D $24.14 · W $24.14
            my-project · ⎇ main ?1
```

`COLUMNS` values below 20, non-numeric, or absent disable trimming entirely
rather than producing a degenerate line.

---

## Robustness

### Null safety

Per the official schema, these are the fields that actually go missing:

- `context_window.current_usage` - **null before the first API call of a
  session, and again after `/compact`** until the next response
- `context_window.used_percentage`, `remaining_percentage` - may be null early
- `rate_limits` - **entirely absent on API/Bedrock/Vertex/Enterprise billing**,
  and absent on subscriptions until the first API response. Either window may
  also be missing independently. See
  [Budget](#budget---api-bedrock-vertex-and-enterprise) for what takes the slot
- `effort` - absent on models without an effort parameter
- `session_name`, `agent`, `pr`, `worktree`, `workspace.repo` - absent by
  default

Every field read goes through optional chaining plus a numeric coercion helper
that rejects `null`, `""`, `NaN`, and non-numeric strings. No object is assumed
to exist because its parent did.

### Failure behaviour

Each of the four lines is guarded independently, so one bad field cannot blank
the others. A top-level catch prints a minimal `Claude` line as a last resort.
**The script never exits non-zero** - doing so would make Claude Code log an
error on every single render.

Verified to produce correct output and exit 0 for: `{}`, non-JSON input, closed
stdin, `current_usage: null`, `rate_limits: null`, `COLUMNS=abc`, `COLUMNS=0`,
a missing/corrupt ledger, a non-repo working directory, and a detached HEAD.

### stdin handling

`fs.readFileSync(0)` is the usual one-liner, but it throws `EAGAIN` when the
parent hands over a non-blocking pipe. That happens on Windows depending on how
the host spawns the process, and is the ordinary case on POSIX. Instead the
script loops on `readSync`,
tolerates `EAGAIN` with a 2 ms backoff, treats `EOF`/zero-bytes as end of
stream, and hard-caps the total wait at 500 ms so a parent that never closes the
pipe cannot hang the bar.

### Terminal-injection defence

Three values reach the terminal on every keystroke and none of them are fully
trusted: the two plugin flag files, `session_name`, and `agent.name`.

- Flag files: symlinks and reparse points are refused, files over 64 bytes are
  refused, contents are stripped to `[a-z0-9-]` and then whitelist-validated.
  Without this, anything able to write that path could emit arbitrary escape
  sequences into your terminal continuously.
- `session_name` and `agent.name`: control bytes `U+0000–U+001F` and `U+007F`
  are stripped before rendering. `session_name` is no longer clipped, so this is
  the only thing standing between a hostile title and your terminal.

Verified: a `session_name` containing a raw `ESC[31m` renders as inert literal
text.

### Source hygiene

Every ANSI and control character in the script is written as a `\u001b`-style
escape, never as a raw byte. Raw control bytes in source are silently corrupted
by copy/paste, by editors, and by `core.autocrlf`.

---

## Troubleshooting

**`Fable ~n%` never loses its tilde.**
The tilde means the estimate is running because no server figure is available.
In order: is the flag there (`ls <config>/.statusline-usage`)? Is
`CC_STATUSLINE_USAGE=0` set anywhere? Then run the refresh child in the
foreground and look at what it leaves behind:

```bash
node ~/.claude/statusline.js --usage-refresh
cat ~/.claude/.statusline-usage.json
```

No file means the request failed. The usual causes are an expired token - open
Claude Code once to refresh it - or, on macOS, a declined Keychain prompt. Check
the credential is reachable by hand:

```bash
curl -s -H "Authorization: Bearer $(security find-generic-password -s 'Claude Code-credentials' -w | \
  node -pe 'JSON.parse(require("fs").readFileSync(0)).claudeAiOauth.accessToken')" \
     -H "anthropic-beta: oauth-2025-04-20" \
     https://api.anthropic.com/api/oauth/usage
```

A snapshot that exists but is over an hour old is treated as stale by design and
the estimate takes over; delete `.statusline-usage-check` to force a retry now
rather than waiting out the TTL.

**The bar is blank.**
Run the script by hand with a mock payload:

```bash
echo "{\"model\":{\"display_name\":\"Opus\"},\"context_window\":{\"used_percentage\":25}}" | node ~/.claude/statusline.js
```

Four lines back means the script is fine and the problem is the registration -
check `settings.json`. On Windows, no output at all usually means the `command`
path uses backslashes and Git Bash ate them; switch to forward slashes or `~`.
An error means `node --check` will say why.

**`node: command not found` in the Claude Code log.** Node is on your
interactive shell's `PATH` but not the one Claude Code inherits. Put the
absolute path to the `node` binary in the `command` string.

**The bar feels slower than it used to.** That is the git subprocess, ~79 ms.
`CC_STATUSLINE_NOGIT=1` removes it.

**Branch shows but ahead/behind never change.** Ahead/behind come from the last
fetch. The background fetch only runs in repos containing a `local/` directory,
at most once per 600 s per branch. Create `local/` in the repo to opt in, or run
`git fetch` yourself.

**Glyphs render as boxes.** Set `CC_STATUSLINE_ASCII=1`, or switch the console
font to one with full Unicode coverage (Cascadia Mono, Consolas).

**Rate limits show `n/a`.** Expected briefly at session start, before the first
API response - that is the one moment no plan can be told apart from another.
Once a response lands, a subscription fills the windows in and a billed plan
swaps them for `Bgt` / `$/Mtok`. `n/a` that never clears means no response has
come back yet.

**No `Bgt` cell on a billed plan.** `CC_STATUSLINE_BUDGET` is unset, or set to
something that is not a positive number. `$/Mtok` shows either way, provided the
transcript is readable.

**No `$/Mtok` cell on a billed plan.** The transcript at `transcript_path` could
not be read, so the session has no cumulative token total to divide by. See
[`$/Mtok`](#mtok).

**No `LngCtx` cell.** Expected on a 200k model, where it would only restate
`Ctx`. See [LngCtx](#lngctx).

**`Bgt` disagrees with the Console.** The ledger only counts sessions rendered
on this machine, and it keeps 45 days of them. Set
`CC_STATUSLINE_BUDGET_OFFSET` to the difference, and check that
`CC_STATUSLINE_BUDGET_RESET` matches where your billing period actually closes.

**Rate limits show only `used%` with no `on_pace%` or arrow.** Expected during
the opening 2% of a window - 6 minutes into a 5-hour window, ~3.4 hours into a
7-day one. `time until reset` still shows.

**Cache shows `0%`.** Expected before the first API call and immediately after
`/compact` - with no transcript history yet, `current_usage` is null in both
states and there is nothing to divide.

**`Out` looks stuck at a few hundred.** That is the payload fallback, meaning
the transcript could not be read. Check that `transcript_path` in the payload
exists. Deleting the ledger forces a clean re-accumulation.

**`Out` looks far too large.** Delete `cost_ledger.json`. A ledger written by an
older build, before streamed duplicates were deduped, overcounts by roughly
1.8×.

**Day/week/month all show the same number.** Correct on a fresh ledger: there is
only one day of history. They diverge as the ledger fills.

**Costs look wrong after `/clear`.** `/clear` starts a new session id with
`$0.00`. The `S` cell resets; `D`/`W`/`M` do not, because the old session is
still in the ledger.

---

## Subagent status lines (a separate feature)

Claude Code has **two independent statusline settings**, and this script
implements only the first:

| Setting              | What it renders                                                         | Implemented here  |
| -------------------- | ----------------------------------------------------------------------- | ----------------- |
| `statusLine`         | The bar above the footer. One command, one payload, whole-session data. | Yes - this script |
| `subagentStatusLine` | One row **per subagent** in the agent panel below the prompt.           | No                |

They do not overlap, and one cannot substitute for the other. The `Subagent
Active:` row this script prints comes from `agent.name`, which is the session's
own agent identity (`--agent` flag or agent settings) - it does not fire when a
Task-tool subagent runs, and it cannot: the main `statusLine` payload carries no
`tasks` array.

`subagent-statusline.js` in this directory implements the second one. It is
installed alongside the main script and the two are fully independent - remove
either without touching the other.

```text
cavecrew-investigator · Opus 5 XHigh · 42k 4% · 1m · grepping src/
code-reviewer · Haiku 4.5 Medium · 181k 91% · 9s · Review the diff on branch main
doc-writer · completed · Sonnet 5 · 25k 13% · 1h0m · Write the README
flaky · failed · unknown-model-id · Broken task
```

| Cell           | Source                            | Notes                                                                                                       |
| -------------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Name           | `name`, else `type`               | Bold, coloured by status: green running, cyan completed, red failed, dim otherwise.                         |
| Status         | `status`                          | Shown only when **not** running - a running row is the default case and does not need saying.               |
| Model + effort | `model`, `effort`                 | `claude-haiku-4-5-20251001` → `Haiku 4.5`. Effort may also be a numeric token budget.                       |
| Tokens         | `tokenCount`, `contextWindowSize` | Compact (`42k`, `1.2M`) plus a per-row context percentage, coloured on the same thresholds as the main bar. |
| Age            | `startTime`                       | Accepts epoch ms or an ISO string. Suppressed on clock skew.                                                |
| Detail         | `label`, else `description`       | The live status line if there is one, otherwise the original task text.                                     |

Cells drop by rank exactly as in the main script - except the detail cell: when
it cannot fit whole, it is clipped into whatever room remains rather than
dropped - it is the only cell that says what the teammate is actually doing.

Set `SHOW_IDLE_ROWS = false` at the top of the file to hide everything that is
not actively running.

### Behaviour and failure modes

- Emits one JSON line per task that has an `id`. A task without one is skipped,
  which leaves that row at its default rendering.
- On a malformed payload it emits **nothing at all** - every row keeps its
  default rendering, which is strictly better than emitting broken rows.
- One task that fails to render is skipped individually; the others still emit.
- Never exits non-zero. Task text is model-authored, so control bytes are
  stripped before it reaches the terminal.
- ~66 ms per tick.

### The `subagentStatusLine` contract

Input is one JSON object per refresh tick containing the base hook fields, a
`columns` field with the usable row width, and a `tasks` array. Each task has
`id`, `name`, `type`, `status`, `description`, `label`, `startTime`, `model`,
`effort`, `contextWindowSize`, `tokenCount`, `tokenSamples`, and `cwd`.

Output is one JSON line per row to override:

```json
{ "id": "<task id>", "content": "<row body>" }
```

`content` renders as-is, including ANSI colours and OSC 8 hyperlinks. Omit a
task's `id` to keep its default rendering; emit an empty `content` to hide the
row entirely.

### Why the model is read from the payload

Existing implementations of this hook - including
[GordonBeeming/claude-statusline](https://github.com/GordonBeeming/claude-statusline/blob/main/subagent-statusline.sh),
which was the starting point for this one - open each teammate's own transcript
at `<session>/subagents/agent-<id>.jsonl` to discover its model, on the stated
grounds that "the payload's `tasks[]` has no model field".

**That is no longer true.** `model` and `contextWindowSize` have been on each
task since v2.1.205, and `effort` since v2.1.214. Reading them from the payload
removes one file read per subagent per tick and drops a dependency on an
internal transcript path that is free to change. This script never touches the
transcript.

The same trust and `disableAllHooks` gates that apply to `statusLine` apply to
`subagentStatusLine`.

---

## Development

```bash
node test/run.js       # 87 assertions across all three scripts
node --check statusline.js && node --check subagent-statusline.js && node --check install.js
```

To exercise the installer without touching your real config, point it somewhere
disposable - `--dir` overrides `$CLAUDE_CONFIG_DIR`, and `--local` makes it
install the working tree instead of `main`:

```bash
node install.js --dir /tmp/cfg --local --dry-run
node install.js --dir /tmp/cfg --local
node install.js --dir /tmp/cfg --uninstall
```

Each test spawns the real script with a real stdin payload, because that is the
only interface Claude Code uses. Every run gets a throwaway `CLAUDE_CONFIG_DIR`,
so the suite never reads your plugin flag files or writes your cost ledger.

The installer cases work the same way: a real `install.js` process against a
throwaway `--dir`, asserting on what actually lands on disk. They cover the
`node -` piped form, key preservation, the settings backup, the abort on
unparseable JSON, `--main-only`/`--subagent-only`, the manifest hashes, the
uninstall, and - for the updater - that an edited file is never overwritten.

**The suite is offline but for one case.** Every installer case passes
`--local`, and every updater case is arranged so the updater bails out before
its first network call. The exception is _the piped form never auto-detects the
cwd as a source_, which necessarily reaches for the network - it asserts only on
the source line, printed before the first request, so it passes with or without
a connection.

Three conventions worth keeping if you send a patch:

**No raw control bytes in source.** Every ANSI and control character is written
as a `\u001b`-style escape. Raw bytes are silently mangled by copy/paste, by
editors, and by `core.autocrlf`, and the damage is invisible until it isn't.

**Everything stays synchronous and dependency-free.** The scripts run against a
300 ms debounce; a `require` outside Node's built-ins adds a module resolution
walk to every single render.

**The render path stays offline.** `https` and `crypto` are required lazily,
inside the detached updater child. Requiring them at the top of `statusline.js`
would put that cost on every render, including the renders of everyone who never
turned auto-update on.

---

## Attribution

An independent Node implementation. No code was copied from either project
below - neither declares a licence, so the debt is to their design, credited
here rather than vendored.

- [vfmatzkin/claude-statusline](https://github.com/vfmatzkin/claude-statusline) -
  the `used%:on_pace%:reset` rate-limit format, the pace-arrow model, and the
  git dirty-state and sync symbols follow this bash implementation. Where this
  version diverges it says so: the cache denominator, the day unit in
  `time until reset`, and one `git status` call instead of four.
- [GordonBeeming/claude-statusline](https://github.com/GordonBeeming/claude-statusline) -
  the starting point for the subagent panel. This version reads `model`,
  `effort` and `contextWindowSize` from the payload instead of opening each
  teammate's transcript.

---

## Reference

- [Statusline documentation](https://code.claude.com/docs/en/statusline) -
  the official payload schema, update triggers, and platform notes
- [Subagent status lines](https://code.claude.com/docs/en/statusline#subagent-status-lines) -
  the `subagentStatusLine` contract
- [no-color.org](https://no-color.org) - the `NO_COLOR` convention

---

## Licence

MIT - see [LICENSE](LICENSE).
