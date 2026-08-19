# Changelog

All notable changes to this project.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The
repository carries no version tags — the installer tracks `main` and self-updates
from it — so sections are dated rather than numbered, newest first.

## 2026-08-19

### Added

- `test/demo.js` renders the four README screenshot fixtures — an everyday
  subscription session, a billed plan against a monthly allocation, the subagent
  panel, and every cell populated at once. Everything the statusline reads is
  real: a scratch git repo carrying genuine staged/modified/untracked/ahead/behind
  state, a seeded ledger and RTK cache, and synthesised transcripts whose mtimes
  are backdated across all three prompt-cache colour tiers. It writes only to a
  throwaway `CLAUDE_CONFIG_DIR`, so it never touches a real ledger.

### Changed

- The cost ledger moved to `<config>/statusline/cost_ledger.json`, completing the
  move of every file this project writes into one directory. It keeps its name:
  it is the user's data rather than internal state, and a new directory is enough
  discontinuity on its own. `loadLedger` falls back to the old path and the whole
  store is rewritten on save, so months of spend survive the move untouched;
  `install.js` relocates it, `--uninstall` still keeps it, and `--purge` deletes
  it from either layout.

## 2026-08-18

### Added

- **Prompt cache countdown** — `Cache 98%:2:41` appends the seconds left on the
  5-minute prompt cache, with the label taking the countdown's colour. The clock
  runs only between turns, since every request renews the cache; `stop_reason:
  tool_use` and a user turn or tool result newer than the last response mark a
  request as still in flight. An expired clock still draws, so a stalled or
  cancelled turn cannot hide a dead cache. Catch-up reads stamp from the
  transcript's mtime, so a resumed session does not open on a false 5:00.
- **RTK badge** — `[RTK:18%|37K]`, the share of tokens this project's filtered
  commands saved and the count behind it, from `rtk gain -p -f json`. Measured by
  a detached `--rtk-refresh` child and cached per project directory (stale past
  30 minutes, 16 projects kept, at most one refresh a minute per project); the
  render only ever reads the cache, and draws nothing until the first measurement
  lands. `CC_STATUSLINE_NORTK=1` disables badge and measurement alike.
- A test asserting the shipped sources carry no CR bytes. `.gitattributes` has
  always required LF — byte offsets into the transcript depend on it — but
  nothing enforced it, and CRLF had crept in twice.

### Changed

- Eight `.statusline-*` dotfiles at the top of `<config>` became four files under
  `<config>/statusline/`, grouped by writer: `state.json` (installer and update
  child), `jobs.json` (render process), `usage.json` and `rtk.json` (their
  respective children). Grouping by writer is what makes it safe — no two
  processes read-modify-write the same file. Upgrades need no action: every
  reader falls back to its old path while the new file is absent, and the updater
  migrates itself.
- `refreshInterval` now defaults to 1. A frozen countdown is wrong the moment it
  stops moving; `--interval 10` remains for anyone who would rather not pay the
  ~120ms per render.

### Fixed

- `spawnDebounced` had no `'error'` handler. A failed spawn arrives
  asynchronously, long after its try/catch is gone — the frame was on screen but
  the process died non-zero and the host logged a render error on every
  keystroke. A cwd that no longer exists was enough to hit it. The fix also
  covers the self-update and usage jobs.

## 2026-08-10

### Changed

- The context gauge takes its colour from the absolute token count rather than
  `used_percentage`. Window size is a licensing decision, so colouring by percent
  called a 200k window at 190k critical and a 1M window at 190k comfortable, when
  both hold the same 190k. Five tiers from the NoLiMa / MRCR v2 / RULER work on
  mid-2026 1M+ models — 32K attention dilution, 128K moderate rot, 250K severe,
  600K collapse — emitted as truecolor, because the nearest xterm indices put
  adjacent tiers within a few units of each other.
- The subagent panel paints its per-row token counts on the same scale. A panel
  mixes models, so percentages run against different denominators and cannot be
  compared down the column; carrying the colour on the count also keeps a row
  tiered when `contextWindowSize` is absent.

## 2026-08-08

### Added

- **Server-reported Fable allowance** from `api.anthropic.com/api/oauth/usage`,
  whose `limits[]` carries a `weekly_scoped` entry with the server's own
  percentage. The statusline payload has no model-scoped weekly bucket, and the
  local inference it replaces read 67% on an account that had already hit its
  limit. Opt-in via `<config>/.statusline-usage` (`install.js --usage`), off by
  default: this is the only thing here that reaches the network with the user's
  credential. The render path does one `statSync` on the flag, one on a debounce
  marker and one small read — never a request; a detached child does the rest.
- The cell now distinguishes fact from guess: `Fable 2%` is the server's figure,
  `Fable ~2%` the local estimate. Every render holding both records
  `k = server/estimate` into the ledger as `fcal`, EWMA-smoothed and clamped, and
  applies it whenever the server's figure is missing.
- Scoped buckets are matched to the active model by family name, so an account
  with a bucket for something other than Fable reports it under the server's own
  label.

### Changed

- The detached workers are named for what they do: `selfUpdate` →
  `installUpdate`, `usageRefresh` → `cacheUsageSnapshot`. The `maybe*` triggers
  keep their names, and the `--self-update` / `--usage-refresh` argv flags are
  deliberately untouched — an installed copy spawns those exact strings, so
  renaming one would break a child spawned from a half-updated file.
- Four duplication sites folded into shared helpers: `spawnDebounced()`,
  `emptyTotals()`, `pickUsage()` and `modelLabel()`. The self-updater picks up
  the backwards-clock guard it lacked.
- Usage refreshes are gated on having something to show — the full 90s cadence
  only while on a model with a bucket, otherwise a bootstrap request and one
  retry an hour, so a model can still discover its first bucket.

### Security

- The usage request follows no redirects: it carries a bearer token, and a 302
  would hand it to whatever host it names. (The self-updater sends no credential
  and does follow them.) Responses are capped and timed out, cached fields are
  whitelisted and clamped, the cache is re-validated on read as well as write
  since it lives in a shared config directory, and writes are atomic. The token
  is used once and never stored, logged or cached. On macOS the Keychain read
  lives in the detached child — the first call raises a prompt, and a blocking
  dialog on the render path would freeze the bar — and is consulted only when
  `CLAUDE_CONFIG_DIR` is unset, keeping a sandboxed config (the test suite
  included) away from the real account.

## 2026-08-06

### Added

- Git status is cached for 3s (`GIT_CACHE_MS`) in the session's own ledger
  record, keyed by `session_id`. `git status --porcelain` was spawned on every
  render — at the 300ms debounce, ~10 spawns a second against a working tree that
  has not moved, at 30-60ms each on Windows. The repo root rides along, sparing
  an `existsSync` walk of up to 64 levels. Entries are discarded on a directory
  change, on age, and on a future timestamp, so a clock stepping backwards cannot
  pin the cache. Warm render: ~120ms to ~65ms.

### Fixed

- `D` read `$0.00` for a session spanning midnight. The roll-up anchored a whole
  session's cost on `first`, so a session opened yesterday never contributed to
  today; anchoring on `last` is equally wrong the other way. The per-render delta
  now accrues into a `days` map keyed by local date, and D/W/M sum buckets, so a
  session spanning a boundary is split across it. `fab` gets the same treatment.
  Sub-day windows count an overlapping bucket in full — overstating the boundary
  day beats dropping it. Records with no `days` map keep the old behaviour.

## 2026-07-27

### Added

- Fable allowance tracking. A subscription may spend up to half its weekly limit
  on Fable 5, which makes the 7d cell alone useless for pacing Fable: 40% is
  comfortable if it is all Sonnet and nearly spent if it is all Fable. The ledger
  keeps Fable spend in its own seven-day bucket, and while Fable is the active
  model the bar reports that bucket against the Fable allowance rather than the
  whole limit. `CC_STATUSLINE_FABLE_SHARE` sets the share (default 50).

## 2026-07-26

### Added

- Budget management for billed plans — API key, Bedrock, Vertex and Enterprise
  deployments, which have dollars rather than a weekly window to pace against.
  The statusline shows budget usage and blended cost per million tokens, with an
  `examples/payload-api.json` for the billed shape.

### Changed

- README rewritten around a new overview screenshot; outdated images and a stale
  chunk of `test/demo.js` removed.

## 2026-07-25 — initial release

### Added

- `statusline.js` and `subagent-statusline.js`: two dependency-free Node scripts
  for Claude Code's `statusLine` and `subagentStatusLine` settings, plus
  examples, a test suite and a demo. Four lines — model and mode flags; context,
  cache, long-context progress and both rate-limit windows; session/day/week/month
  cost with burn rate; repo, branch, working-tree state and worktree. Runs on
  Windows, macOS and Linux; Node floor 14.17.
  - Session output tokens are accumulated from the transcript, not the payload:
    both `total_output_tokens` and `current_usage.output_tokens` are the most
    recent response only. The read is incremental via a byte offset in the
    ledger and deduped by message id, because a streamed response is written
    several times with the same usage object — naive summing overcounts by ~1.8x.
  - Rate limits render `used%:on_pace%<arrow>:reset`, the arrow using a ratio
    band on projected end-of-window usage rather than a fixed point spread, which
    behaves at both ends of a window.
  - Git state comes from one `status --porcelain=v1 --branch` call instead of
    four subprocesses, with the repo root found in JS.
  - Lines are assembled as ranked cells and trimmed to `COLUMNS`, because a
    wrapped line costs a whole terminal row.
  - `subagent-statusline.js` reads model, effort and `contextWindowSize` from the
    payload rather than opening each teammate's transcript.
- `install.js`: one-file install/uninstall for both status lines, piped
  (`curl`/`irm | node -`) or from a clone. Atomic writes, `settings.json` backup,
  sha256 manifest, opt-in daily self-update, dry-run mode.
- `.gitattributes` pins LF and marks PNGs binary explicitly. The scripts assert
  they contain no raw control bytes and the transcript reader tracks byte offsets
  into a JSONL file, so `core.autocrlf` rewriting endings on checkout would change
  byte counts on the one class of bug this codebase is least able to see.
- README leads with a real render in which every conditional cell is forced on at
  once, replacing a hand-written mock.

### Fixed

- The piped installer no longer auto-detects the cwd as a source. Run via
  `curl … | node -`, Node reports `__filename` as the literal `"[stdin]"` and
  `__dirname` as `"."`; `resolveSource()` treated that as a checkout, so the
  documented one-liner installed whatever same-named files were lying around —
  silently. Source selection now follows how the installer was started: piped
  always fetches, `node install.js` installs its own checkout, `--local` /
  `--remote` override either way.
- Sizes are reported and thresholded in bytes, not characters. Both scripts are
  full of multi-byte glyphs, so `content.length` under-reported each file by ~30
  bytes — printed next to the word "bytes", and used by the installer's
  `MIN_BYTES` and the updater's `UPDATE_MIN_BYTES` gates.
- The `(1M context)` tag renders before effort, not after. Opus ships it inside
  `display_name`, so every other 1M model got our synthesised tag appended after
  effort instead, giving two line shapes for the same information.
- `renderRow`'s `'..'` clip fallback could never fire: `fit()` always drops the
  rank-5 detail cell first, so a squeezed row silently lost its description
  instead of clipping it. The fallback now also fires when the detail cell did
  not survive the first pass.
- The conditional 5th row label `Subagent Active:` became `Session Agent:` — it
  reads `agent.name`, the session's own `--agent` identity, and never lights up
  for Task-tool subagents.
- Panel escape assertions parse row JSON and assert on content: `JSON.stringify`
  escapes control bytes, so raw-stdout ESC checks were vacuously green.

### Security

Findings from an OWASP/SAST sweep:

- Terminal escape injection: `model.display_name`, effort fields and
  `workspace.repo.name` are sanitized, and every control-byte strip extends to C1
  (U+0080–U+009F).
- Prototype pollution: `session_id` is validated and ledger records use
  own-property lookup — a `session_id` of `__proto__` wrote onto
  `Object.prototype`.
- Windows untrusted search path: `NoDefaultCurrentDirectoryInExePath` is set so a
  repo-local `git.exe` is never spawned (CWE-427).
- Downloads capped at 5 MB, non-https redirects refused, response stream errors
  handled in both fetchers.
- stdin capped at 8 MB, transcript parsing at 32 MB per render.
- The fetch-lock dir is `lstat`ed so a symlinked `local/` cannot redirect writes.
- Random temp-file suffix for installer verification (CWE-377).
- `manifest.repo` validated as `owner/name` before URL interpolation.
