/**
 * Roster-persistence tests: the middle tier between a live CLI answer and
 * the compiled fallback.
 *
 * Every case redirects `DSH_HOME` at a fresh temp directory, so the real
 * `$DSH_HOME/qoder-connect/roster.json` is never read or written. The file is
 * the plugin's own rebuildable state, so the assertions here are about what
 * survives a restart and what is refused — not about the bytes on disk.
 *
 * Zero-dependency: `node --test`, run against the built `lib/`.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { QoderCatalog, loadQoderRoster, qoderRosterPath, saveQoderRoster } from '../lib/index.js'

/** Point the plugin's data directory at a fresh temp home for one test. */
function isolateHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-qoder-roster-'))
  process.env.DSH_HOME = home
  return home
}

test('a saved roster round-trips through disk', async () => {
  isolateHome()
  await saveQoderRoster([
    { id: 'qoder-qwen3.8-max', name: 'Qwen3.8-Max' },
    { id: 'qoder-kimi-k3', name: 'Kimi-K3' },
  ])
  const loaded = await loadQoderRoster()
  assert.notEqual(loaded, null)
  assert.equal(loaded.version, 1)
  assert.deepEqual(loaded.models, [
    { id: 'qoder-qwen3.8-max', name: 'Qwen3.8-Max' },
    { id: 'qoder-kimi-k3', name: 'Kimi-K3' },
  ])
  assert.ok(loaded.savedAt > 0)
  // It lands under the plugin's own data directory, beside the ledger.
  assert.ok(qoderRosterPath().includes('qoder-connect'))
})

test('a missing file answers null rather than throwing', async () => {
  isolateHome()
  assert.equal(await loadQoderRoster(), null)
})

test('an unparseable file answers null rather than throwing', async () => {
  const home = isolateHome()
  const file = qoderRosterPath()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, '{ not json at all')
  assert.equal(await loadQoderRoster(), null)
})

test('a foreign schema version is discarded, not migrated', async () => {
  const home = isolateHome()
  const file = qoderRosterPath()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ version: 2, models: [{ id: 'x', name: 'X' }] }))
  assert.equal(await loadQoderRoster(), null)
})

test('an empty or malformed roster is refused', async () => {
  const home = isolateHome()
  const file = qoderRosterPath()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ version: 1, savedAt: 1, models: [] }))
  assert.equal(await loadQoderRoster(), null)

  // A row missing a field would otherwise poison the picker with an id-less
  // model, so the whole document is discarded instead.
  fs.writeFileSync(file, JSON.stringify({ version: 1, savedAt: 1, models: [{ id: 'qoder-auto' }] }))
  assert.equal(await loadQoderRoster(), null)
})

test('saving an empty roster writes nothing', async () => {
  const home = isolateHome()
  await saveQoderRoster([])
  assert.equal(fs.existsSync(qoderRosterPath()), false)
})

test('a persisted write is atomic: no temp file is left behind', async () => {
  const home = isolateHome()
  await saveQoderRoster([{ id: 'qoder-auto', name: 'Auto' }])
  const dir = path.dirname(qoderRosterPath())
  const leftovers = fs.readdirSync(dir).filter(name => name.endsWith('.tmp'))
  assert.deepEqual(leftovers, [], 'the temp file must be renamed away')
})

test('the catalog adopts the saved tier and reports it as the source', () => {
  const catalog = new QoderCatalog()
  assert.equal(catalog.source(), 'builtin')
  assert.equal(
    catalog.hydrate([{ id: 'qoder-kimi-k3', name: 'Kimi-K3' }]),
    true,
    'a saved roster differs from the built-in one',
  )
  assert.equal(catalog.source(), 'saved')
  assert.deepEqual(catalog.all(), [{ id: 'qoder-kimi-k3', name: 'Kimi-K3' }])
})

test('hydrating with an empty roster is refused', () => {
  const catalog = new QoderCatalog()
  const builtinCount = catalog.all().length
  assert.equal(catalog.hydrate([]), false)
  assert.equal(catalog.all().length, builtinCount)
  assert.equal(catalog.source(), 'builtin')
})

test('a live answer replaces the saved tier and is reported as a change', () => {
  // The card's source badge must move from "saved" to "live" even when the
  // roster itself is identical, so the refresh has to report a change.
  const catalog = new QoderCatalog()
  catalog.hydrate([{ id: 'qoder-auto', name: 'Auto' }])
  assert.equal(catalog.source(), 'saved')
  assert.equal(
    catalog.setModels([{ externalId: 'qoder-auto', cliModel: 'Auto' }], 'cli'),
    true,
    'same rows, different tier — still a change worth publishing',
  )
  assert.equal(catalog.source(), 'cli')
})

test('an unchanged live answer reports no change', () => {
  // Guards the steady state: a refresh that answered the same roster from the
  // same tier must not churn the adapter snapshot.
  const catalog = new QoderCatalog()
  catalog.setModels([{ externalId: 'qoder-auto', cliModel: 'Auto' }], 'cli')
  assert.equal(catalog.setModels([{ externalId: 'qoder-auto', cliModel: 'Auto' }], 'cli'), false)
})

test('the saved tier survives a restart as the starting point', async () => {
  // The whole point of tier 2: the second run serves the account's real
  // roster from disk before its own CLI fetch has answered.
  isolateHome()
  await saveQoderRoster([{ id: 'qoder-kimi-k3', name: 'Kimi-K3' }])

  const restarted = new QoderCatalog()
  const saved = await loadQoderRoster()
  assert.equal(restarted.hydrate(saved.models), true)
  assert.equal(restarted.source(), 'saved')
  assert.deepEqual(restarted.all(), [{ id: 'qoder-kimi-k3', name: 'Kimi-K3' }])
})

test('a save failure leaves the previous roster readable', async () => {
  // The write is best-effort: a failed save must cost the next restart's
  // tier, never this run's roster — and must never damage what is already
  // on disk. The failure is provoked by occupying the temp path the atomic
  // rename writes through, which leaves the real file untouched.
  isolateHome()
  await saveQoderRoster([{ id: 'qoder-auto', name: 'Auto' }])
  const blocker = `${qoderRosterPath()}.${process.pid}.tmp`
  fs.mkdirSync(blocker)
  try {
    await assert.doesNotReject(saveQoderRoster([{ id: 'qoder-kimi-k3', name: 'Kimi-K3' }]))
  } finally {
    fs.rmSync(blocker, { recursive: true, force: true })
  }
  const loaded = await loadQoderRoster()
  assert.deepEqual(loaded?.models, [{ id: 'qoder-auto', name: 'Auto' }])
})
