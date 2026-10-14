/**
 * One-off live check: run a real chat completion through the shim against
 * the machine's own qoderclicn login. Not part of the test suite (it needs
 * a signed-in Qoder account and spends a request).
 *
 *   node scripts/live-chat-check.mjs [model]
 */

import { createQoderShim } from '../lib/index.js'

const model = process.argv[2] ?? 'qoder-qwen3.7-max'
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
      model,
      stream: true,
      messages: [{ role: 'user', content: '用一句话介绍你自己' }],
    }),
  })
  process.stdout.write(`HTTP ${response.status} ${response.headers.get('content-type')}\n`)
  if (!response.ok) {
    process.stdout.write(`${await response.text()}\n`)
    process.exitCode = 1
  } else {
    let content = ''
    for await (const piece of response.body) {
      const text = Buffer.from(piece).toString('utf8')
      for (const line of text.split('\n')) {
        if (!line.startsWith('data: ') || line === 'data: [DONE]') continue
        const chunk = JSON.parse(line.slice(6))
        const delta = chunk.choices?.[0]?.delta?.content
        if (typeof delta === 'string') content += delta
      }
    }
    process.stdout.write(`assistant: ${content}\n`)
  }
} finally {
  await shim.close()
}
