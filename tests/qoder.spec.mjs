/**
 * Unit tests for the ported qoder reverse-proxy core. Zero-dependency:
 * `node --test`, run against the built `lib/`.
 *
 * The CLI is never really invoked for chat in these tests — a stub script
 * stands in for `qoderclicn` through the same `command` + `prefixArgs`
 * options the real path uses, so the spawn, stream-json parsing, and
 * aggregation logic is exercised end to end without a Qoder account.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  QODER_MODELS,
  QODER_TIMEOUT_MS,
  QODER_MAX_THINKING_BUDGET,
  QODER_REASONING_EFFORTS,
  QODER_THINKING_MODES,
  QoderCatalog,
  aggregateQoderChunks,
  appendQoderLedgerEntry,
  buildCliPrompt,
  buildReasoningArgs,
  cliModelFor,
  clearQoderCliCache,
  createQoderAdapter,
  fetchQoderModels,
  parseCliDelta,
  parseCliResult,
  parseListModelsOutput,
  parseReasoningPatch,
  qoderChatStream,
  qoderExternalId,
  qoderLedgerPath,
  qoderOauthUserCandidates,
  qoderOauthUserPath,
  qoderStatus,
  parseCatalogDocument,
} from '../lib/index.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const STUB = path.join(HERE, 'fixtures', 'fake-qodercli.mjs')

/** A temp home directory with or without an OAuth login state file. */
function tempHome(withLogin) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-qoder-test-'))
  if (withLogin) {
    fs.mkdirSync(path.join(dir, '.qoder-cn', '.auth'), { recursive: true })
    fs.writeFileSync(path.join(dir, '.qoder-cn', '.auth', 'user'), '{}')
  }
  return dir
}

/** Options pointing every qoder call at the stub CLI. */
function stubOptions(overrides = {}) {
  return {
    command: process.execPath,
    prefixArgs: [STUB],
    homeDir: tempHome(true),
    ...overrides,
  }
}

test.beforeEach(() => {
  clearQoderCliCache()
})

test('the built-in fallback roster matches qoderclicn --list-models (CLI 1.1.59)', () => {
  // The fallback must stay a faithful copy of what the CLI reported at
  // release time: it is what serves when the live fetch cannot answer.
  const expected = [
    'Auto', 'Qwen3.8-Max', 'Qwen3.8-Flash', 'Qwen3.7-Max', 'Qwen3.7-Plus', 'Qwen3.7-Flash',
    'DeepSeek-V4-Pro', 'DeepSeek-Flash', 'GLM-5.3', 'GLM-5.3-Flash', 'GLM-5.2',
    'Kimi-K3', 'Kimi-K2.8-Preview', 'MiniMax-M2.7',
  ]
  assert.deepEqual(QODER_MODELS.map(model => model.cliModel), expected)
  // Every DSH-facing id is unique and namespaced.
  const ids = QODER_MODELS.map(model => model.externalId)
  assert.equal(new Set(ids).size, ids.length)
  assert.ok(ids.every(id => id.startsWith('qoder-')))
})

test('cliModelFor maps both the external id and the CLI spelling', () => {
  assert.equal(cliModelFor('qoder-qwen3.8-max'), 'Qwen3.8-Max')
  assert.equal(cliModelFor('Qwen3.8-Max'), 'Qwen3.8-Max')
  assert.equal(cliModelFor('qoder-deepseek-v4-pro'), 'DeepSeek-V4-Pro')
})

test('qoderOauthUserPath prefers an existing candidate over the default', () => {
  const home = tempHome(false)
  const candidates = qoderOauthUserCandidates(home)
  assert.equal(qoderOauthUserPath({ homeDir: home }), candidates[0])
  const signedIn = tempHome(true)
  assert.equal(
    qoderOauthUserPath({ homeDir: signedIn }),
    path.join(signedIn, '.qoder-cn', '.auth', 'user'),
  )
})

test('qoderStatus: not ready when neither CLI nor login exists', () => {
  const status = qoderStatus({ command: 'dsh-qoder-nonexistent-cli-xyz', homeDir: tempHome(false) })
  assert.equal(status.ready, false)
  assert.equal(status.cli, null)
  assert.match(status.reason, /未找到 Qoder CLI/)
})

test('qoderStatus: not ready when the CLI resolves but nobody is signed in', () => {
  const status = qoderStatus({ command: process.execPath, homeDir: tempHome(false) })
  assert.equal(status.ready, false)
  assert.equal(status.cli, process.execPath)
  assert.equal(status.oauth, false)
  assert.match(status.reason, /未登录/)
})

test('qoderStatus: ready through the on-disk OAuth login', () => {
  const home = tempHome(true)
  const status = qoderStatus({ command: process.execPath, homeDir: home })
  assert.equal(status.ready, true)
  assert.equal(status.oauth, true)
  assert.equal(status.pat, false)
  assert.equal(status.oauthFile, path.join(home, '.qoder-cn', '.auth', 'user'))
})

test('qoderStatus: ready through a PAT when no OAuth state exists', () => {
  const status = qoderStatus({ command: process.execPath, homeDir: tempHome(false), pat: 'pat-for-test' })
  assert.equal(status.ready, true)
  assert.equal(status.oauth, false)
  assert.equal(status.pat, true)
  assert.match(status.reason, /QODERCN_PERSONAL_ACCESS_TOKEN/)
})

test('parseCliDelta extracts assistant text and ignores everything else', () => {
  assert.equal(parseCliDelta('not json'), null)
  assert.equal(parseCliDelta(JSON.stringify({ type: 'system', subtype: 'init' })), null)
  assert.equal(parseCliDelta(JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'thinking', thinking: 'hmm' }] },
  })), null)
  assert.equal(parseCliDelta(JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'OK' }] },
  })), 'OK')
  assert.equal(parseCliDelta(JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] },
  })), 'ab')
})

test('buildCliPrompt flattens history into one prompt plus a system string', () => {
  const { system, prompt, dropped, truncated } = buildCliPrompt([
    { role: 'system', content: 'be terse' },
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
    { role: 'user', content: [{ type: 'text', text: 'again' }] },
  ])
  assert.equal(system, 'be terse')
  assert.equal(prompt, 'hello\nhi\nagain')
  assert.equal(dropped, 0)
  assert.equal(truncated, false)
  assert.deepEqual(buildCliPrompt(undefined), { system: '', prompt: '', dropped: 0, truncated: false })
})

test('buildCliPrompt keeps the newest messages under the cap and marks the drop', () => {
  // A history far past the default 24k cap: 40 messages of ~1k chars each.
  const messages = Array.from({ length: 40 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `m${index}-${'x'.repeat(1000)}`,
  }))
  const built = buildCliPrompt(messages)
  assert.ok(built.prompt.length <= 24_000 + 200, `prompt was ${built.prompt.length} chars`)
  assert.ok(built.dropped > 0)
  // The boundary message is head-cut to spend the whole budget, so
  // `truncated` is true even though nothing else was lost.
  assert.equal(built.truncated, true)
  // The marker explains the gap, and the live tail survives.
  assert.match(built.prompt, /较早的 \d+ 条消息已省略/)
  assert.ok(built.prompt.includes('m39-'), 'the newest message is kept')
  assert.ok(!built.prompt.includes('m0-'), 'the oldest message is dropped')
})

test('buildCliPrompt truncates one oversized message instead of dropping it', () => {
  const built = buildCliPrompt([
    { role: 'user', content: 'y'.repeat(50_000) },
  ], { maxPromptChars: 5_000 })
  assert.ok(built.prompt.length <= 5_000)
  assert.ok(built.truncated)
  assert.match(built.prompt, /本条消息因长度限制被截断/)
  // The head survives — the ask usually leads.
  assert.ok(built.prompt.startsWith('y'))
})

test('buildCliPrompt caps the system prompt from its head', () => {
  const built = buildCliPrompt([
    { role: 'system', content: 's'.repeat(10_000) },
    { role: 'user', content: 'hi' },
  ], { maxSystemChars: 1_000 })
  assert.ok(built.system.length <= 1_000)
  assert.equal(built.truncated, true)
  assert.match(built.system, /系统提示因长度限制被截断/)
  assert.equal(built.prompt, 'hi')
})

test('buildCliPrompt honors and clamps the environment overrides', () => {
  const previous = process.env.QODER_MAX_PROMPT_CHARS
  try {
    process.env.QODER_MAX_PROMPT_CHARS = '6000'
    const built = buildCliPrompt([
      { role: 'user', content: 'a'.repeat(4_000) },
      { role: 'user', content: 'b'.repeat(4_000) },
      { role: 'user', content: 'c'.repeat(4_000) },
    ])
    assert.ok(built.prompt.length <= 6_000)
    // The oldest is dropped whole; the boundary one is head-cut; the newest survives.
    assert.ok(built.dropped >= 1)
    assert.equal(built.truncated, true)
    assert.ok(built.prompt.includes('c'))
    // A nonsensical override falls back to the default rather than breaking.
    process.env.QODER_MAX_PROMPT_CHARS = 'not-a-number'
    const fallback = buildCliPrompt([{ role: 'user', content: 'hi' }])
    assert.equal(fallback.prompt, 'hi')
    // An override past the argv budget is clamped, not honored.
    process.env.QODER_MAX_PROMPT_CHARS = '999999'
    const clamped = buildCliPrompt([{ role: 'user', content: 'c'.repeat(30_000) }])
    assert.ok(clamped.prompt.length <= 28_000)
  } finally {
    if (previous === undefined) delete process.env.QODER_MAX_PROMPT_CHARS
    else process.env.QODER_MAX_PROMPT_CHARS = previous
  }
})

test('a session-sized history still spawns the CLI (argv stays under the Windows limit)', async () => {
  // The regression this guards: a real session measured 360K flattened
  // characters, which made spawn fail with ENAMETOOLONG. The cap keeps the
  // built command line inside Windows' 32,767-char budget.
  const echo = path.join(os.tmpdir(), `dsh-qoder-echo-${Date.now()}.json`)
  const previous = process.env.QODER_STUB_ECHO
  process.env.QODER_STUB_ECHO = echo
  try {
    const messages = Array.from({ length: 60 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `m${index}-${'x'.repeat(2_000)}`,
    }))
    const chunks = []
    for await (const chunk of qoderChatStream(
      { model: 'qoder-qwen3.7-max', messages },
      stubOptions(),
    )) {
      chunks.push(chunk)
    }
    assert.equal(chunks[chunks.length - 1].choices[0].finish_reason, 'stop')
    const argv = JSON.parse(fs.readFileSync(echo, 'utf8'))
    const commandLine = argv.join(' ')
    assert.ok(commandLine.length < 32_767, `command line was ${commandLine.length} chars`)
    // The prompt argument itself is the capped one.
    const prompt = argv[argv.length - 1]
    assert.ok(prompt.length <= 24_000)
    assert.ok(prompt.includes('m59-'), 'the newest message survives')
  } finally {
    if (previous === undefined) delete process.env.QODER_STUB_ECHO
    else process.env.QODER_STUB_ECHO = previous
    fs.rmSync(echo, { force: true })
  }
})

test('qoderChatStream re-emits the stub CLI stream-json as OpenAI chunks', async () => {
  const chunks = []
  for await (const chunk of qoderChatStream(
    { model: 'qoder-qwen3.7-max', messages: [{ role: 'user', content: 'ping' }] },
    stubOptions(),
  )) {
    chunks.push(chunk)
  }
  assert.ok(chunks.length >= 2)
  const texts = chunks
    .map(chunk => chunk.choices[0]?.delta?.content)
    .filter(text => typeof text === 'string')
  assert.equal(texts.join(''), 'OK')
  const last = chunks[chunks.length - 1]
  assert.equal(last.choices[0].finish_reason, 'stop')
  assert.equal(last.object, 'chat.completion.chunk')
  assert.equal(last.model, 'Qwen3.7-Max')
  // One id across the whole run.
  assert.equal(new Set(chunks.map(chunk => chunk.id)).size, 1)
})

test('qoderChatStream defaults the model when the body omits one', async () => {
  const chunks = []
  for await (const chunk of qoderChatStream({ messages: [] }, stubOptions())) {
    chunks.push(chunk)
  }
  assert.equal(chunks[chunks.length - 1].model, 'Qwen3.7-Max')
})

test('aggregateQoderChunks joins content and estimates usage by chars/4', () => {
  const chunks = [
    { id: 'chatcmpl-x', object: 'chat.completion.chunk', created: 1, model: 'Qwen3.7-Max', choices: [{ index: 0, delta: { content: 'OK' }, finish_reason: null }] },
    { id: 'chatcmpl-x', object: 'chat.completion.chunk', created: 1, model: 'Qwen3.7-Max', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  ]
  const completion = aggregateQoderChunks(chunks, { messages: [{ role: 'user', content: '12345678' }] })
  assert.equal(completion.object, 'chat.completion')
  assert.equal(completion.choices[0].message.content, 'OK')
  assert.equal(completion.choices[0].message.role, 'assistant')
  assert.equal(completion.usage.prompt_tokens, 2)
  assert.equal(completion.usage.completion_tokens, 1)
  assert.equal(completion.usage.total_tokens, 3)
})

test('QODER_TIMEOUT_MS is a sane overall ceiling', () => {
  assert.equal(QODER_TIMEOUT_MS, 600_000)
})

test('parseCliResult extracts the credit-carrying result record', () => {
  assert.equal(parseCliResult('not json'), null)
  assert.equal(parseCliResult(JSON.stringify({ type: 'system', subtype: 'init' })), null)
  assert.equal(parseCliResult(JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'OK' }] },
  })), null)
  assert.deepEqual(parseCliResult(JSON.stringify({
    type: 'result',
    subtype: 'success',
    duration_ms: 3215,
    is_error: false,
    num_turns: 1,
    total_credits: 0.12812052,
  })), { credits: 0.12812052, ms: 3215, turns: 1, isError: false })
  // A result record without the credit field still parses; credits read 0.
  assert.deepEqual(parseCliResult(JSON.stringify({ type: 'result', is_error: true })), {
    credits: 0, ms: 0, turns: 0, isError: true,
  })
})

test('qoderChatStream reports the run once, with the CLI credits', async () => {
  const seen = []
  for await (const chunk of qoderChatStream(
    { model: 'qoder-qwen3.7-max', messages: [{ role: 'user', content: 'ping' }] },
    stubOptions({ onRunComplete: (result, model) => { seen.push({ result, model }) } }),
  )) {
    // drain
  }
  assert.equal(seen.length, 1)
  assert.equal(seen[0].model, 'Qwen3.7-Max')
  assert.equal(seen[0].result.credits, 0.12812052)
  assert.equal(seen[0].result.ms, 3215)
  assert.equal(seen[0].result.turns, 1)
  assert.equal(seen[0].result.isError, false)
})

test('qoderChatStream reports a failed run with zero credits', async () => {
  // A spawn that exits non-zero never produces a result record.
  const seen = []
  const failing = path.join(HERE, 'fixtures', 'failing-qodercli.mjs')
  await assert.rejects(async () => {
    for await (const chunk of qoderChatStream(
      { model: 'qoder-qwen3.7-max', messages: [] },
      stubOptions({ command: process.execPath, prefixArgs: [failing], onRunComplete: (result) => { seen.push(result) } }),
    )) {
      // drain
    }
  }, /exited/)
  assert.equal(seen.length, 1)
  assert.equal(seen[0].credits, 0)
  assert.equal(seen[0].isError, true)
})

test('the usage ledger appends one JSON line per run under DSH_HOME', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-qoder-home-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const file = qoderLedgerPath()
    assert.equal(file, path.join(home, 'qoder-credits', 'ledger.jsonl'))
    await appendQoderLedgerEntry({ ts: 1000, model: 'qoder-auto', cli: 'Auto', credits: 0.5, ms: 10, turns: 1, chars: 4, error: false })
    await appendQoderLedgerEntry({ ts: 2000, model: 'qoder-glm-5.3', cli: 'GLM-5.3', credits: 0.25, ms: 20, turns: 2, chars: 8, error: false })
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n')
    assert.equal(lines.length, 2)
    assert.deepEqual(JSON.parse(lines[0]), { ts: 1000, model: 'qoder-auto', cli: 'Auto', credits: 0.5, ms: 10, turns: 1, chars: 4, error: false })
    assert.deepEqual(JSON.parse(lines[1]), { ts: 2000, model: 'qoder-glm-5.3', cli: 'GLM-5.3', credits: 0.25, ms: 20, turns: 2, chars: 8, error: false })
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})

test('a failing ledger append never throws into the chat path', async () => {
  // Point DSH_HOME at a path that cannot hold the ledger (a regular file).
  const blocker = path.join(os.tmpdir(), `dsh-qoder-blocker-${Date.now()}`)
  fs.writeFileSync(blocker, 'not a directory')
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = blocker
  try {
    await appendQoderLedgerEntry({ ts: 1, model: 'qoder-auto', cli: 'Auto', credits: 0, ms: 0, turns: 0, chars: 0, error: false })
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    fs.rmSync(blocker, { force: true })
  }
})

test('buildReasoningArgs emits only the configured flags, in CLI order', () => {
  // Nothing configured: no flag at all, so the CLI's own default stands.
  assert.deepEqual(buildReasoningArgs(), [])
  assert.deepEqual(buildReasoningArgs({}), [])
  assert.deepEqual(buildReasoningArgs({ reasoningEffort: 'high' }), ['--reasoning-effort', 'high'])
  assert.deepEqual(buildReasoningArgs({ thinking: 'adaptive' }), ['--thinking', 'adaptive'])
  assert.deepEqual(buildReasoningArgs({ thinkingBudget: 4096 }), ['--thinking-budget', '4096'])
  assert.deepEqual(
    buildReasoningArgs({ reasoningEffort: 'max', thinking: 'enabled', thinkingBudget: 2048 }),
    ['--reasoning-effort', 'max', '--thinking', 'enabled', '--thinking-budget', '2048'],
  )
})

test('buildReasoningArgs drops values the CLI would reject fatally', () => {
  // The CLI exits with "Invalid reasoning effort: ..." rather than ignoring
  // an unknown level, so a bad value must never reach argv.
  assert.deepEqual(buildReasoningArgs({ reasoningEffort: 'bogus' }), [])
  assert.deepEqual(buildReasoningArgs({ thinking: 'bogus' }), [])
  assert.deepEqual(buildReasoningArgs({ thinkingBudget: 0 }), [])
  assert.deepEqual(buildReasoningArgs({ thinkingBudget: -5 }), [])
  assert.deepEqual(buildReasoningArgs({ thinkingBudget: Number.NaN }), [])
  // A budget past the ceiling is clamped rather than dropped.
  assert.deepEqual(buildReasoningArgs({ thinkingBudget: 99_999_999 }), ['--thinking-budget', String(QODER_MAX_THINKING_BUDGET)])
})

test('every advertised level survives the argv filter', () => {
  // The UI offers exactly these lists; if one were not accepted here the
  // control would silently do nothing.
  for (const level of QODER_REASONING_EFFORTS) {
    assert.deepEqual(buildReasoningArgs({ reasoningEffort: level }), ['--reasoning-effort', level], level)
  }
  for (const mode of QODER_THINKING_MODES) {
    assert.deepEqual(buildReasoningArgs({ thinking: mode }), ['--thinking', mode], mode)
  }
})

test('the reasoning flags reach the spawned CLI command line', async () => {
  const echo = path.join(os.tmpdir(), `dsh-qoder-reasoning-${Date.now()}.json`)
  const previous = process.env.QODER_STUB_ECHO
  process.env.QODER_STUB_ECHO = echo
  try {
    const chunks = []
    for await (const chunk of qoderChatStream(
      { model: 'qoder-qwen3.7-max', messages: [{ role: 'user', content: 'ping' }] },
      stubOptions({ reasoningEffort: 'xhigh', thinking: 'enabled', thinkingBudget: 8192 }),
    )) {
      chunks.push(chunk)
    }
    assert.equal(chunks[chunks.length - 1].choices[0].finish_reason, 'stop')
    const argv = JSON.parse(fs.readFileSync(echo, 'utf8'))
    assert.ok(argv.includes('--reasoning-effort'))
    assert.equal(argv[argv.indexOf('--reasoning-effort') + 1], 'xhigh')
    assert.ok(argv.includes('--thinking'))
    assert.equal(argv[argv.indexOf('--thinking') + 1], 'enabled')
    assert.ok(argv.includes('--thinking-budget'))
    assert.equal(argv[argv.indexOf('--thinking-budget') + 1], '8192')
  } finally {
    if (previous === undefined) delete process.env.QODER_STUB_ECHO
    else process.env.QODER_STUB_ECHO = previous
    fs.rmSync(echo, { force: true })
  }
})

test('an unconfigured run sends no reasoning flag at all', async () => {
  const echo = path.join(os.tmpdir(), `dsh-qoder-noreasoning-${Date.now()}.json`)
  const previous = process.env.QODER_STUB_ECHO
  process.env.QODER_STUB_ECHO = echo
  try {
    for await (const _chunk of qoderChatStream(
      { model: 'qoder-qwen3.7-max', messages: [{ role: 'user', content: 'ping' }] },
      stubOptions(),
    )) {
      // drain
    }
    const argv = JSON.parse(fs.readFileSync(echo, 'utf8'))
    assert.ok(!argv.includes('--reasoning-effort'))
    assert.ok(!argv.includes('--thinking'))
    assert.ok(!argv.includes('--thinking-budget'))
  } finally {
    if (previous === undefined) delete process.env.QODER_STUB_ECHO
    else process.env.QODER_STUB_ECHO = previous
    fs.rmSync(echo, { force: true })
  }
})

test('a per-request reasoning_effort overrides the configured global level', async () => {
  // This is the model-picker path: pi-ai sends the picked thinkingLevelMap
  // spelling as `reasoning_effort` in the body, and it must win over the
  // plugin-level default for this run only.
  const echo = path.join(os.tmpdir(), `dsh-qoder-wireffort-${Date.now()}.json`)
  const previous = process.env.QODER_STUB_ECHO
  process.env.QODER_STUB_ECHO = echo
  try {
    for await (const _chunk of qoderChatStream(
      { model: 'qoder-qwen3.7-max', messages: [{ role: 'user', content: 'ping' }], reasoning_effort: 'max' },
      stubOptions({ reasoningEffort: 'low' }),
    )) {
      // drain
    }
    const argv = JSON.parse(fs.readFileSync(echo, 'utf8'))
    assert.equal(argv[argv.indexOf('--reasoning-effort') + 1], 'max')

    // A spelling outside the CLI vocabulary falls back to the configured
    // global rather than being dropped (or worse, forwarded fatally).
    for await (const _chunk of qoderChatStream(
      { model: 'qoder-qwen3.7-max', messages: [{ role: 'user', content: 'ping' }], reasoning_effort: 'bogus' },
      stubOptions({ reasoningEffort: 'low' }),
    )) {
      // drain
    }
    const fallbackArgv = JSON.parse(fs.readFileSync(echo, 'utf8'))
    assert.equal(fallbackArgv[fallbackArgv.indexOf('--reasoning-effort') + 1], 'low')
  } finally {
    if (previous === undefined) delete process.env.QODER_STUB_ECHO
    else process.env.QODER_STUB_ECHO = previous
    fs.rmSync(echo, { force: true })
  }
})

test('adapter models declare no reasoning until the official catalog is read', async () => {
  // With no catalog the adapter must still serve every model, just without a
  // reasoning control: declaring the full CLI vocabulary would offer levels
  // the upstream silently ignores (it does not reject an unsupported
  // `reasoning_effort`, it falls back to the model's default), so a level the
  // picker shows must be one the model actually accepts. Before the catalog
  // is known there is nothing truthful to declare.
  const { adapter } = createQoderAdapter({
    shim: { baseUrl: () => 'http://127.0.0.1:1', token: () => 'secret' },
    catalog: { current: () => QODER_MODELS.map(m => ({ id: m.externalId, name: m.cliModel })) },
  })
  for (const model of QODER_MODELS) {
    const info = await adapter.resolveModel('qoder', model.externalId)
    assert.equal(info.reasoning, undefined, `${model.externalId} offers no reasoning control without facts`)
    // The model itself is still served — the capability, not the model, is
    // what is withheld.
    assert.equal(info.id, model.externalId)
  }
})

test('adapter models declare exactly the levels the official catalog grants', async () => {
  // The catalog is what makes the control truthful: these are the levels the
  // upstream genuinely accepts per model, taken from its own document.
  const doc = JSON.stringify({
    chat: [
      {
        key: 'qmodel_38max',
        display_name: 'Qwen3.8-Max',
        price_factor: 0.2,
        context_config: { '200K': { token_count: 200000, is_default: true } },
        thinking_config: { enabled: { is_default: true, efforts: { low: {}, medium: { is_default: true }, xhigh: {} } } },
      },
      {
        key: 'dfmodel',
        display_name: 'DeepSeek-Flash',
        price_factor: 0.1,
        thinking_config: { enabled: { efforts: { low: {}, high: {}, max: { is_default: true } } } },
      },
      { key: 'qmodel_latest', display_name: 'Qwen3.7-Max', price_factor: 0.5 },
    ],
  })
  const facts = parseCatalogDocument(doc)
  const { adapter } = createQoderAdapter({
    shim: { baseUrl: () => 'http://127.0.0.1:1', token: () => 'secret' },
    catalog: {
      current: () => [
        { id: 'qoder-qwen3.8-max', name: 'Qwen3.8-Max' },
        { id: 'qoder-deepseek-flash', name: 'DeepSeek-Flash' },
        { id: 'qoder-qwen3.7-max', name: 'Qwen3.7-Max' },
      ],
    },
    modelFacts: () => facts,
  })

  const qwen = await adapter.resolveModel('qoder', 'qoder-qwen3.8-max')
  assert.deepEqual(qwen.reasoning.efforts.map(e => e.id), ['low', 'medium', 'xhigh'])
  assert.ok(!qwen.reasoning.efforts.some(e => e.id === 'high'), 'high is not offered for this model')
  assert.equal(qwen.context.contextWindow, 200000)

  const deepseek = await adapter.resolveModel('qoder', 'qoder-deepseek-flash')
  assert.deepEqual(deepseek.reasoning.efforts.map(e => e.id), ['low', 'high', 'max'])

  // A model the catalog gives no discrete levels gets no control at all,
  // rather than one whose every option the upstream would ignore.
  const onOffOnly = await adapter.resolveModel('qoder', 'qoder-qwen3.7-max')
  assert.equal(onOffOnly.reasoning, undefined)
})

test('parseReasoningPatch accepts the CLI vocabularies and rejects anything else', () => {
  assert.deepEqual(parseReasoningPatch({ reasoningEffort: 'high' }), { patch: { reasoningEffort: 'high' } })
  assert.deepEqual(parseReasoningPatch({ thinking: 'disabled' }), { patch: { thinking: 'disabled' } })
  assert.deepEqual(parseReasoningPatch({ thinkingBudget: 1024 }), { patch: { thinkingBudget: 1024 } })
  // '' clears the field rather than selecting an invalid level.
  assert.deepEqual(parseReasoningPatch({ reasoningEffort: '' }), { patch: { reasoningEffort: '' } })
  assert.deepEqual(parseReasoningPatch({ thinking: null }), { patch: { thinking: '' } })
  assert.deepEqual(parseReasoningPatch({ thinkingBudget: null }), { patch: { thinkingBudget: 0 } })
  // Unknown level: refused with a message naming the accepted values.
  const bad = parseReasoningPatch({ reasoningEffort: 'bogus' })
  assert.ok('error' in bad)
  assert.ok(bad.error.includes('ultracode'))
  assert.ok('error' in parseReasoningPatch({ thinking: 'bogus' }))
  assert.ok('error' in parseReasoningPatch({ thinkingBudget: -1 }))
  assert.ok('error' in parseReasoningPatch({ thinkingBudget: 1.5 }))
  assert.ok('error' in parseReasoningPatch({ thinkingBudget: 99_999_999 }))
  assert.ok('error' in parseReasoningPatch([]))
  assert.ok('error' in parseReasoningPatch('nope'))
})

test('parseListModelsOutput reads the CLI table and derives stable ids', () => {
  const roster = parseListModelsOutput('MODEL\nAuto\nFast\nQwen3.8-Max\nGLM-5.3-Flash\n')
  assert.deepEqual(roster, [
    { externalId: 'qoder-auto', cliModel: 'Auto' },
    { externalId: 'qoder-fast', cliModel: 'Fast' },
    { externalId: 'qoder-qwen3.8-max', cliModel: 'Qwen3.8-Max' },
    { externalId: 'qoder-glm-5.3-flash', cliModel: 'GLM-5.3-Flash' },
  ])
  // CRLF, a trailing blank line and stray padding are all tolerated.
  assert.deepEqual(parseListModelsOutput('\r\nMODEL\r\n  Auto  \r\n\r\n').length, 1)
})

test('every shipped id follows the qoder-<lowercased name> rule', () => {
  // The fetch path derives ids this way, so the built-in fallback must agree
  // or a model's id would change depending on where the roster came from —
  // which would also orphan its rows in the usage ledger.
  for (const model of QODER_MODELS) {
    assert.equal(model.externalId, qoderExternalId(model.cliModel), model.cliModel)
  }
  assert.equal(qoderExternalId('  Kimi-K3  '), 'qoder-kimi-k3')
})

test('parseListModelsOutput drops noise and refuses an unusable roster', () => {
  // Duplicates (case-insensitively, since the id lowercases) collapse.
  const deduped = parseListModelsOutput('MODEL\nAuto\nauto\nAUTO\n')
  assert.equal(deduped.length, 1)
  // Header spellings, separators and error banners are not model names.
  const noisy = parseListModelsOutput('MODEL\nname\n---\nerror: not signed in\nusage: qoderclicn\nAuto\n')
  assert.deepEqual(noisy, [{ externalId: 'qoder-auto', cliModel: 'Auto' }])
  // Nothing usable: null, so the caller keeps the roster it already has
  // rather than emptying the group out of the picker.
  assert.equal(parseListModelsOutput(''), null)
  assert.equal(parseListModelsOutput('MODEL\n'), null)
  assert.equal(parseListModelsOutput('\n  \n'), null)
})

test('a model the CLI adds later is served without a plugin change', async () => {
  // The point of the live fetch: Qoder shipping a new model must reach the
  // picker on its own. Qwen9-Ultra exists only in this stub's answer.
  const previous = process.env.QODER_STUB_MODELS
  process.env.QODER_STUB_MODELS = 'Auto\nQwen9-Ultra\n'
  try {
    const live = await fetchQoderModels(stubOptions())
    assert.deepEqual(live?.map(model => model.cliModel), ['Auto', 'Qwen9-Ultra'])
    const catalog = new QoderCatalog()
    assert.ok(!catalog.all().some(entry => entry.name === 'Qwen9-Ultra'), 'not in the built-in list')
    assert.equal(catalog.setModels(live, 'cli'), true)
    assert.ok(catalog.all().some(entry => entry.id === 'qoder-qwen9-ultra'))
  } finally {
    if (previous === undefined) delete process.env.QODER_STUB_MODELS
    else process.env.QODER_STUB_MODELS = previous
  }
})

test('fetchQoderModels returns the CLI roster', async () => {
  const models = await fetchQoderModels(stubOptions())
  assert.deepEqual(models?.map(model => model.cliModel), ['Auto', 'Fast', 'Qwen3.7-Max', 'GLM-5.3'])
  assert.equal(models?.[1].externalId, 'qoder-fast')
})

test('fetchQoderModels answers null instead of throwing on every failure', async () => {
  // A non-zero exit (an unusable CLI), an unparseable answer, and a CLI that
  // cannot be resolved at all all mean "keep what you have".
  const failing = stubOptions()
  const previousExit = process.env.QODER_STUB_MODELS_EXIT
  const previousModels = process.env.QODER_STUB_MODELS
  try {
    process.env.QODER_STUB_MODELS_EXIT = '1'
    assert.equal(await fetchQoderModels(failing), null)

    process.env.QODER_STUB_MODELS_EXIT = '0'
    process.env.QODER_STUB_MODELS = 'MODEL'
    assert.equal(await fetchQoderModels(failing), null)
  } finally {
    if (previousExit === undefined) delete process.env.QODER_STUB_MODELS_EXIT
    else process.env.QODER_STUB_MODELS_EXIT = previousExit
    if (previousModels === undefined) delete process.env.QODER_STUB_MODELS
    else process.env.QODER_STUB_MODELS = previousModels
  }

  clearQoderCliCache()
  assert.equal(await fetchQoderModels({ command: 'definitely-not-a-real-cli-xyz' }), null)
})

test('a CLI that never answers is timed out rather than hanging forever', async () => {
  const previous = process.env.QODER_STUB_MODELS_HANG
  process.env.QODER_STUB_MODELS_HANG = '1'
  // The stub ignores SIGTERM's default only in the sense that it has no
  // handler; the fetch must still settle on its own timer.
  const started = Date.now()
  try {
    const result = await fetchQoderModels(stubOptions())
    assert.equal(result, null)
    // Proves the timeout path ran rather than the child exiting on its own.
    assert.ok(Date.now() - started < 60_000, 'the fetch settled without waiting for the child')
  } finally {
    if (previous === undefined) delete process.env.QODER_STUB_MODELS_HANG
    else process.env.QODER_STUB_MODELS_HANG = previous
  }
}, { timeout: 90_000 })

test('the catalog swaps rosters, tracks their source, and refuses an empty one', () => {
  const catalog = new QoderCatalog()
  const builtinCount = catalog.all().length
  assert.equal(catalog.source(), 'builtin')
  assert.equal(catalog.setModels([]), false, 'an empty roster is refused')
  assert.equal(catalog.all().length, builtinCount, 'and leaves the roster alone')
  assert.equal(catalog.source(), 'builtin')

  assert.equal(catalog.setModels([{ externalId: 'qoder-fast', cliModel: 'Fast' }]), true)
  assert.equal(catalog.source(), 'cli')
  assert.deepEqual(catalog.all(), [{ id: 'qoder-fast', name: 'Fast' }])
  assert.deepEqual(catalog.current(), [], 'still hidden until made visible')
  assert.equal(catalog.setVisible(true), true)
  assert.equal(catalog.current().length, 1)

  // An identical roster reports no change, so a periodic refresh does not
  // churn the adapter snapshot.
  assert.equal(catalog.setModels([{ externalId: 'qoder-fast', cliModel: 'Fast' }]), false)
})
