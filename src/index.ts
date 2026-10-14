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

/** Settings namespace owning the plugin card's section. */
export const QODER_SETTINGS_NS = 'qoder' as SettingsNamespace

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

/** Explicit CLI override (shared by the plugin schema and its section). */
const CLI_FIELD = z.string().description('Qoder CLI command or path (defaults to QODERCN_CLI, then qoderclicn)')

/**
 * Reasoning-effort selector. The union keeps the settings file honest: an
 * unknown level can never be persisted, which matters because the CLI exits
 * fatally on one instead of ignoring it.
 */
const REASONING_EFFORT_FIELD = z.union(QODER_REASONING_EFFORTS)
  .description('Reasoning effort (--reasoning-effort); empty uses the CLI default')

/** Thinking-mode selector; same reasoning as the effort field. */
const THINKING_FIELD = z.union(QODER_THINKING_MODES)
  .description('Thinking mode (--thinking); empty uses the CLI default')

/** Thinking-token budget; 0 or absent omits `--thinking-budget`. */
const THINKING_BUDGET_FIELD = z.number()
  .description('Fixed thinking token budget (--thinking-budget); 0 uses the CLI default')

/**
 * Context-window switch. A boolean rather than a number on purpose: the
 * number is a per-model fact from the official catalog, so persisting one
 * here would freeze a value that goes stale the moment Qoder re-declares it.
 */
const CONTEXT_WINDOW_MAX_FIELD = z.boolean()
  .description('Serve models at the largest context window the official catalog declares (--context-window)')

/**
 * Switched-off model ids. An array rather than a per-model map so the card can
 * write the whole set at once — a batch "hide all" is one request, not N.
 */
const HIDDEN_MODELS_FIELD = z.array(z.string())
  .description('Model ids to hide from the model picker')

export const Config: z<Config> = z.object({
  cli: CLI_FIELD,
  reasoningEffort: REASONING_EFFORT_FIELD,
  thinking: THINKING_FIELD,
  thinkingBudget: THINKING_BUDGET_FIELD,
  contextWindowMax: CONTEXT_WINDOW_MAX_FIELD,
  hiddenModels: HIDDEN_MODELS_FIELD,
})

/** The settings section: only the fields the card edits. */
const SECTION: z<Config> = z.object({
  cli: CLI_FIELD,
  reasoningEffort: REASONING_EFFORT_FIELD,
  thinking: THINKING_FIELD,
  thinkingBudget: THINKING_BUDGET_FIELD,
  contextWindowMax: CONTEXT_WINDOW_MAX_FIELD,
  hiddenModels: HIDDEN_MODELS_FIELD,
})

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
async function start(ctx: Context, config: Config): Promise<boolean> {
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
  if (Array.isArray(config.hiddenModels) && catalog.setHidden(config.hiddenModels)) {
    // Nothing to publish yet — the adapter is constructed below and reads the
    // catalog through `current()`, which already reflects the hidden set.
  }
  // Live configuration source: starts as the applied config and is replaced
  // by the settings section's source once one is installed, so a CLI
  // override edited in settings reaches the readiness sweep at once.
  let current = (): Config => config
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
      get qoder() { return qoderOptionsFor(current()) },
    }
    registerQoderRoutes(webCtx, deps)
  })

  // The settings section is what makes the namespace "served" — which is
  // how both the Plugins tab (card dispatch) and the Models settings page
  // (provider directory join) find this plugin. Without one the plugin
  // still serves its models; it simply has no user-editable section.
  ctx.inject(['settings'], settingsCtx => {
    settingsCtx.settings.installSection(ctx, QODER_SETTINGS_NS, SECTION, config, {
      setSource(source) { current = source as () => Config },
      onChange: () => {
        // The CLI override changed: drop the cached resolution so the new
        // command is probed, then re-check readiness at once.
        clearQoderCliCache()
        // A context-window switch or a model toggle changes what the picker
        // serves, so the snapshot has to be republished — otherwise it keeps
        // showing the window and the roster that were in effect before.
        if (catalog.setHidden(current().hiddenModels ?? [])) invalidate()
        invalidate()
        sweep()
      },
    })
  })

  ctx.effect(() => () => {
    clearInterval(timer)
  })

  return true
}

export function apply(ctx: Context, config: Config): void {
  void start(ctx, config).then(registered => {
    if (!registered) {
      ctx.logger.warn('dsh-qoder-connect: the qoder provider is unavailable in this profile')
    }
  })
}

export { QODER_CONNECT_VERSION }
