# Example payloads

Mock stdin payloads for driving the scripts by hand. Run them from the **repo
root**, because `transcript_path` is relative:

```bash
node statusline.js          < examples/payload.json
node statusline.js          < examples/payload-minimal.json
CC_STATUSLINE_BUDGET=250 node statusline.js < examples/payload-api.json
node subagent-statusline.js < examples/subagent-payload.json
```

| File | What it exercises |
| --- | --- |
| `payload.json` | Everything populated: 1M context, effort, thinking, fast mode, worktree, both rate limits, a named agent. The extended window is also the case where `LngCtx` renders |
| `payload-minimal.json` | The null cases — `current_usage: null`, `rate_limits: null`, null percentages, no `effort`, no `workspace` |
| `payload-api.json` | A billed plan (API key, Bedrock, Vertex, Enterprise): no `rate_limits` at all, so the windows give way to `$/Mtok` and, with `CC_STATUSLINE_BUDGET` set, `Bgt`. Its 200k window is also the case where `LngCtx` is suppressed as a duplicate of `Ctx` |
| `subagent-payload.json` | Four agent-panel rows: two running, one completed, one failed with an unrecognised model id |
| `transcript.jsonl` | Nine records covering the transcript accumulator |

## Three things to know

**The numbers are internally consistent, and are meant to stay that way.**
`total_input_tokens` equals `input_tokens + cache_creation_input_tokens +
cache_read_input_tokens` (152,002, not a round 152,000), `used_percentage` is
that total over `context_window_size`, and `remaining_percentage` is its
complement. A fixture whose arithmetic disagrees with the host's would send
anyone debugging against it down a false trail — so if you change one of these
fields, change the others to match.


**`resets_at` is a fixed epoch and will be in the past.** Pace arrows and
`time until reset` are suppressed for a stale window, so a raw run of
`payload.json` shows `5h 90%` with nothing after it. That is correct behaviour,
not a bug. Rewrite both timestamps to live values to see the arrows.

**`transcript.jsonl` is built to prove the dedup.** It holds three distinct
responses, two of which are written more than once — exactly how a streamed
response lands in a real transcript, every copy carrying the same `usage`
object.

| | Output | Fresh input | Cache creation | Cache read |
| --- | --- | --- | --- | --- |
| Naive sum over all records | 1350 | 14 | 3500 | 4000 |
| Deduped by message id | **750** | **8** | **1500** | **2500** |

So a correct run prints `Out 750` and `Cache 62%`. Printing `Out 1350` means
the dedup regressed. `test/run.js` asserts exactly this.
