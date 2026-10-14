#!/usr/bin/env node
/**
 * Stand-in for the `qoderclicn` CLI in tests.
 *
 * Invoked as `node fake-qodercli.mjs --print --output-format stream-json
 * --model <model> ... -- <prompt>` — the same argv shape qoderChatStream
 * builds — and prints the stream-json record shapes the real CLI emits:
 * a system init record (ignored), an assistant thinking record (ignored),
 * a final assistant text record, and the `result` record carrying the
 * run's credit cost.
 *
 * With `--list-models` it prints the roster instead, matching the real CLI's
 * header-plus-one-name-per-line format. `QODER_STUB_MODELS` overrides that
 * list (newline-separated), `QODER_STUB_MODELS_EXIT` makes the call fail, and
 * `QODER_STUB_MODELS_HANG=1` makes it never answer, so the fetch path's
 * error, timeout and empty-answer branches are all reachable without a login.
 *
 * With QODER_STUB_ECHO pointing at a file, the argv it was invoked with is
 * written there as JSON, so tests can assert on the built command line.
 */

import fs from 'node:fs'

if (process.env.QODER_STUB_ECHO !== undefined && process.env.QODER_STUB_ECHO !== '') {
  fs.writeFileSync(process.env.QODER_STUB_ECHO, JSON.stringify(process.argv))
}

if (process.argv.includes('--list-models')) {
  if (process.env.QODER_STUB_MODELS_HANG === '1') {
    // Never answer and never exit: exercises the fetch timeout.
    setInterval(() => {}, 1 << 30)
  } else {
    const exitCode = Number(process.env.QODER_STUB_MODELS_EXIT ?? 0)
    if (Number.isFinite(exitCode) && exitCode !== 0) process.exit(exitCode)
    const configured = process.env.QODER_STUB_MODELS
    const names = configured !== undefined && configured !== ''
      ? configured.split('\n')
      : ['Auto', 'Fast', 'Qwen3.7-Max', 'GLM-5.3']
    process.stdout.write('MODEL\n')
    for (const name of names) process.stdout.write(`${name}\n`)
    process.exit(0)
  }
}

const records = [
  { type: 'system', subtype: 'init', session_id: 'fake-session' },
  { type: 'assistant', message: { id: 'chatcmpl-fake', role: 'assistant', content: [{ type: 'thinking', thinking: '...' }] } },
  { type: 'assistant', message: { id: 'chatcmpl-fake', role: 'assistant', content: [{ type: 'text', text: 'OK' }] } },
  {
    type: 'result',
    subtype: 'success',
    duration_ms: 3215,
    is_error: false,
    num_turns: 1,
    result: 'OK',
    stop_reason: 'end_turn',
    total_cost_usd: 0,
    total_credits: 0.12812052,
  },
]

for (const record of records) {
  process.stdout.write(`${JSON.stringify(record)}\n`)
}
