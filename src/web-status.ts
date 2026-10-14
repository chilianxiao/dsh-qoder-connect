/**
 * Same-origin status route for the Qoder plugin card: CLI resolution,
 * login state, and the served model list, fetched by the browser half. The
 * route answers loopback browser requests only and never carries token
 * material.
 *
 * @module dsh-qoder-connect/web-status
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { SettingsProvider } from '@deepseek-ai/dsh-settings'
import type { QoderCatalog } from './catalog.ts'
import {
  qoderStatus,
  QODER_MAX_THINKING_BUDGET,
  QODER_REASONING_EFFORTS,
  QODER_THINKING_MODES,
  type QoderOptions,
} from './qoder.ts'
import { hostIsLoopback, originIsLoopback } from './loopback.ts'
import { QODER_CONFIG_PATH, QODER_STATUS_PATH } from './status-paths.ts'
import type { QoderWebContextWindow, QoderWebModel, QoderWebModelSwitch, QoderWebReasoning, QoderWebStatus } from './status-paths.ts'

export { QODER_STATUS_PATH, QODER_CONFIG_PATH } from './status-paths.ts'
export type { QoderRosterSource, QoderWebContextWindow, QoderWebModel, QoderWebModelSwitch, QoderWebReasoning, QoderWebStatus } from './status-paths.ts'

/** Constructor dependencies. */
export interface QoderStatusRouteOptions {
  catalog: QoderCatalog
  /** Qoder CLI overrides; env vars still apply. */
  qoder?: QoderOptions
  /**
   * Settings namespace backing the editable reasoning fields, resolved at
   * request time. Absent (headless, or settings not yet attached) simply
   * means the write route answers 501.
   */
  settings?: () => Promise<SettingsProvider | undefined>
  /**
   * The namespace the card's writes target, and the plugin's own namespace.
   * Required for the write route; without it writes are refused.
   */
  settingsNs?: string
  /**
   * Re-read everything the picker shows: the CLI's model roster and the
   * official catalog's price, thinking levels and context windows.
   * Absent means the card's refresh button only re-reads the current status.
   */
  refreshModels?: () => Promise<void>
  /**
   * How many models the official catalog's facts covered on the last read.
   * Reported by the refresh response so the card can show whether the price
   * and levels actually came from the official catalog or the fallback.
   */
  factsCount?: () => number
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) })
  res.end(payload)
}

/**
 * The reasoning controls as the card renders them: the live options plus the
 * vocabularies the CLI accepts, so the UI never offers a level the CLI would
 * reject outright.
 */
export function qoderWebReasoning(qoder: QoderOptions = {}): QoderWebReasoning {
  return {
    effort: qoder.reasoningEffort ?? '',
    thinking: qoder.thinking ?? '',
    budget: qoder.thinkingBudget ?? 0,
  }
}

/**
 * The context-window switch as the card renders it.
 *
 * Read off the live options rather than from a stored setting, so the card
 * shows what is actually in effect for the next request — including a value
 * edited elsewhere while the card was open.
 */
export function qoderWebContextWindow(qoder: QoderOptions = {}): QoderWebContextWindow {
  return { max: qoder.contextWindowMax === true }
}

/**
 * The request must be addressed to the loopback interface, and a
 * browser-attached Origin must be loopback too. The Host check drops
 * DNS-rebinding pages (their Host is the attacker's domain, not loopback);
 * the card's same-origin fetches carry no Origin and pass on Host alone.
 */
function loopbackRequest(req: IncomingMessage): boolean {
  return hostIsLoopback(req.headers.host) && originIsLoopback(req.headers.origin)
}

/**
 * Assemble the card's status document. Readiness is read-only; nothing here
 * contacts the network — the CLI probe is a local `--version` spawn.
 */
export function qoderWebStatus(deps: QoderStatusRouteOptions): QoderWebStatus {
  const status = qoderStatus(deps.qoder)
  const models: readonly QoderWebModel[] = deps.catalog.current().map(entry => ({ id: entry.id, name: entry.name }))
  // The switches cover the whole roster, not just what is served: a model
  // switched off still has to be reachable from the card, or it could never
  // be switched back on.
  const switches: readonly QoderWebModelSwitch[] = deps.catalog.withVisibility()
    .map(entry => ({ id: entry.id, name: entry.name, on: entry.on }))
  const reasoning = qoderWebReasoning(deps.qoder)
  const contextWindow = qoderWebContextWindow(deps.qoder)
  const rosterSource = deps.catalog.source()
  if (!status.ready) {
    return {
      status: 'not-ready',
      reason: status.reason,
      ...status.cli === null ? {} : { cli: status.cli },
      oauth: status.oauth,
      pat: status.pat,
      oauthFile: status.oauthFile,
      reasoning,
      contextWindow,
      switches,
      rosterSource,
    }
  }
  return {
    status: 'ready',
    cli: status.cli ?? 'qoderclicn',
    source: status.oauth ? 'oauth' : 'pat',
    oauthFile: status.oauthFile,
    reason: status.reason,
    models,
    switches,
    reasoning,
    contextWindow,
    rosterSource,
  }
}

/** The status route's request handler, extracted so tests can mount it on a bare server. */
export function qoderStatusHandler(
  deps: QoderStatusRouteOptions,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    if (req.method !== 'GET') {
      json(res, 405, { error: 'method not allowed' })
      return
    }
    if (!loopbackRequest(req)) {
      json(res, 403, { error: 'request-not-trusted' })
      return
    }
    try {
      json(res, 200, qoderWebStatus(deps))
    } catch (error: unknown) {
      json(res, 500, { error: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500) })
    }
  }
}

/** Mount the GET status route on an optional webServer context. */
export function registerQoderStatusRoute(ctx: Context, deps: QoderStatusRouteOptions): void {
  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: 'exact',
      path: QODER_STATUS_PATH,
      handler: qoderStatusHandler(deps),
    })
    return () => {
      dispose()
    }
  }, 'dsh-qoder-connect: Web status route')
}

/** Body ceiling for the config write route: three small scalars. */
const CONFIG_BODY_LIMIT = 4 * 1024

/** One validated settings write from the card. */
interface QoderConfigPatch {
  reasoningEffort?: string
  thinking?: string
  thinkingBudget?: number
  contextWindowMax?: boolean
  hiddenModels?: string[]
}

/**
 * Validate one posted patch against the CLI's own vocabularies.
 *
 * The CLI treats an unknown `--reasoning-effort` as fatal, so a bad value
 * must be refused at the edge rather than persisted and then replayed into
 * every later request. `''` is accepted for the two selects and means "do not
 * send this flag"; the empty string cannot reach the schema as a valid level.
 *
 * `contextWindowMax` is a plain boolean — the number it stands for is a
 * per-model fact read from the official catalog at request time, so there is
 * nothing here for a caller to get wrong.
 */
export function parseQoderConfigPatch(body: unknown): { patch: QoderConfigPatch } | { error: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { error: 'body must be a JSON object' }
  }
  const raw = body as Record<string, unknown>
  const patch: QoderConfigPatch = {}

  if ('reasoningEffort' in raw) {
    const value = raw.reasoningEffort
    if (value === '' || value === null) {
      patch.reasoningEffort = ''
    } else if (typeof value === 'string' && (QODER_REASONING_EFFORTS as readonly string[]).includes(value)) {
      patch.reasoningEffort = value
    } else {
      return { error: `reasoningEffort must be one of: ${QODER_REASONING_EFFORTS.join(', ')} (or "" to clear)` }
    }
  }

  if ('thinking' in raw) {
    const value = raw.thinking
    if (value === '' || value === null) {
      patch.thinking = ''
    } else if (typeof value === 'string' && (QODER_THINKING_MODES as readonly string[]).includes(value)) {
      patch.thinking = value
    } else {
      return { error: `thinking must be one of: ${QODER_THINKING_MODES.join(', ')} (or "" to clear)` }
    }
  }

  if ('thinkingBudget' in raw) {
    const value = raw.thinkingBudget
    if (value === null) {
      patch.thinkingBudget = 0
    } else if (typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value)
      && value >= 0 && value <= QODER_MAX_THINKING_BUDGET) {
      patch.thinkingBudget = value
    } else {
      return { error: `thinkingBudget must be an integer between 0 and ${QODER_MAX_THINKING_BUDGET}` }
    }
  }

  if ('contextWindowMax' in raw) {
    const value = raw.contextWindowMax
    if (typeof value !== 'boolean') {
      return { error: 'contextWindowMax must be a boolean' }
    }
    patch.contextWindowMax = value
  }

  if ('hiddenModels' in raw) {
    const value = raw.hiddenModels
    if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string')) {
      return { error: 'hiddenModels must be an array of model id strings' }
    }
    // Deduplicated: the same id twice would only ever mean "hidden", and a
    // duplicate would make the stored array differ from the effective set for
    // no reason the card could explain.
    patch.hiddenModels = [...new Set(value as string[])]
  }

  return { patch }
}

/**
 * Backwards-compatible alias for {@link parseQoderConfigPatch}.
 *
 * The route outgrew its original name when the context-window switch joined
 * the reasoning controls, but the reasoning spelling is what the existing
 * call sites and tests use, so it stays available.
 */
export const parseReasoningPatch = parseQoderConfigPatch

/** Read a request body with a size cap. */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > CONFIG_BODY_LIMIT) throw new Error('request body too large')
    chunks.push(buffer)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/**
 * The write route's handler: validate the patch, then merge it into the
 * plugin's own settings namespace so the change is durable and reaches the
 * live config thunk through the section's `onChange`.
 */
export function qoderConfigHandler(
  deps: QoderStatusRouteOptions,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    if (req.method !== 'POST') {
      json(res, 405, { error: 'method not allowed' })
      return
    }
    if (!loopbackRequest(req)) {
      json(res, 403, { error: 'request-not-trusted' })
      return
    }
    let body: unknown
    try {
      body = await readJsonBody(req)
    } catch (error: unknown) {
      json(res, 400, { error: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300) })
      return
    }

    // The refresh rides this route rather than adding a third one: it is the
    // same "act on the card's behalf" surface, and the card already knows
    // this path. It covers both halves of what the picker shows — the CLI's
    // roster and the official catalog's facts.
    if (typeof body === 'object' && body !== null && (body as { action?: unknown }).action === 'refreshModels') {
      if (deps.refreshModels === undefined) {
        json(res, 501, { error: 'model refresh is not available in this profile' })
        return
      }
      try {
        await deps.refreshModels()
        json(res, 200, {
          ok: true,
          models: deps.catalog.all(),
          rosterSource: deps.catalog.source(),
          factsCount: deps.factsCount?.() ?? 0,
        })
      } catch (error: unknown) {
        json(res, 500, { error: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300) })
      }
      return
    }

    const ns = deps.settingsNs
    if (ns === undefined || deps.settings === undefined) {
      json(res, 501, { error: 'settings are not available in this profile' })
      return
    }
    try {
      const provider = await deps.settings()
      if (provider === undefined) {
        json(res, 501, { error: 'settings are not available in this profile' })
        return
      }
      const parsed = parseQoderConfigPatch(body)
      if ('error' in parsed) {
        json(res, 400, { error: parsed.error })
        return
      }
      // `''` is not a valid schema member, so a cleared select is written as
      // an `unset`, letting the schema default (absent) take over rather than
      // persisting a value the schema would reject.
      const ops = Object.entries(parsed.patch).map(([key, value]) =>
        value === '' ? { op: 'unset' as const, path: [key] } : { op: 'set' as const, path: [key], value })
      await provider.mutate(ns as Parameters<SettingsProvider['mutate']>[0], ops)
      json(res, 200, { ok: true, reasoning: qoderWebReasoning(deps.qoder) })
    } catch (error: unknown) {
      json(res, 400, { error: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300) })
    }
  }
}

/** Mount both the read and write routes; the write route is best-effort. */
export function registerQoderRoutes(ctx: Context, deps: QoderStatusRouteOptions): void {
  registerQoderStatusRoute(ctx, deps)
  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: 'exact',
      path: QODER_CONFIG_PATH,
      handler: qoderConfigHandler(deps),
    })
    return () => {
      dispose()
    }
  }, 'dsh-qoder-connect: Web config route')
}
