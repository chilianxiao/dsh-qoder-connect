/**
 * Model-switch tests: which models the picker offers, and whether a
 * switched-off model stays off.
 *
 * The unit half drives `QoderCatalog` directly. The patch half drives
 * `parseQoderConfigPatch`, which is where a bad write would be persisted and
 * then replayed into every later snapshot.
 *
 * Zero-dependency: `node --test`, run against the built `lib/`.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { QoderCatalog, parseQoderConfigPatch } from '../lib/index.js'

/** A catalog holding a known three-model roster. */
function roster() {
  return new QoderCatalog([
    { externalId: 'qoder-auto', cliModel: 'Auto' },
    { externalId: 'qoder-qwen3.8-max', cliModel: 'Qwen3.8-Max' },
    { externalId: 'qoder-kimi-k3', cliModel: 'Kimi-K3' },
  ])
}

test('a switched-off model leaves the served roster but stays in the catalog', () => {
  const catalog = roster()
  catalog.setVisible(true)
  assert.equal(catalog.current().length, 3)

  assert.equal(catalog.setHidden(['qoder-kimi-k3']), true)
  assert.deepEqual(catalog.current().map(entry => entry.id), ['qoder-auto', 'qoder-qwen3.8-max'])
  // It must remain reachable, or it could never be switched back on.
  assert.equal(catalog.all().length, 3)
  assert.deepEqual(catalog.hiddenIds(), ['qoder-kimi-k3'])
})

test('the whole roster can be switched off, which empties the group', () => {
  // DSH hides a group with no rows, so switching everything off is the same
  // gesture as hiding Qoder entirely — which is what the user asked for.
  const catalog = roster()
  catalog.setVisible(true)
  catalog.setHidden(['qoder-auto', 'qoder-qwen3.8-max', 'qoder-kimi-k3'])
  assert.deepEqual(catalog.current(), [])
  assert.equal(catalog.all().length, 3)
})

test('an unchanged hidden set reports no change', () => {
  // Guards the steady state: the settings section fires onChange on every
  // write, so a no-op write must not churn the adapter snapshot.
  const catalog = roster()
  catalog.setHidden(['qoder-kimi-k3'])
  assert.equal(catalog.setHidden(['qoder-kimi-k3']), false)
  // Order does not matter either — it is a set, not a list.
  assert.equal(catalog.setHidden(['qoder-kimi-k3', 'qoder-kimi-k3']), false)
})

test('a hidden id the roster does not know is still kept', () => {
  // A model switched off while the built-in fallback served must stay off
  // after the CLI's own roster arrives, or the switch appears to undo itself.
  const catalog = roster()
  catalog.setHidden(['qoder-qwen9-ultra'])
  assert.deepEqual(catalog.hiddenIds(), ['qoder-qwen9-ultra'])
  // And it does not disturb the models that do exist.
  catalog.setVisible(true)
  assert.equal(catalog.current().length, 3)
})

test('garbage in the hidden set is dropped rather than persisted', () => {
  const catalog = roster()
  catalog.setHidden(['qoder-kimi-k3', '', null, undefined, 42])
  assert.deepEqual(catalog.hiddenIds(), ['qoder-kimi-k3'])
})

test('a refreshed roster does not resurrect a switched-off model', () => {
  // The regression this guards: the roster is replaced wholesale on every
  // refresh, so the hidden set has to live outside it.
  const catalog = roster()
  catalog.setVisible(true)
  catalog.setHidden(['qoder-qwen3.8-max'])
  catalog.setModels([
    { externalId: 'qoder-auto', cliModel: 'Auto' },
    { externalId: 'qoder-qwen3.8-max', cliModel: 'Qwen3.8-Max' },
    { externalId: 'qoder-qwen3.8-flash', cliModel: 'Qwen3.8-Flash' },
  ], 'cli')
  assert.deepEqual(catalog.current().map(entry => entry.id), ['qoder-auto', 'qoder-qwen3.8-flash'])
  assert.deepEqual(catalog.hiddenIds(), ['qoder-qwen3.8-max'])
})

test('the patch accepts a hidden-model list and deduplicates it', () => {
  assert.deepEqual(
    parseQoderConfigPatch({ hiddenModels: ['qoder-kimi-k3', 'qoder-kimi-k3'] }),
    { patch: { hiddenModels: ['qoder-kimi-k3'] } },
  )
  assert.deepEqual(parseQoderConfigPatch({ hiddenModels: [] }), { patch: { hiddenModels: [] } })
  // It rides alongside the other fields, as the card sends them.
  assert.deepEqual(
    parseQoderConfigPatch({ contextWindowMax: true, hiddenModels: ['qoder-auto'] }),
    { patch: { contextWindowMax: true, hiddenModels: ['qoder-auto'] } },
  )
})

test('the patch refuses a hidden-model value that is not a list of strings', () => {
  // A non-string entry would reach the catalog's filter and never match,
  // silently hiding nothing while looking saved.
  assert.ok('error' in parseQoderConfigPatch({ hiddenModels: 'qoder-auto' }))
  assert.ok('error' in parseQoderConfigPatch({ hiddenModels: [1, 2] }))
  assert.ok('error' in parseQoderConfigPatch({ hiddenModels: [null] }))
  assert.ok('error' in parseQoderConfigPatch({ hiddenModels: [{}] }))
})
