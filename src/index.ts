/**
 * Qoder models for DeepSeek Harness, reusing the local `qoderclicn` CLI's
 * sign-in. Registers one loopback-backed provider — `qoder` — while
 * streaming, tool calls, compaction, and permissions stay Harness-owned.
 *
 * The plugin holds no credential of its own: the CLI owns the account
 * (OAuth state on disk after `qoderclicn login`, or a PAT via
 * QODERCN_PERSONAL_ACCESS_TOKEN). Readiness — CLI installed AND signed in —
 * is swept on a timer so a login that happens while DSH is already running
 * makes the Qoder model group appear without a restart, and a sign-out (or
 * an uninstalled CLI) hides it again.
 *
 * @module dsh-qoder-connect
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-attachment'
// Brings the `ctx.llm` service augmentation into scope explicitly rather
// than relying on adapter.ts's import of the same package.
import type {} from '@deepseek-ai/dsh-llm'
import { QoderCatalog } from './catalog.ts'
import { loadQoderRoster, saveQoderRoster } from './catalog-store.ts'
import { createQoderAdapter, type QoderContextWindowMode } from './adapter.ts'
import { createQoderShim } from './shim.ts'
import { QODER_PROVIDER } from './adapter.ts'
import { registerQoderRoutes } from './web-status.ts'
import { loadQoderModelFacts, type QoderModelFacts } from './model-catalog.ts'
import { clearQoderCliCache, fetchQoderModels, qoderStatus, type QoderOptions, type QoderReasoningEffort, type QoderThinkingMode } from './qoder.ts'
import { QODER_REASONING_EFFORTS, QODER_THINKING_MODES } from './qoder.ts'
import { QODER_CONNECT_VERSION } from './version.ts'

export { QODER_PROVIDER, QODER_STREAM_IDLE_TIMEOUT_MS, createQoderAdapter, type QoderAdapter, type QoderContextWindowMode } from './adapter.ts'
export { QoderCatalog, type QoderCatalogEntry, type QoderRosterSource } from './catalog.ts'
export {
  loadQoderRoster,
  qoderRosterPath,
  saveQoderRoster,
  type QoderSavedModel,
  type QoderSavedRoster,
} from './catalog-store.ts'
export { createQoderShim, type QoderShim } from './shim.ts'
export {
  disposeImageAttachments,
  materializeImageAttachments,
  type QoderImageMaterial,
} from './images.ts'
export {
  QODER_MODELS,
  QODER_DEFAULT_MODEL,
  QODER_TIMEOUT_MS,
  QODER_REASONING_EFFORTS,
  QODER_THINKING_MODES,
  QODER_MAX_THINKING_BUDGET,
  aggregateQoderChunks,
  buildCliPrompt,
  buildReasoningArgs,
  clearQoderCliCache,
  cliModelFor,
  fetchQoderModels,
  parseCliDelta,
  parseCliResult,
  parseListModelsOutput,
  qoderChatStream,
  qoderExternalId,
  qoderOauthUserCandidates,
  qoderOauthUserPath,
  qoderStatus,
  type QoderReasoningEffort,
  type QoderThinkingMode,
  type QoderRunResult,
  type QoderStatus,
} from './qoder.ts'
export {
  appendQoderLedgerEntry,
  qoderLedgerPath,
  type QoderLedgerEntry,
} from './ledger.ts'
export {
  decryptQmcCatalog,
  formatQoderPrice,
  loadQoderModelFacts,
  parseCatalogDocument,
  thinkingLevelMapFor,
  type QoderCatalogSnapshot,
  type QoderModelFacts,
  type QoderPromotion,
} from './model-catalog.ts'
export { registerQoderRoutes } from './web-status.ts'
export {
  parseQoderConfigPatch,
  parseReasoningPatch,
  qoderConfigHandler,
  qoderWebContextWindow,
  qoderWebReasoning,
  qoderWebStatus,
  registerQoderStatusRoute,
  QODER_CONFIG_PATH,
  QODER_STATUS_PATH,
  type QoderWebContextWindow,
  type QoderWebReasoning,
  type QoderWebStatus,
} from './web-status.ts'

/** Stable Cordis plugin name. */
export const name = 'llm-qoder'

/** The model registry required before the provider can register. */
export const inject = ['llm']

/**
 * Settings namespace this plugin's card writes through.
 *
 * It is the **profile entry id** — the package name as it appears in the
 * profile's `dependencies` and `dsh.profile.bundles` — not the model provider
 * id. DSH's settings service resolves a namespace by matching
 * `entry.options.id` (`dsh-settings` `SettingsForms.write`), and an entry id
 * is the bundle's package name, so the two are different keys that happen to
 * describe the same plugin.
 *
 * Getting this wrong is not a silent no-op: the write throws
 * `No configurable plugin entry "<ns>"`, which surfaces on the card as a
 * failed save with no hint that the namespace was the problem. The provider
 * id (`qoder`) is the right answer for `llm.registerAdapter` and the wrong
 * one here.
 */
export const QODER_SETTINGS_NS = 'dsh-qoder-connect' as SettingsNamespace

/**
 * How often readiness is re-checked, in milliseconds.
 *
 * A startup-only readiness check cannot notice a `qoderclicn login` that
 * happens while DSH is already running, so the model group would not appear
 * until a restart. This poll is cheap: an existence read of at most a few
 * local files plus a cached CLI probe (`--version` at most once a minute).
 * It never sends a chat request.
 *
 * `DSH_QODER_POLL_MS` overrides it. That exists so the sweep can be
 * exercised end to end in tests and shortened while diagnosing a slow
 * sign-in on a real machine; it is not a product setting and no UI exposes
 * it. The value is clamped to a sane range so a mistaken override cannot
 * turn the poll into a busy loop.
 */
const READINESS_POLL_MS = 30_000

/**
 * Floor and ceiling for the overridable readiness poll interval.
 */
const MIN_POLL_MS = 100
const MAX_POLL_MS = 24 * 60 * 60 * 1000

/** Resolve the sweep interval, honoring the override when it is usable. */
function readinessPollMs(): number {
  const override = Number(process.env['DSH_QODER_POLL_MS'])
  if (!Number.isFinite(override) || override < MIN_POLL_MS) return READINESS_POLL_MS
  return Math.min(override, MAX_POLL_MS)
}

/**
 * A `Volatile` reference as schemastery hands it to a plugin.
 *
 * A schema field marked `volatile()` validates to one of these instead of a
 * plain value, so that the loader can commit an edit in place rather than
 * remounting the plugin. The getter is typed loosely on purpose: cosmokit's
 * `Volatile<T>` reports a readonly view of `T`, which does not line up with
 * the mutable `T` this plugin stores, and the only thing done with the result
 * is read it.
 */
interface VolatileRef {
  get(): unknown
}

/** Plugin configuration. */
export interface Config {
  /**
   * Qoder CLI command name or absolute path, overriding `QODERCN_CLI` and
   * the default `qoderclicn`. Point this at the executable when the CLI is
   * not on PATH (the Qoder installer puts it under `~/.qoder-cn/bin/`).
   */
  cli?: string
  /**
   * Reasoning effort sent as `--reasoning-effort` on every run. Empty (the
   * default) omits the flag entirely and lets the CLI decide.
   */
  reasoningEffort?: QoderReasoningEffort
  /** Thinking mode sent as `--thinking`. Empty omits the flag. */
  thinking?: QoderThinkingMode
  /**
   * Fixed thinking-token budget sent as `--thinking-budget`. Unset omits the
   * flag; the CLI treats it as implying thinking enabled.
   */
  thinkingBudget?: number
  /**
   * Serve models at the largest context window the official catalog declares
   * for them instead of the window the official client picks by default
   * (`--context-window`). Off leaves the CLI's own configured default alone.
   *
   * Only ever a switch between two catalog-declared windows: the value sent
   * is read from the catalog, never computed, because the CLI accepts any
   * number without complaint and would otherwise be handed a fiction.
   */
  contextWindowMax?: boolean
  /**
   * Model ids switched off in the picker. An empty list (the default) serves
   * every model the roster carries.
   *
   * Held as a user preference rather than derived from the roster, so it
   * survives a refresh: switching a model off and then having the CLI answer
   * must not silently switch it back on.
   */
  hiddenModels?: string[]
}

/**
 * The config as the host hands it to `apply()`.
 *
 * Identical to {@link Config} except that every field may arrive as a
 * `Volatile` ref rather than a plain value, because each schema field is
 * marked `volatile()` so the host can commit a card edit in place instead of
 * remounting the plugin. {@link readConfig} is the one place that resolves
 * them; everything downstream of it sees plain {@link Config}.
 */
export type AppliedConfig = {
  [K in keyof Config]: Config[K] | VolatileRef | undefined
}

/** Explicit CLI override (shared by the plugin schema and its section). */
const CLI_FIELD = z.string().volatile()
  .description('Qoder CLI command or path (defaults to QODERCN_CLI, then qoderclicn)')

/**
 * Reasoning-effort selector. The union keeps the settings file honest: an
 * unknown level can never be persisted, which matters because the CLI exits
 * fatally on one instead of ignoring it.
 */
const REASONING_EFFORT_FIELD = z.union(QODER_REASONING_EFFORTS).volatile()
  .description('Reasoning effort (--reasoning-effort); empty uses the CLI default')

/** Thinking-mode selector; same reasoning as the effort field. */
const THINKING_FIELD = z.union(QODER_THINKING_MODES).volatile()
  .description('Thinking mode (--thinking); empty uses the CLI default')

/** Thinking-token budget; 0 or absent omits `--thinking-budget`. */
const THINKING_BUDGET_FIELD = z.number().volatile()
  .description('Fixed thinking token budget (--thinking-budget); 0 uses the CLI default')

/**
 * Context-window switch. A boolean rather than a number on purpose: the
 * number is a per-model fact from the official catalog, so persisting one
 * here would freeze a value that goes stale the moment Qoder re-declares it.
 */
const CONTEXT_WINDOW_MAX_FIELD = z.boolean().volatile()
  .description('Serve models at the largest context window the official catalog declares (--context-window)')

/**
 * Switched-off model ids. An array rather than a per-model map so the card can
 * write the whole set at once — a batch "hide all" is one request, not N.
 */
const HIDDEN_MODELS_FIELD = z.array(z.string()).volatile()
  .description('Model ids to hide from the model picker')

/**
 * The plugin schema.
 *
 * Every field is `volatile()`, which is what lets the card save without DSH
 * tearing the plugin down: an ordinary config change remounts the entry
 * (losing the loopback shim, the catalog and the readiness sweep), while a
 * volatile-only change is committed in place by the loader.
 *
 * The price is that `apply()` receives these fields wrapped in `Volatile`
 * refs rather than as plain values — see {@link readConfig} and
 * {@link AppliedConfig}.
 *
 * Deliberately left without a type annotation: schemastery's `z<T>` constrains
 * a schema's input and output to the same `T`, and here they differ — the
 * profile document holds plain values while validation returns refs. The
 * inferred type is the honest one; the logical shape lives in the `Config`
 * interface, which is what every consumer of this module actually annotates
 * against.
 */
export const Config = z.object({
  cli: CLI_FIELD,
  reasoningEffort: REASONING_EFFORT_FIELD,
  thinking: THINKING_FIELD,
  thinkingBudget: THINKING_BUDGET_FIELD,
  contextWindowMax: CONTEXT_WINDOW_MAX_FIELD,
  hiddenModels: HIDDEN_MODELS_FIELD,
})

/**
 * Read one config field, unwrapping a `Volatile` ref when there is one.
 *
 * The shape check rather than a version check on purpose: a host running an
 * older schemastery hands the field through as a plain value, and this plugin
 * still has to work there. Only a `get` method is treated as a ref, so a
 * string, a number, a boolean and an array all pass through untouched.
 */
function readField<T>(value: T | VolatileRef | undefined): T | undefined {
  if (value === undefined) return undefined
  const candidate = value as { get?: unknown }
  if (typeof candidate.get === 'function') return (value as VolatileRef).get() as T
  return value as T
}

/**
 * Read the live config, with volatile refs resolved to their current values.
 *
 * Every consumer of the plugin's settings goes through here. Reading a ref
 * each time is what makes an edit on the card visible to the next chat run
 * without a restart: the loader swaps the ref's contents in place and emits
 * `loader/volatile-update`, so a snapshot taken once at startup would freeze
 * the value this function exists to keep current.
 */
function readConfig(config: AppliedConfig): Config {
  return {
    cli: readField(config.cli),
    reasoningEffort: readField(config.reasoningEffort),
    thinking: readField(config.thinking),
    thinkingBudget: readField(config.thinkingBudget),
    contextWindowMax: readField(config.contextWindowMax),
    hiddenModels: readField(config.hiddenModels),
  }
}

/**
 * Resolve the explicit `--context-window` for one CLI model name.
 *
 * Reads the same official-catalog snapshot the adapter reports from, so the
 * window on the wire and the window in the picker are always the same number.
 * Undefined — the default mode, or a model the catalog does not describe —
 * omits the flag and leaves the CLI's own configured window alone.
 */
function contextWindowResolver(mode: QoderContextWindowMode, facts: () => ReadonlyMap<string, QoderModelFacts>) {
  return (cliModel: string): number | undefined => {
    if (mode !== 'max') return undefined
    const windows = facts().get(cliModel.toLowerCase())?.contextWindows
    if (windows === undefined || windows.length === 0) return undefined
    // Sorted ascending by the parser, so the last entry is the maximum.
    return windows[windows.length - 1]
  }
}

/** Effective qoder CLI options for one config snapshot. */
function qoderOptionsFor(config: Config, resolveContextWindow?: (cliModel: string) => number | undefined): QoderOptions {
  const options: QoderOptions = {}
  if (config.cli !== undefined && config.cli !== '') options.command = config.cli
  // Only a non-empty selection becomes a flag, so an unset field leaves the
  // CLI's own default untouched rather than forcing one.
  if (config.reasoningEffort !== undefined) options.reasoningEffort = config.reasoningEffort
  if (config.thinking !== undefined) options.thinking = config.thinking
  if (typeof config.thinkingBudget === 'number' && config.thinkingBudget > 0) {
    options.thinkingBudget = config.thinkingBudget
  }
  if (config.contextWindowMax === true) {
    options.contextWindowMax = true
    if (resolveContextWindow !== undefined) options.resolveContextWindow = resolveContextWindow
  }
  return options
}

/**
 * Start the plugin: its loopback endpoint, provider registration, and
 * configuration-card wiring.
 *
 * Registration waits for the shim to hold a port, because the provider's
 * models read the shim origin at construction time.
 *
 * @returns whether the provider registered.
 */
async function start(ctx: Context, config: AppliedConfig): Promise<boolean> {
  // The shim reads the qoder options through a thunk, so a setting edited on
  // the card reaches the next chat run without a restart — the previous
  // snapshot-at-startup behaviour meant a reasoning or context-window change
  // silently waited for the next DSH launch.
  const shim = createQoderShim({ qoder: () => qoderOptionsFor(current(), resolveContextWindow), logger: ctx.logger })
  try {
    await shim.ready
  } catch (error: unknown) {
    ctx.logger.error('dsh-qoder-connect: loopback endpoint failed to start', error)
    return false
  }

  const catalog = new QoderCatalog()
  // Adopt the persisted switches before anything is served, so a restart does
  // not briefly offer models the user had switched off.
  const initialHidden = readField(config.hiddenModels)
  if (Array.isArray(initialHidden) && catalog.setHidden(initialHidden)) {
    // Nothing to publish yet — the adapter is constructed below and reads the
    // catalog through `current()`, which already reflects the hidden set.
  }
  /**
   * Live configuration source.
   *
   * Reads through {@link readConfig} on every call rather than holding a
   * snapshot, so a volatile edit committed by the loader is visible to the
   * next chat run without a restart. This replaces the section-source
   * indirection the removed `installSection` API provided: there is no
   * separate source to swap in, the applied config *is* the live one.
   */
  const current = (): Config => readConfig(config)
  let releaseAdapter: (() => void) | undefined
  let releaseDirectory: (() => void) | undefined
  let sweep: () => void = () => {}
  // Hoisted so the roster refresh below can republish the adapter snapshot
  // too; assigned the moment the adapter exists.
  let invalidate: () => void = () => {}
  /**
   * The official catalog's facts, read synchronously by the adapter.
   *
   * Held here rather than read inside `buildModels` because model listing is
   * synchronous while decrypting the container is I/O, so the host refreshes
   * this in the background and the adapter only reads the last snapshot.
   */
  let modelFacts = new Map<string, QoderModelFacts>()
  /** Which context window the models are served at, read live per request. */
  const contextWindowMode = (): QoderContextWindowMode =>
    current().contextWindowMax === true ? 'max' : 'default'
  /**
   * The explicit `--context-window` for one CLI model name, or undefined to
   * omit the flag. Resolved from the same facts snapshot the adapter reports
   * from, so the wire value and the picker's number cannot drift apart.
   */
  const resolveContextWindow = contextWindowResolver(contextWindowMode(), () => modelFacts)
  try {
    // Constructed only once the listener holds a port: the provider's
    // models read the shim origin at construction time.
    const qoder = createQoderAdapter({
      shim,
      catalog,
      resolveAttachments: () => ctx.get('attachments'),
      modelFacts: () => modelFacts,
      contextWindowMode,
    })
    invalidate = (): void => {
      qoder.invalidate()
      ctx.emit('llm/adapters-updated')
    }

    try {
      releaseAdapter = ctx.llm.registerAdapter([QODER_PROVIDER], qoder.adapter)
      releaseDirectory = ctx.llm.registerConfigurableProviders([{
        provider: QODER_PROVIDER,
        displayName: 'Qoder',
        settingsNs: QODER_SETTINGS_NS,
        settingsPath: [],
        declared: false,
      }])
    } finally {
      if (releaseAdapter === undefined || releaseDirectory === undefined) {
        // Registration threw; release whichever half landed.
        releaseAdapter?.()
        releaseDirectory?.()
      }
    }
    try {
      ctx.effect(() => () => {
        releaseAdapter?.()
        releaseDirectory?.()
        void shim.close()
      })
    } catch {
      // The plugin was disposed during registration; release immediately —
      // the plugin-level disposer already closed the shim.
      releaseAdapter?.()
      releaseDirectory?.()
      void shim.close()
    }

    /**
     * Reconcile the catalog's visibility with readiness.
     *
     * Only a *change* republishes: an unchanged answer must not rebuild the
     * adapter snapshot on every sweep, or a steady-state machine would
     * churn the model directory every 30 seconds for no new information.
     *
     * The sweep is deliberately NOT where the roster or the official catalog
     * is read. Both are read only at startup and on the card's explicit
     * refresh, so a running DSH is never busy-worked by either — and the
     * sweep stays a cheap local check that never spawns the CLI. A sweep that
     * becomes ready reveals the group; the roster then shows the built-in
     * fallback until the refresh button is pressed (which is the one place
     * both are re-read together).
     */
    sweep = (): void => {
      const ready = qoderStatus(qoderOptionsFor(current())).ready
      const changed = catalog.setVisible(ready)
      if (changed) invalidate()
    }
  } catch (error: unknown) {
    ctx.logger.error('dsh-qoder-connect: provider registration failed', error)
    void shim.close()
    return false
  }

  /**
   * Ask the CLI for its current roster and publish any change.
   *
   * Serialized so two triggers (startup and a readiness flip) cannot spawn
   * the CLI twice at once, and best-effort: a failure leaves the previous
   * roster in place rather than emptying the group.
   *
   * A live answer is also persisted, which is what keeps the *next* run from
   * degrading to the built-in snapshot while it waits for this one.
   */
  let refreshing: Promise<void> | undefined
  const refreshModels = (): Promise<void> => {
    refreshing ??= (async () => {
      try {
        const models = await fetchQoderModels(qoderOptionsFor(current()))
        if (models === null) {
          ctx.logger.warn('dsh-qoder-connect: could not list models from the CLI; keeping the current roster')
          return
        }
        // Persist before publishing: the saved copy is what the next restart
        // serves while its own fetch is in flight, so it must reflect the
        // answer that just landed, not the one before it.
        await saveQoderRoster(models.map(model => ({ id: model.externalId, name: model.cliModel })))
        if (catalog.setModels(models, 'cli')) {
          invalidate()
          ctx.logger.info(`dsh-qoder-connect: model roster refreshed from the CLI (${models.length} models)`)
        }
      } catch (error: unknown) {
        ctx.logger.warn('dsh-qoder-connect: model roster refresh failed', error)
      } finally {
        refreshing = undefined
      }
    })()
    return refreshing
  }

  /**
   * Re-read everything the picker shows: the CLI's roster and the official
   * catalog's price, thinking levels and context windows.
   *
   * This is the one explicit refresh path — startup and the card's refresh
   * button both come through here. There is no timer on either half: the
   * roster costs a CLI spawn, and the catalog's file is written by the
   * official client, so polling it would only ever report a snapshot the
   * client has already decided to publish. Both halves are best-effort and
   * independent: a failure in one leaves the other's data in place.
   */
  const refreshAll = async (): Promise<void> => {
    await refreshModels()
    await refreshModelFacts()
  }

  /**
   * Re-read the official catalog's per-model facts.
   *
   * Only a real change republishes: `llm/adapters-updated` churns the model
   * directory, so a refresh that changed nothing must stay silent.
   */
  const refreshModelFacts = async (): Promise<void> => {
    try {
      const snapshot = await loadQoderModelFacts()
      const next = snapshot?.facts ?? new Map<string, QoderModelFacts>()
      const same = next.size === modelFacts.size && [...next].every(([name, fact]) =>
        JSON.stringify(fact) === JSON.stringify(modelFacts.get(name)))
      if (same) return
      modelFacts = next as Map<string, QoderModelFacts>
      invalidate()
      if (next.size > 0) {
        ctx.logger.info(`dsh-qoder-connect: official model catalog loaded (${next.size} models from ${snapshot?.file ?? 'unknown'})`)
      }
    } catch (error: unknown) {
      // The picker keeps whatever facts it already has.
      ctx.logger.warn('dsh-qoder-connect: official catalog refresh failed', error)
    }
  }

  // The readiness sweep starts whether or not the route and section wiring
  // below lands: a failure there costs the card, never the model channel.
  sweep()
  const timer = setInterval(sweep, readinessPollMs())
  timer.unref?.()

  // Startup reads: the roster the CLI reports is what the picker serves, with
  // the built-in list standing in until (or unless) this answers, and the
  // official catalog is what carries price, context windows and per-model
  // thinking levels. Neither is ever re-read on a timer — only the card's
  // refresh button asks for both again.
  //
  // The saved roster is adopted *before* the fetch starts, so a machine that
  // has run before shows its account's real models immediately instead of the
  // compiled snapshot — the CLI answer replaces it the moment it lands.
  void (async () => {
    const saved = await loadQoderRoster()
    if (saved !== null && catalog.hydrate(saved.models)) {
      invalidate()
      ctx.logger.info(`dsh-qoder-connect: serving the roster saved at ${new Date(saved.savedAt).toISOString()} (${saved.models.length} models)`)
    }
    await refreshAll()
  })()

  /**
   * React to a save made on the card.
   *
   * Invoked by the config route once the host has accepted a write, which is
   * the plugin's own notification path — the loader does emit
   * `loader/volatile-update` afterwards, but that name is internal to the
   * loader package and is not part of the typed event surface, so relying on
   * it would couple this plugin to an implementation detail.
   *
   * The sweep's timer would eventually re-check readiness, but a
   * context-window switch or a model toggle changes what the picker serves
   * and has to republish the adapter snapshot at once, or the picker keeps
   * showing the window and roster that were in effect before the save.
   *
   * Declared before the route that calls it: the route is registered from an
   * `inject` callback whose body only runs later, but a `const` in the same
   * scope is still in its temporal dead zone until this line executes.
   */
  const onSettingsChanged = (): void => {
    // The CLI override changed: drop the cached resolution so the new command
    // is probed, then re-check readiness.
    clearQoderCliCache()
    if (catalog.setHidden(current().hiddenModels ?? [])) invalidate()
    invalidate()
    sweep()
  }

  // Same-origin routes backing the Plugin-configuration card: the status
  // read, plus the write route for the reasoning controls. The webServer
  // service is optional (a headless profile serves no browser).
  ctx.inject(['webServer'], webCtx => {
    // The handlers read `deps.qoder` once per request, so a live thunk here
    // is what keeps an edited reasoning setting visible on the next refresh
    // instead of freezing it at registration time.
    const deps = {
      catalog,
      settingsNs: QODER_SETTINGS_NS as string,
      settings: async () => webCtx.get('settings'),
      refreshModels: refreshAll,
      factsCount: () => modelFacts.size,
      onSettingsChanged,
      get qoder() { return qoderOptionsFor(current()) },
    }
    registerQoderRoutes(webCtx, deps)
  })

  // Register the settings page policy. This plugin brings its own card
  // (registered into the `plugins.item` slot by the browser half), so it must
  // opt out of the host's auto-generated page; without this the namespace
  // resolves but DSH renders a default form beside the real card.
  //
  // `installSection` — the API that used to both declare the section and hand
  // back a live config source — was removed in DSH 0.1.7, so there is no
  // section schema to pass and no source to adopt: the volatile fields on
  // `Config` are what the host reads, and `readConfig` is what this plugin
  // reads. The owner is the plugin's own fiber rather than the inject scope's,
  // because the policy is keyed by the entry's fiber.
  ctx.inject(['settings'], settingsCtx => {
    settingsCtx.effect(() => settingsCtx.settings.configure({ auto: false }, ctx.fiber), 'dsh-qoder-connect: settings page policy')
  })

  ctx.effect(() => () => {
    clearInterval(timer)
  })

  return true
}

export function apply(ctx: Context, config: AppliedConfig): void {
  void start(ctx, config).then(registered => {
    if (!registered) {
      ctx.logger.warn('dsh-qoder-connect: the qoder provider is unavailable in this profile')
    }
  })
}

export { QODER_CONNECT_VERSION }
