/**
 * Unit tests for the official Qoder model catalog reader.
 *
 * `node --test`, run against the built `lib/`. No Qoder install is needed:
 * the QMC container is encrypted here with the same primitive the reader
 * decrypts with, so the round-trip is exercised for real (including the
 * auth-tag failure a wrong uid must produce).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createCipheriv, hkdfSync } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  decryptQmcCatalog,
  formatQoderPrice,
  loadQoderModelFacts,
  parseCatalogDocument,
  thinkingLevelMapFor,
} from '../lib/index.js'

/** Seal a document into a QMC v1 envelope, the way the official client does. */
function sealQmc(document, uid) {
  const key = Buffer.from(hkdfSync('sha256', Buffer.from(uid, 'utf8'),
    Buffer.from('qoder-model-cache-enc'), Buffer.from('model-cache-v1'), 32))
  const nonce = Buffer.alloc(12, 7)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  const body = Buffer.concat([cipher.update(Buffer.from(document, 'utf8')), cipher.final()])
  return Buffer.concat([
    Buffer.from('QMC\x01', 'latin1'), nonce, body, cipher.getAuthTag(),
  ]).toString('base64')
}

/** One catalog document shaped like the official client's. */
function docWithChat(models) {
  return JSON.stringify({ chat: models, developer: [] })
}

/** A model row with only the fields a test cares about. */
function modelRow(overrides) {
  return {
    key: 'k',
    display_name: 'Name',
    price_factor: 0.5,
    ...overrides,
  }
}

test('decryptQmcCatalog round-trips a sealed document and rejects a wrong uid', () => {
  const uid = '019feede-5753-753e-a7e2-24e473dc8a04'
  const document = docWithChat([modelRow({ display_name: 'Qwen3.7-Max' })])
  const sealed = sealQmc(document, uid)
  assert.equal(decryptQmcCatalog(sealed, uid), document)
  // The GCM tag is what makes a wrong key detectable rather than silent.
  assert.throws(() => decryptQmcCatalog(sealed, 'some-other-uid'))
  assert.throws(() => decryptQmcCatalog(Buffer.from('not qmc').toString('base64'), uid))
})

test('parseCatalogDocument reads the official price and promotion', () => {
  const doc = docWithChat([
    modelRow({
      key: 'qmodel_latest',
      display_name: 'Qwen3.7-Max',
      price_factor: 0.5,
      promotion: {
        discount_factor: 0.2,
        window_start: '22:00',
        window_end: '08:00',
        timezone: 'Asia/Shanghai',
        badge: { zh: '错峰2折', en: 'Off-Peak 80% off' },
      },
    }),
  ])
  const facts = parseCatalogDocument(doc).get('qwen3.7-max')
  assert.equal(facts.key, 'qmodel_latest')
  assert.equal(facts.priceFactor, 0.5)
  assert.equal(facts.promotion.discountFactor, 0.2)
  // The zh badge is preferred, to match this plugin's own copy language.
  assert.equal(facts.promotion.badge, '错峰2折')
  // A promotion without a usable factor is dropped rather than half-read.
  const broken = parseCatalogDocument(docWithChat([
    modelRow({ display_name: 'X', promotion: { window_start: '22:00' } }),
  ])).get('x')
  assert.equal(broken.promotion, null)
})

test('parseCatalogDocument keeps the free flag next to a zero price', () => {
  // `is_free` means "carries a free allowance", not "costs nothing forever" —
  // Qwen3.8-Max is is_free=true at 0.2x. Only price 0 + is_free is "free now".
  const facts = parseCatalogDocument(docWithChat([
    modelRow({ display_name: 'Qwen3.8-Flash', price_factor: 0, original_price_factor: 0.1, is_free: true }),
    modelRow({ display_name: 'Qwen3.8-Max', price_factor: 0.2, is_free: true }),
  ]))
  assert.equal(formatQoderPrice(facts.get('qwen3.8-flash')), ' · x0 · 限时免费')
  // A discounted-but-paid model must not be labelled free.
  assert.equal(formatQoderPrice(facts.get('qwen3.8-max')), ' · x0.2')
})

test('parseCatalogDocument reads each model\'s own thinking levels', () => {
  const doc = docWithChat([
    modelRow({
      display_name: 'Qwen3.8-Max',
      thinking_config: { disabled: {}, enabled: { is_default: true, efforts: { low: {}, medium: { is_default: true }, xhigh: {} } } },
    }),
    modelRow({
      display_name: 'DeepSeek-Flash',
      thinking_config: { disabled: {}, enabled: { is_default: true, efforts: { low: {}, high: {}, max: { is_default: true } } } },
    }),
    modelRow({ display_name: 'Qwen3.7-Max', thinking_config: { disabled: {}, enabled: { is_default: true } } }),
    modelRow({ display_name: 'Auto' }),
  ])
  const facts = parseCatalogDocument(doc)
  assert.deepEqual(facts.get('qwen3.8-max').efforts, ['low', 'medium', 'xhigh'])
  assert.equal(facts.get('qwen3.8-max').defaultEffort, 'medium')
  assert.deepEqual(facts.get('deepseek-flash').efforts, ['low', 'high', 'max'])
  assert.equal(facts.get('deepseek-flash').defaultEffort, 'max')
  // enabled with no efforts = on/off only, which pi-ai cannot express.
  assert.deepEqual(facts.get('qwen3.7-max').efforts, [])
  assert.equal(facts.get('qwen3.7-max').canDisableThinking, true)
  // No thinking_config at all (the auto router).
  assert.deepEqual(facts.get('auto').efforts, [])
  assert.equal(facts.get('auto').canDisableThinking, false)
  // A level pi-ai cannot name is dropped rather than passed through.
  const odd = parseCatalogDocument(docWithChat([
    modelRow({ display_name: 'Odd', thinking_config: { enabled: { efforts: { low: {}, ultracode: {} } } } }),
  ])).get('odd')
  assert.deepEqual(odd.efforts, ['low'])
})

test('thinkingLevelMapFor declares exactly the official levels', () => {
  const facts = parseCatalogDocument(docWithChat([
    modelRow({
      display_name: 'Qwen3.8-Max',
      thinking_config: { enabled: { efforts: { low: {}, medium: {}, xhigh: {} } } },
    }),
  ])).get('qwen3.8-max')
  const map = thinkingLevelMapFor(facts)
  // Declared levels carry their wire spelling...
  assert.equal(map.low, 'low')
  assert.equal(map.medium, 'medium')
  assert.equal(map.xhigh, 'xhigh')
  // ...and every other level is pinned to null. This is the whole point: the
  // upstream silently ignores an unsupported effort, so a level left out of
  // the map would be offered in the picker while doing nothing.
  assert.equal(map.high, null)
  assert.equal(map.max, null)
  assert.equal(map.minimal, null)
  // `off` must stay null: pi-ai sends it on every request naming no level, so
  // a string here would silently disable thinking by default.
  assert.equal(map.off, null)
  // No efforts at all: no control, rather than one that cannot work.
  assert.equal(thinkingLevelMapFor({ efforts: [] }), null)
  assert.equal(thinkingLevelMapFor(undefined), null)
})

test('parseCatalogDocument prefers the configured context window', () => {
  const facts = parseCatalogDocument(docWithChat([
    modelRow({
      display_name: 'Multi',
      max_input_tokens: 180000,
      context_config: { '1M': { token_count: 1000000 }, '200K': { token_count: 200000, is_default: true } },
    }),
    modelRow({ display_name: 'Fallback', max_input_tokens: 96000 }),
    modelRow({ display_name: 'None' }),
  ]))
  // The client's own default wins over the hard input cap.
  assert.equal(facts.get('multi').contextWindow, 200000)
  assert.deepEqual(facts.get('multi').contextWindows, [200000, 1000000])
  assert.equal(facts.get('fallback').contextWindow, 96000)
  assert.equal(facts.get('none').contextWindow, null)
})

test('parseCatalogDocument never throws on an unusable document', () => {
  assert.equal(parseCatalogDocument('not json').size, 0)
  assert.equal(parseCatalogDocument('[]').size, 0)
  assert.equal(parseCatalogDocument('null').size, 0)
  assert.equal(parseCatalogDocument('{}').size, 0)
  // Rows missing the identity fields are skipped, the rest still parse.
  const partial = parseCatalogDocument(docWithChat([
    { display_name: 'NoKey' },
    { key: 'noName' },
    null,
    modelRow({ display_name: 'Good', key: 'good' }),
  ]))
  assert.deepEqual([...partial.keys()], ['good'])
  // Another scene's roster is not this plugin's roster.
  assert.equal(parseCatalogDocument(JSON.stringify({ developer: [modelRow({ display_name: 'X' })] })).size, 0)
})

test('formatQoderPrice is empty when there is nothing to say', () => {
  assert.equal(formatQoderPrice(undefined), '')
  assert.equal(formatQoderPrice({ priceFactor: null, free: false, promotion: null }), '')
  assert.equal(formatQoderPrice({ priceFactor: 1.4, free: false, promotion: null }), ' · x1.4')
  // A promotion badge rides along, since the static multiplier hides it.
  assert.equal(formatQoderPrice({
    priceFactor: 0.2,
    free: false,
    promotion: { badge: '错峰 4 折', discountFactor: 0.4 },
  }), ' · x0.2 · 错峰 4 折')
  // A promotion with no badge still shows the price alone.
  assert.equal(formatQoderPrice({
    priceFactor: 0.2,
    free: false,
    promotion: { badge: null, discountFactor: 0.4 },
  }), ' · x0.2')
})

test('loadQoderModelFacts reads and decrypts a home directory layout', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-qoder-catalog-'))
  const uid = 'uid-abc-123'
  const modelsDir = path.join(home, '.qoder-cn', '.models')
  fs.mkdirSync(path.join(modelsDir, uid), { recursive: true })
  fs.writeFileSync(path.join(modelsDir, 'default'), JSON.stringify({ uid, scene: 'assistant' }))
  fs.writeFileSync(path.join(modelsDir, uid, 'catalog-v6'),
    sealQmc(docWithChat([modelRow({ display_name: 'Qwen3.7-Max', key: 'qmodel_latest', price_factor: 0.5 })]), uid))

  const snapshot = await loadQoderModelFacts({ homeDir: home })
  assert.equal(snapshot.uid, uid)
  assert.equal(snapshot.facts.get('qwen3.7-max').priceFactor, 0.5)
})

test('loadQoderModelFacts prefers the uid the default file names', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-qoder-catalog-'))
  const modelsDir = path.join(home, '.qoder-cn', '.models')
  // Two accounts on disk; `default` names the active one, and only its own
  // uid decrypts its container, so picking the wrong one fails outright.
  for (const [uid, price] of [['uid-old', 0.1], ['uid-new', 0.9]]) {
    fs.mkdirSync(path.join(modelsDir, uid), { recursive: true })
    fs.writeFileSync(path.join(modelsDir, uid, 'catalog-v6'),
      sealQmc(docWithChat([modelRow({ display_name: 'M', price_factor: price })]), uid))
  }
  fs.writeFileSync(path.join(modelsDir, 'default'), JSON.stringify({ uid: 'uid-old' }))
  const snapshot = await loadQoderModelFacts({ homeDir: home })
  assert.equal(snapshot.uid, 'uid-old')
  assert.equal(snapshot.facts.get('m').priceFactor, 0.1)
})

test('loadQoderModelFacts answers null instead of throwing', async () => {
  // No home, no client: the picker must still work without these facts.
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-qoder-nohome-'))
  assert.equal(await loadQoderModelFacts({ homeDir: empty }), null)
  assert.equal(await loadQoderModelFacts({ homeDir: path.join(empty, 'does-not-exist') }), null)

  // A corrupt container, a container sealed for another uid, and a document
  // with no chat scene all answer null rather than a half-parsed result.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-qoder-bad-'))
  const modelsDir = path.join(home, '.qoder-cn', '.models', 'uid-x')
  fs.mkdirSync(modelsDir, { recursive: true })
  fs.writeFileSync(path.join(modelsDir, 'default'), JSON.stringify({ uid: 'uid-x' }))
  const catalog = path.join(modelsDir, 'catalog-v6')

  fs.writeFileSync(catalog, 'garbage')
  assert.equal(await loadQoderModelFacts({ homeDir: home }), null)

  fs.writeFileSync(catalog, sealQmc('{}', 'uid-x'))
  assert.equal(await loadQoderModelFacts({ homeDir: home }), null)

  fs.writeFileSync(catalog, sealQmc(docWithChat([modelRow({ display_name: 'M' })]), 'uid-other'))
  assert.equal(await loadQoderModelFacts({ homeDir: home }), null)
})
