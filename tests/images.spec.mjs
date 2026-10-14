/**
 * Image-attachment tests: the plumbing between DSH's base64 data URLs and
 * the CLI's `--attachment <file>`.
 *
 * The unit half never spawns anything — it checks what
 * `materializeImageAttachments` writes and what `disposeImageAttachments`
 * removes. The integration half drives `qoderChatStream` against the stub CLI
 * and asserts on the argv it actually received, which is the only place the
 * two surfaces are proven to line up.
 *
 * Zero-dependency: `node --test`, run against the built `lib/`.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  disposeImageAttachments,
  materializeImageAttachments,
  qoderChatStream,
} from '../lib/index.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const STUB = path.join(HERE, 'fixtures', 'fake-qodercli.mjs')

/** Redirect the dsh home so ledger writes never touch the real one. */
process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-qoder-img-home-'))

/** A 1x1 transparent PNG, the smallest real image there is. */
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
)
const PNG_URL = `data:image/png;base64,${PNG_BYTES.toString('base64')}`

/** A temp home with an OAuth login state file present. */
function signedInHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-qoder-img-'))
  fs.mkdirSync(path.join(dir, '.qoder-cn', '.auth'), { recursive: true })
  fs.writeFileSync(path.join(dir, '.qoder-cn', '.auth', 'user'), '{}')
  return dir
}

/** One message whose content is a single image part. */
function imageMessage(url = PNG_URL) {
  return [{ role: 'user', content: [{ type: 'image_url', image_url: { url } }] }]
}

/** Run one chat turn against the stub, capturing the argv it was handed. */
async function runWithEcho(messages) {
  const echo = path.join(os.tmpdir(), `dsh-qoder-img-echo-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
  const previous = process.env.QODER_STUB_ECHO
  process.env.QODER_STUB_ECHO = echo
  try {
    const chunks = []
    for await (const chunk of qoderChatStream(
      { model: 'qoder-qwen3.7-max', messages },
      { command: process.execPath, prefixArgs: [STUB], homeDir: signedInHome() },
    )) {
      chunks.push(chunk)
    }
    assert.equal(chunks[chunks.length - 1].choices[0].finish_reason, 'stop')
    return JSON.parse(fs.readFileSync(echo, 'utf8'))
  } finally {
    if (previous === undefined) delete process.env.QODER_STUB_ECHO
    else process.env.QODER_STUB_ECHO = previous
    fs.rmSync(echo, { force: true })
  }
}

test('a base64 image data URL becomes a temp file with the right extension', async () => {
  const material = await materializeImageAttachments(imageMessage())
  try {
    assert.equal(material.paths.length, 1)
    assert.equal(material.skipped, 0)
    assert.equal(path.extname(material.paths[0]), '.png')
    // The bytes on disk are the decoded image, not the base64 text.
    assert.deepEqual(fs.readFileSync(material.paths[0]), PNG_BYTES)
  } finally {
    await disposeImageAttachments(material.paths)
  }
})

test('every materialized image lives under the OS temp directory', async () => {
  const material = await materializeImageAttachments(imageMessage())
  try {
    const root = fs.realpathSync(os.tmpdir())
    const parent = fs.realpathSync(path.dirname(material.paths[0]))
    assert.ok(parent.startsWith(root), `${parent} is not under ${root}`)
  } finally {
    await disposeImageAttachments(material.paths)
  }
})

test('a text-only request materializes nothing', async () => {
  const material = await materializeImageAttachments([{ role: 'user', content: 'hello' }])
  assert.deepEqual(material.paths, [])
  assert.equal(material.skipped, 0)
})

test('a remote image URL is skipped rather than fetched', async () => {
  // The plugin makes no upstream HTTP request anywhere; an http(s) image is
  // therefore something it cannot serve, and must not look like a hang.
  const material = await materializeImageAttachments(
    imageMessage('https://example.com/cat.png'),
  )
  assert.deepEqual(material.paths, [])
  assert.equal(material.skipped, 1)
})

test('a non-base64 data URL is skipped', async () => {
  const material = await materializeImageAttachments(
    imageMessage('data:image/png,not-base64-bytes'),
  )
  assert.deepEqual(material.paths, [])
  assert.equal(material.skipped, 1)
})

test('an unsupported media type is skipped', async () => {
  const material = await materializeImageAttachments(
    imageMessage(`data:image/tiff;base64,${PNG_BYTES.toString('base64')}`),
  )
  assert.deepEqual(material.paths, [])
  assert.equal(material.skipped, 1)
})

test('a payload that is not really base64 is skipped, not written as garbage', async () => {
  // `Buffer.from` accepts arbitrary text and re-encodes it lossily, so a
  // non-base64 string would otherwise land on disk as a corrupt file.
  const material = await materializeImageAttachments(
    imageMessage('data:image/png;base64,!!!!not base64 at all!!!!'),
  )
  assert.deepEqual(material.paths, [])
  assert.equal(material.skipped, 1)
})

test('an empty image payload is skipped', async () => {
  const material = await materializeImageAttachments(imageMessage('data:image/png;base64,'))
  assert.deepEqual(material.paths, [])
  assert.equal(material.skipped, 1)
})

test('an image past the size ceiling is skipped', async () => {
  // 12M base64 characters decode to 9MB, past the module's own 8MB ceiling.
  // The ceiling is independent of the host's per-request budget so a
  // malformed or hostile body cannot fill the temp volume.
  const huge = 'A'.repeat(12 * 1024 * 1024)
  const material = await materializeImageAttachments(
    imageMessage(`data:image/png;base64,${huge}`),
  )
  try {
    assert.deepEqual(material.paths, [])
    assert.equal(material.skipped, 1)
  } finally {
    await disposeImageAttachments(material.paths)
  }
})

test('a line-wrapped base64 data URL still decodes', async () => {
  // Some encoders wrap base64 at 76 columns. The round-trip check must not
  // mistake the wrapping for corruption.
  const wrapped = PNG_BYTES.toString('base64').replace(/(.{20})/g, '$1\n')
  const material = await materializeImageAttachments(imageMessage(`data:image/png;base64,${wrapped}`))
  try {
    assert.equal(material.paths.length, 1)
    assert.equal(material.skipped, 0)
    assert.deepEqual(fs.readFileSync(material.paths[0]), PNG_BYTES)
  } finally {
    await disposeImageAttachments(material.paths)
  }
})

test('the per-request image count is capped', async () => {
  const messages = [{
    role: 'user',
    content: Array.from({ length: 20 }, () => ({ type: 'image_url', image_url: { url: PNG_URL } })),
  }]
  const material = await materializeImageAttachments(messages)
  try {
    assert.equal(material.paths.length, 16)
    assert.equal(material.skipped, 4)
  } finally {
    await disposeImageAttachments(material.paths)
  }
})

test('the Anthropic-style inline source spelling is accepted', async () => {
  const material = await materializeImageAttachments([{
    role: 'user',
    content: [{
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: PNG_BYTES.toString('base64') },
    }],
  }])
  try {
    assert.equal(material.paths.length, 1)
    assert.equal(path.extname(material.paths[0]), '.png')
    assert.deepEqual(fs.readFileSync(material.paths[0]), PNG_BYTES)
  } finally {
    await disposeImageAttachments(material.paths)
  }
})

test('images are collected across every message, in order', async () => {
  const material = await materializeImageAttachments([
    { role: 'user', content: [{ type: 'image_url', image_url: { url: PNG_URL } }] },
    { role: 'user', content: 'and a second one:' },
    { role: 'user', content: [{ type: 'image_url', image_url: { url: PNG_URL } }] },
  ])
  try {
    assert.equal(material.paths.length, 2)
    // Both come from the same run, so they share one parent directory.
    assert.equal(path.dirname(material.paths[0]), path.dirname(material.paths[1]))
  } finally {
    await disposeImageAttachments(material.paths)
  }
})

test('disposeImageAttachments removes the files and their directory', async () => {
  const material = await materializeImageAttachments(imageMessage())
  assert.equal(material.paths.length, 1)
  const dir = path.dirname(material.paths[0])
  await disposeImageAttachments(material.paths)
  assert.equal(fs.existsSync(material.paths[0]), false)
  assert.equal(fs.existsSync(dir), false, 'the run scratch directory must go too')
})

test('disposeImageAttachments tolerates an empty list and missing files', async () => {
  await assert.doesNotReject(disposeImageAttachments([]))
  await assert.doesNotReject(
    disposeImageAttachments([path.join(os.tmpdir(), 'dsh-qoder-connect-does-not-exist.png')]),
  )
})

test('the CLI receives one --attachment per image, before the -- separator', async () => {
  const argv = await runWithEcho([
    { role: 'user', content: '第一张' },
    { role: 'user', content: [{ type: 'image_url', image_url: { url: PNG_URL } }] },
    { role: 'user', content: [{ type: 'image_url', image_url: { url: PNG_URL } }] },
  ])
  const separator = argv.indexOf('--')
  assert.ok(separator > 0, 'the prompt must stay behind the -- separator')
  const attachments = []
  for (let index = 0; index < separator; index += 1) {
    if (argv[index] === '--attachment') attachments.push(argv[index + 1])
  }
  assert.equal(attachments.length, 2)
  // The paths are real files at spawn time, with the extension the CLI needs.
  for (const file of attachments) {
    assert.ok(fs.existsSync(file), `${file} should exist while the CLI runs`)
    assert.equal(path.extname(file), '.png')
  }
})

test('a text-only request sends no --attachment at all', async () => {
  const argv = await runWithEcho([{ role: 'user', content: 'ping' }])
  assert.equal(argv.includes('--attachment'), false)
})

test('a request whose images could not be materialized still runs as text', async () => {
  // Degrade, do not fail: an unfetchable remote image must not cost the turn.
  const argv = await runWithEcho([
    { role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.com/x.png' } }] },
    { role: 'user', content: 'describe it' },
  ])
  assert.equal(argv.includes('--attachment'), false)
  assert.ok(argv[argv.length - 1].includes('describe it'))
})

test('the prompt still carries the text that rode alongside the image', async () => {
  const argv = await runWithEcho([
    { role: 'user', content: [
      { type: 'text', text: '图里有什么文字？' },
      { type: 'image_url', image_url: { url: PNG_URL } },
    ] },
  ])
  assert.ok(argv[argv.length - 1].includes('图里有什么文字？'))
  assert.ok(argv.includes('--attachment'))
})

test('a finished run leaves no image files behind', async () => {
  const echo = path.join(os.tmpdir(), `dsh-qoder-img-clean-${Date.now()}.json`)
  const previous = process.env.QODER_STUB_ECHO
  process.env.QODER_STUB_ECHO = echo
  let seen = []
  try {
    for await (const _chunk of qoderChatStream(
      {
        model: 'qoder-qwen3.7-max',
        messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: PNG_URL } }] }],
      },
      { command: process.execPath, prefixArgs: [STUB], homeDir: signedInHome() },
    )) {
      // Capture the attachment path the stub was handed, then keep going.
      if (seen.length === 0) {
        const argv = JSON.parse(fs.readFileSync(echo, 'utf8'))
        for (let index = 0; index < argv.length; index += 1) {
          if (argv[index] === '--attachment') seen.push(argv[index + 1])
        }
      }
    }
  } finally {
    if (previous === undefined) delete process.env.QODER_STUB_ECHO
    else process.env.QODER_STUB_ECHO = previous
    fs.rmSync(echo, { force: true })
  }
  assert.equal(seen.length, 1)
  // Disposal is fire-and-forget inside the run, so give it a beat to land.
  await new Promise(resolve => setTimeout(resolve, 250))
  assert.equal(fs.existsSync(seen[0]), false, 'the temp image must be cleaned up')
  assert.equal(fs.existsSync(path.dirname(seen[0])), false)
})
