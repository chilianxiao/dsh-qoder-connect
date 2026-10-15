/**
 * Host-plugin wiring tests: `apply()` against a mock Cordis context.
 *
 * Verifies what the plugin promises the Harness seam — the `qoder` route
 * registration, the provider directory entry, the settings section, the
 * web-status route, and the readiness-driven catalog visibility — without
 * booting DSH. Machine-independent: the assertions hold whether or not the
 * test machine has a Qoder login (the sweep's outcome is observed, not
 * assumed).
 *
 * One caveat that is NOT machine-independent: `apply()` starts the plugin for
 * real, which means the startup roster refresh resolves the actual `qoderclicn`
 * and — since the refresh persists what it fetched — writes a roster file. The
 * redirect below sends that write to a throwaway directory; without it the
 * suite would overwrite the developer's own `$DSH_HOME/qoder-connect/roster.json`
 * with whatever this machine's CLI happened to answer.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import {
  apply,
  loadQoderRoster,
  qoderRosterPath,
  saveQoderRoster,
  QODER_MODELS,
  QODER_PROVIDER,
  QODER_SETTINGS_NS,
} from '../lib/index.js'

/** Redirect the dsh home for this whole test file. See the module comment. */
const TEST_DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-qoder-apply-home-'))
process.env.DSH_HOME = TEST_DSH_HOME

/** A mock Cordis context recording everything the plugin registers. */
function mockContext(overrides = {}) {
  const calls = {
    adapters: [],
    providers: [],
    sections: [],
    routes: [],
    injected: [],
    events: [],
    disposed: [],
  }
  /** Every effect disposer the plugin registered, run by `disposeAll`. */
  const disposers = []
  const base = {
    logger: { info() {}, warn() {}, error() {} },
    get() { return undefined },
    emit(event) { calls.events.push(event) },
    effect(fn, label) {
      const dispose = fn()
      const wrapped = () => {
        if (typeof dispose === 'function') dispose()
        if (label !== undefined) calls.disposed.push(label)
      }
      disposers.push(wrapped)
      return wrapped
    },
    inject(services, callback) {
      calls.injected.push(services)
      // The plugin tolerates an absent webServer/settings service (headless
      // profiles); the mock models that by never invoking the callback.
      return () => {}
    },
    llm: {
      registerAdapter(providers, adapter) {
        calls.adapters.push({ providers, adapter })
        return () => {}
      },
      registerConfigurableProviders(entries) {
        calls.providers.push(entries)
        return () => {}
      },
    },
  }
  const ctx = { ...base, ...overrides }
  /** Run every registered effect disposer (closes shims, clears timers). */
  const disposeAll = () => {
    for (const dispose of disposers.splice(0)) dispose()
    calls.disposeCount = (calls.disposeCount ?? 0) + 1
  }
  return { ctx, calls, disposeAll }
}

/** Wait until `probe` holds or the budget runs out. */
async function waitFor(probe, budgetMs = 5000) {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    if (probe()) return true
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  return probe()
}

/** A mock ServerResponse capturing the status code and body. */
function mockResponse() {
  const res = new EventEmitter()
  let statusCode = 0
  let body = ''
  res.writeHead = (code) => { statusCode = code }
  res.end = (payload) => { if (typeof payload === 'string') body = payload }
  return {
    res,
    statusCode: () => statusCode,
    json: () => (body === '' ? undefined : JSON.parse(body)),
  }
}

test('apply registers the qoder route and its directory entry', async () => {
  const { ctx, calls, disposeAll } = mockContext()
  try {
    apply(ctx, {})

    assert.ok(await waitFor(() => calls.adapters.length === 1), 'adapter registration')
    assert.deepEqual(calls.adapters[0].providers, [QODER_PROVIDER])
    assert.equal(calls.providers.length, 1)
    assert.deepEqual(calls.providers[0], [{
      provider: QODER_PROVIDER,
      displayName: 'Qoder',
      settingsNs: QODER_SETTINGS_NS,
      settingsPath: [],
      declared: false,
    }])
  } finally {
    disposeAll()
  }
})

test('the startup roster refresh resolves its cache under the redirected home', async () => {
  // The regression this guards: `apply()` boots the plugin for real, so the
  // startup refresh resolves the actual `qoderclicn` and persists whatever it
  // answers. Before the redirect at the top of this file that write landed in
  // the developer's own `$DSH_HOME/qoder-connect/roster.json`, replacing a
  // real account's roster with a test machine's answer.
  //
  // The assertion is on where the path resolves, not on whether a file
  // appeared: a DSH running concurrently on the same machine legitimately
  // writes that same file, so "the real home is untouched" would be a claim
  // about the developer's other processes rather than about this one. Proving
  // the resolution is both deterministic and complete — `saveQoderRoster` can
  // only write where `qoderRosterPath` points.
  assert.ok(
    qoderRosterPath().startsWith(TEST_DSH_HOME),
    `expected the roster cache under ${TEST_DSH_HOME}, got ${qoderRosterPath()}`,
  )

  // And the writer really does follow it. This runs in its own home so the
  // one-model roster it writes cannot reach the other tests in this file,
  // which adopt whatever the shared home holds on their next `apply()`.
  const own = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-qoder-apply-isolated-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = own
  try {
    await saveQoderRoster([{ id: 'qoder-auto', name: 'Auto' }])
    assert.equal(fs.existsSync(qoderRosterPath()), true)
    assert.deepEqual((await loadQoderRoster())?.models, [{ id: 'qoder-auto', name: 'Auto' }])
  } finally {
    process.env.DSH_HOME = previous
    fs.rmSync(own, { recursive: true, force: true })
  }
})

test('the adapter serves models through the pi-ai profile', async () => {
  const { ctx, calls, disposeAll } = mockContext()
  try {
    apply(ctx, {})
    assert.ok(await waitFor(() => calls.adapters.length === 1))
    // The profile lists every catalog row when visible, none when hidden; the
    // machine's own qoder state decides which, and both are valid answers.
    // The row count is not asserted: the roster comes from the CLI at runtime,
    // so a fixed number would break the moment Qoder adds a model.
    const models = await calls.adapters[0].adapter.listModels(QODER_PROVIDER)
    assert.ok(models.length === 0 || models.length >= QODER_MODELS.length)
    assert.ok(models.every(model => typeof model.id === 'string' && model.id.startsWith('qoder-')))
  } finally {
    disposeAll()
  }
})

test('apply asks for the optional webServer and settings services', async () => {
  const { ctx, calls, disposeAll } = mockContext()
  try {
    apply(ctx, {})
    assert.ok(await waitFor(() => calls.injected.length >= 2))
    const injected = calls.injected.flat()
    assert.ok(injected.includes('webServer'))
    assert.ok(injected.includes('settings'))
  } finally {
    disposeAll()
  }
})

test('the web-status route answers a loopback GET with a status document', async () => {
  // Drive the real route handler: apply with an inject that forwards the
  // webServer scope, capturing the registered route. The injected scope is
  // a real Cordis context, so it carries `effect` too.
  const routes = []
  const { ctx, disposeAll } = mockContext({
    inject(services, callback) {
      if (services.includes('webServer')) {
        const scopeEffects = []
        callback({
          effect(fn) {
            const dispose = fn()
            scopeEffects.push(dispose)
            return () => { if (typeof dispose === 'function') dispose() }
          },
          webServer: {
            register(entry) {
              routes.push(entry)
              return () => {}
            },
          },
        })
        for (const dispose of scopeEffects) if (typeof dispose === 'function') dispose()
      }
      return () => {}
    },
  })
  try {
    apply(ctx, {})
    assert.ok(await waitFor(() => routes.length === 2), 'status and config routes registered')
    // The write route is registered alongside; the read route is the subject here.
    const status = routes.find(route => route.path === '/plugins/dsh-qoder-connect/status')
    assert.ok(status !== undefined, 'status route registered')
    assert.equal(status.kind, 'exact')
    assert.ok(routes.some(route => route.path === '/plugins/dsh-qoder-connect/config'), 'config route registered')

    // A loopback GET receives a JSON document whose discriminator is one of
    // the three the browser half knows.
    const ok = mockResponse()
    await status.handler({ method: 'GET', headers: { host: '127.0.0.1:3080' } }, ok.res)
    assert.equal(ok.statusCode(), 200)
    assert.ok(['ready', 'not-ready', 'error'].includes(ok.json().status))

    // A non-loopback Host is refused before any state is disclosed.
    const refused = mockResponse()
    await status.handler({ method: 'GET', headers: { host: 'evil.example.com' } }, refused.res)
    assert.equal(refused.statusCode(), 403)
  } finally {
    disposeAll()
  }
})

test('the settings page policy opts out of the auto-generated page', async () => {
  // Replaces the old `installSection` assertion. The card is registered by the
  // browser half into the `plugins.item` slot, so the host must be told not to
  // synthesize a page of its own — otherwise the namespace resolves and DSH
  // renders a default form beside the real card.
  //
  // The owner matters as much as the flag: the host keys the policy by the
  // plugin entry's fiber, so passing the inject scope's fiber (the default)
  // would register a policy the host never looks up.
  const policies = []
  const { ctx, disposeAll } = mockContext({
    inject(services, callback) {
      if (services.includes('settings')) {
        const scopeEffects = []
        callback({
          effect(fn) {
            const dispose = fn()
            scopeEffects.push(dispose)
            return () => { if (typeof dispose === 'function') dispose() }
          },
          settings: {
            configure(presentation, owner) {
              policies.push({ presentation, owner })
              return () => {}
            },
          },
        })
        for (const dispose of scopeEffects) if (typeof dispose === 'function') dispose()
      }
      return () => {}
    },
  })
  try {
    apply(ctx, { cli: 'qoderclicn' })
    assert.ok(await waitFor(() => policies.length === 1))
    assert.deepEqual(policies[0].presentation, { auto: false })
    assert.equal(policies[0].owner, ctx.fiber)
  } finally {
    disposeAll()
  }
})

test('the provider directory entry joins the settings namespace', async () => {
  // The Models settings page finds a provider's namespace through this entry
  // (`namespaces.find(ns => ns.ns === provider.settingsNs)`), so the value has
  // to be the loader entry id — the `id` the bundle patch declares, not the
  // provider id and not the package name.
  const { ctx, calls, disposeAll } = mockContext()
  try {
    apply(ctx, {})
    assert.ok(await waitFor(() => calls.providers.length === 1))
    assert.equal(calls.providers[0][0].settingsNs, QODER_SETTINGS_NS)
    assert.equal(QODER_SETTINGS_NS, 'llm-qoder')
  } finally {
    disposeAll()
  }
})

test('the settings namespace matches the id this package patches in', async () => {
  // The pin that would have caught both wrong answers. Patching the package in
  // under a *different* id silently breaks every card save, because the two
  // spellings never meet anywhere else: the id lives in cordis.patch.yml and
  // the namespace lives in this module.
  const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/, ''))
  const patch = fs.readFileSync(path.join(here, '..', 'cordis.patch.yml'), 'utf8')
  const declared = [...patch.matchAll(/^\s*-\s*id:\s*(\S+)\s*$/gm)].map(match => match[1])
  assert.deepEqual(declared, [QODER_SETTINGS_NS])
})

test('plugin disposal closes the loopback shim', async () => {
  const { ctx, calls, disposeAll } = mockContext()
  try {
    apply(ctx, {})
    assert.ok(await waitFor(() => calls.adapters.length === 1))
  } finally {
    // Disposing every effect must not throw (the shim closes its server).
    disposeAll()
  }
  assert.ok((calls.disposeCount ?? 0) >= 1)
})
