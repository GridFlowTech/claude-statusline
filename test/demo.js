#!/usr/bin/env node
'use strict';
/* ============================================================================
 * Render the example payloads with live timestamps.
 *
 *   node test/demo.js
 *
 * The checked-in examples carry fixed `resets_at` epochs, which are in the past
 * by the time you read them -- and a stale window correctly suppresses its pace
 * arrow. This rewrites both windows to live values so the arrows actually show,
 * then renders each scenario at a few terminal widths.
 *
 * Uses a throwaway CLAUDE_CONFIG_DIR, so it never touches your real ledger.
 * ========================================================================== */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const MAIN = path.join(ROOT, 'statusline.js');
const SUB = path.join(ROOT, 'subagent-statusline.js');

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-demo-'));
const nowSec = Math.floor(Date.now() / 1000);
const nowMs = Date.now();

/** A window `usedPct` consumed with `elapsedFraction` of its duration gone. */
const window_ = (usedPct, durationSec, elapsedFraction) => ({
  used_percentage: usedPct,
  resets_at: nowSec + Math.round(durationSec * (1 - elapsedFraction)),
});

const FIVE_HOUR = 18000;
const SEVEN_DAY = 604800;

function render(script, payload, env = {}) {
  const res = spawnSync(process.execPath, [script], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    cwd: ROOT,
    env: { ...process.env, CLAUDE_CONFIG_DIR: sandbox, ...env },
  });
  return (res.stdout || '').replace(/\n$/, '');
}

function heading(text) {
  console.log(`\n\u001b[1m${text}\u001b[0m`);
  console.log('\u001b[2m' + '-'.repeat(text.length) + '\u001b[0m');
}

/* --- main statusline ---------------------------------------------------- */

const base = JSON.parse(fs.readFileSync(path.join(ROOT, 'examples', 'payload.json'), 'utf8'));
base.transcript_path = path.join(ROOT, 'examples', 'transcript.jsonl');

const scenarios = [
  {
    title: 'Burning fast on the 5h window, on pace for the 7d',
    payload: {
      ...base,
      session_id: 'demo-burn',
      rate_limits: {
        five_hour: window_(90, FIVE_HOUR, 0.2),
        seven_day: window_(52, SEVEN_DAY, 0.5),
      },
    },
  },
  {
    title: 'Comfortable: under-consuming both windows',
    payload: {
      ...base,
      session_id: 'demo-calm',
      exceeds_200k_tokens: false,
      rate_limits: {
        five_hour: window_(6, FIVE_HOUR, 0.35),
        seven_day: window_(1, SEVEN_DAY, 0.18),
      },
    },
  },
  {
    title: 'Past the 200k long-context threshold (LngCtx label turns red)',
    payload: {
      ...base,
      session_id: 'demo-long',
      exceeds_200k_tokens: true,
      context_window: { ...base.context_window, total_input_tokens: 240000, used_percentage: 24 },
      rate_limits: {
        five_hour: window_(55, FIVE_HOUR, 0.5),
        seven_day: window_(30, SEVEN_DAY, 0.4),
      },
    },
  },
  {
    title: 'Cold session: no API call yet, no rate limits, no transcript',
    payload: JSON.parse(fs.readFileSync(path.join(ROOT, 'examples', 'payload-minimal.json'), 'utf8')),
  },
];

for (const { title, payload } of scenarios) {
  heading(title);
  console.log(render(MAIN, payload));
}

heading('Width adaptation (same payload, narrowing terminal)');
for (const cols of [120, 96, 74, 56, 38]) {
  console.log(`\u001b[2mCOLUMNS=${cols}\u001b[0m`);
  console.log(render(MAIN, { ...scenarios[0].payload, session_id: `demo-w${cols}` }, { COLUMNS: String(cols) }));
  console.log('');
}

heading('ASCII glyph mode (CC_STATUSLINE_ASCII=1)');
console.log(render(MAIN, { ...scenarios[0].payload, session_id: 'demo-ascii' }, { CC_STATUSLINE_ASCII: '1' }));

/* --- subagent statusline ------------------------------------------------ */

const sub = JSON.parse(fs.readFileSync(path.join(ROOT, 'examples', 'subagent-payload.json'), 'utf8'));
// Anchor the start times to now so the age column is meaningful.
const ages = [72000, 9000, 3600000, 0];
sub.tasks.forEach((t, i) => { if (t.startTime) t.startTime = nowMs - ages[i]; });

heading('Subagent panel');
for (const line of render(SUB, sub).split('\n')) {
  if (!line) continue;
  const { content } = JSON.parse(line);
  console.log(content || '\u001b[2m(row hidden)\u001b[0m');
}

console.log('');
try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* best effort */ }
