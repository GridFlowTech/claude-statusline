# Example payloads

Mock stdin payloads for driving the scripts by hand. Run them from the **repo
root**, because `transcript_path` is relative:

```
node statusline.js          < examples/payload.json
node statusline.js          < examples/payload-minimal.json
node subagent-statusline.js < examples/subagent-payload.json
```

| File | What it exercises |
|---|---|
| `payload.json` | Everything populated: 1M context, effort, thinking, fast mode, worktree, both rate limits, a named agent |
| `payload-minimal.json` | The null cases — `current_usage: null`, `rate_limits: null`, null percentages, no `effort`, no `workspace` |
| `subagent-payload.json` | Four agent-panel rows: two running, one completed, one failed with an unrecognised model id |
| `transcript.jsonl` | Nine records covering the transcript accumulator |

## Two things to know

**`resets_at` is a fixed epoch and will be in the past.** Pace arrows and
`time until reset` are suppressed for a stale window, so a raw run of
`payload.json` shows `5h 90%` with nothing after it. That is correct behaviour,
not a bug. `node test/demo.js` rewrites both timestamps to live values and is
the right way to see the arrows.

**`transcript.jsonl` is built to prove the dedup.** It holds three distinct
responses, two of which are written more than once — exactly how a streamed
response lands in a real transcript, every copy carrying the same `usage`
object.

| | Output | Fresh input | Cache creation | Cache read |
|---|---|---|---|---|
| Naive sum over all records | 1350 | 14 | 3500 | 4000 |
| Deduped by message id | **750** | **8** | **1500** | **2500** |

So a correct run prints `Out 750` and `Cache 62%`. Printing `Out 1350` means
the dedup regressed. `test/run.js` asserts exactly this.
