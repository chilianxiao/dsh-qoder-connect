/**
 * One-off regression check: rebuild this session's real conversation
 * history from its archived session file, send the tail through the shim
 * against the real qoderclicn login, and print what came back. Proves the
 * prompt cap makes a long session servable (the raw history is ~360K
 * characters, far past the Windows argv limit).
 *
 *   node scripts/session-replay-check.mjs [sessionFile]
 */

import fs from 'node:fs'
import zlib from 'node:zlib'
import { createQoderShim } from '../lib/index.js'

const file = process.argv[2]
if (file === undefined) {
  process.stderr.write('usage: node session-replay-check.mjs <session.v3.jsonl.zstd>\n')
  process.exit(1)
}

/** Decompress every zstd frame in the append-only session log. */
function decompressAll(raw) {
  const MAGIC = Buffer.from([0x28, 0xB5, 0x2F, 0xFD])
  const starts = []
  for (let i = 0; i <= raw.length - 4; i++) {
    if (raw[i] === MAGIC[0] && raw[i + 1] === MAGIC[1] && raw[i + 2] === MAGIC[2] && raw[i + 3] === MAGIC[3]) starts.push(i)
  }
  const parts = []
  for (let f = 0; f < starts.length; f++) {
    const frame = raw.subarray(starts[f], f + 1 < starts.length ? starts[f + 1] : raw.length)
    try {
      parts.push(zlib.zstdDecompressSync(frame).toString('utf8'))
    } catch {
      // skip an unreadable frame
    }
  }
  return parts.join('')
}

const text = decompressAll(fs.readFileSync(file))
const wire = []
for (const line of text.split('\n')) {
  if (line.trim() === '') continue
  let event
  try {
    event = JSON.parse(line)
  } catch {
    continue
  }
  if (event.type === 'system/message' || event.type === 'user/message' || event.type === 'assistant/message') {
    const message = event.data?.message
    if (message !== undefined) wire.push({ role: message.role, content: message.content })
  }
}

const flatten = (content) => (typeof content === 'string'
  ? content
  : Array.isArray(content)
    ? content.map(part => (typeof part?.text === 'string' ? part.text : '')).join('')
    : '')
const total = wire.reduce((sum, m) => sum + flatten(m.content).length, 0)
process.stdout.write(`session wire messages: ${wire.length}, flattened chars: ${total.toLocaleString()}\n`)

// Keep the live tail: the system prompt plus the last ~20 messages, the
// shape a real in-flight request would carry after DSH's own context
// handling.
const system = wire.filter(m => m.role === 'system')
const tail = wire.filter(m => m.role !== 'system').slice(-20)
const messages = [...system.slice(-1), ...tail]
process.stdout.write(`replaying ${messages.length} messages (system + last 20)\n`)

const shim = createQoderShim({})
await shim.ready
try {
  const response = await fetch(`${shim.baseUrl()}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${shim.token()}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'qoder-qwen3.7-max',
      stream: true,
      messages,
    }),
  })
  process.stdout.write(`HTTP ${response.status}\n`)
  if (!response.ok) {
    process.stdout.write(`${await response.text()}\n`)
    process.exitCode = 1
  } else {
    let content = ''
    for await (const piece of response.body) {
      for (const line of Buffer.from(piece).toString('utf8').split('\n')) {
        if (!line.startsWith('data: ') || line === 'data: [DONE]') continue
        const delta = JSON.parse(line.slice(6))?.choices?.[0]?.delta?.content
        if (typeof delta === 'string') content += delta
      }
    }
    process.stdout.write(`assistant: ${content.slice(0, 300)}\n`)
  }
} finally {
  await shim.close()
}
