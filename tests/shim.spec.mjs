/**
 * Loopback-shim tests: the OpenAI-compatible HTTP surface over the stub
 * CLI, including the inbound hardening (loopback Host, bearer secret).
 * Zero-dependency: `node --test`, run against the built `lib/`.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { QODER_MODELS, createQoderShim } from '../lib/index.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const STUB = path.join(HERE, 'fixtures', 'fake-qodercli.mjs')

/**
 * Redirect the dsh home for this whole test file.
 *
 * Every chat test below completes a run, and every completed run appends to
 * the usage ledger — without this redirect the suite would write stub
 * entries into the real `$DSH_HOME/qoder-credits/ledger.jsonl`. The test
 * process is short-lived, so the override is never restored.
 */
const TEST_DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-qoder-home-'))
process.env.DSH_HOME = TEST_DSH_HOME

/** A temp home with an OAuth login state file present. */
function signedInHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-qoder-shim-'))
  fs.mkdirSync(path.join(dir, '.qoder-cn', '.auth'), { recursive: true })
  fs.writeFileSync(path.join(dir, '.qoder-cn', '.auth', 'user'), '{}')
  return dir
}

/** A temp home with no login state anywhere. */
function signedOutHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-qoder-shim-'))
}

async function withShim(options, body) {
  const shim = createQoderShim({ qoder: options })
  await shim.ready
  try {
    return await body(shim)
  } finally {
    await shim.close()
  }
}

test('GET /v1/models lists the qoder roster for a bearer client', async () => {
  await withShim({ command: process.execPath, prefixArgs: [STUB], homeDir: signedInHome() }, async shim => {
    const response = await fetch(`${shim.baseUrl()}/v1/models`, {
      headers: { authorization: `Bearer ${shim.token()}` },
    })
    assert.equal(response.status, 200)
    const payload = await response.json()
    assert.equal(payload.object, 'list')
    assert.equal(payload.data.length, QODER_MODELS.length)
    assert.deepEqual(payload.data[0], { id: 'qoder-auto', object: 'model', created: 0, owned_by: 'qoder' })
  })
})

test('requests without the shared secret are rejected', async () => {
  await withShim({ command: process.execPath, prefixArgs: [STUB], homeDir: signedInHome() }, async shim => {
    const anonymous = await fetch(`${shim.baseUrl()}/v1/models`)
    assert.equal(anonymous.status, 401)
    const forged = await fetch(`${shim.baseUrl()}/v1/models`, {
      headers: { authorization: 'Bearer not-the-secret' },
    })
    assert.equal(forged.status, 401)
  })
})

test('GET /v1/models reports not-ready when nobody is signed in', async () => {
  await withShim({ command: process.execPath, prefixArgs: [STUB], homeDir: signedOutHome() }, async shim => {
    const response = await fetch(`${shim.baseUrl()}/v1/models`, {
      headers: { authorization: `Bearer ${shim.token()}` },
    })
    assert.equal(response.status, 401)
    const payload = await response.json()
    assert.match(payload.error.message, /未登录/)
  })
})

test('POST /v1/chat/completions streams SSE chunks terminated by [DONE]', async () => {
  await withShim({ command: process.execPath, prefixArgs: [STUB], homeDir: signedInHome() }, async shim => {
    const response = await fetch(`${shim.baseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${shim.token()}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'qoder-qwen3.7-max',
        stream: true,
        messages: [{ role: 'user', content: 'ping' }],
      }),
    })
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type'), /text\/event-stream/)
    const text = await response.text()
    const dataLines = text.split('\n').filter(line => line.startsWith('data: '))
    assert.ok(dataLines.length >= 2)
    assert.equal(dataLines[dataLines.length - 1], 'data: [DONE]')
    const chunks = dataLines.slice(0, -1).map(line => JSON.parse(line.slice('data: '.length)))
    const content = chunks.map(chunk => chunk.choices[0]?.delta?.content ?? '').join('')
    assert.equal(content, 'OK')
    assert.equal(chunks[chunks.length - 1].choices[0].finish_reason, 'stop')
  })
})

test('POST /v1/chat/completions aggregates one completion when not streaming', async () => {
  await withShim({ command: process.execPath, prefixArgs: [STUB], homeDir: signedInHome() }, async shim => {
    const response = await fetch(`${shim.baseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${shim.token()}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'qoder-glm-5.3',
        stream: false,
        messages: [{ role: 'user', content: 'ping' }],
      }),
    })
    assert.equal(response.status, 200)
    const payload = await response.json()
    assert.equal(payload.object, 'chat.completion')
    assert.equal(payload.choices[0].message.content, 'OK')
    assert.equal(payload.model, 'GLM-5.3')
    assert.ok(payload.usage.total_tokens >= 1)
  })
})

test('chat POSTs must be application/json', async () => {
  await withShim({ command: process.execPath, prefixArgs: [STUB], homeDir: signedInHome() }, async shim => {
    const response = await fetch(`${shim.baseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${shim.token()}` },
      body: 'model=qoder-auto',
    })
    assert.equal(response.status, 415)
  })
})

test('unknown routes are 404', async () => {
  await withShim({ command: process.execPath, prefixArgs: [STUB], homeDir: signedInHome() }, async shim => {
    const response = await fetch(`${shim.baseUrl()}/v1/nope`, {
      headers: { authorization: `Bearer ${shim.token()}` },
    })
    assert.equal(response.status, 404)
  })
})

test('a chat run appends one ledger line carrying the CLI credits', async () => {
  // The file-level DSH_HOME redirect above keeps every append inside the
  // temp home; the real ledger is never touched by the suite.
  const file = path.join(TEST_DSH_HOME, 'qoder-credits', 'ledger.jsonl')
  fs.rmSync(file, { force: true })
  await withShim({ command: process.execPath, prefixArgs: [STUB], homeDir: signedInHome() }, async shim => {
    const response = await fetch(`${shim.baseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${shim.token()}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'qoder-qwen3.7-max',
        stream: false,
        messages: [{ role: 'user', content: 'ping' }],
      }),
    })
    assert.equal(response.status, 200)
    await response.json()
    // The ledger append is fire-and-forget; give the chain a moment.
    const deadline = Date.now() + 3000
    let lines = []
    while (Date.now() < deadline) {
      try {
        lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(line => line !== '')
      } catch {
        lines = []
      }
      if (lines.length >= 1) break
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    assert.equal(lines.length, 1)
    const entry = JSON.parse(lines[0])
    assert.equal(entry.model, 'qoder-qwen3.7-max')
    assert.equal(entry.cli, 'Qwen3.7-Max')
    assert.equal(entry.credits, 0.12812052)
    assert.equal(entry.error, false)
    assert.equal(entry.chars, 4)
  })
})

