/**
 * Loopback OpenAI-compatible endpoint. The pi-ai provider points here; the
 * shim gates on qoder readiness, spawns the local `qoderclicn` CLI per
 * request, and re-emits its stream-json output as OpenAI chunks. It binds
 * 127.0.0.1 only and never serves another interface.
 *
 * Inbound hardening: the loopback bind alone is not a trust boundary (any
 * local process or a DNS-rebinding page can reach 127.0.0.1), so every
 * request must carry a loopback Host header, browser-sent Origins must be
 * loopback, chat POSTs must be application/json, and the Authorization
 * header must carry the shim's per-process shared secret. The plugin's own
 * client satisfies all four by construction; local attackers cannot read
 * the secret out of the plugin process's memory.
 *
 * @module dsh-qoder-connect/shim
 */

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import {
  QODER_MODELS,
  QODER_TIMEOUT_MS,
  aggregateQoderChunks,
  qoderChatStream,
  qoderModelListEntry,
  qoderStatus,
  flattenContent,
  type ChatChunk,
  type QoderOptions,
  type QoderStatus,
  type QoderRunResult,
} from './qoder.ts'
import { appendQoderLedgerEntry } from './ledger.ts'
import { hostIsLoopback, originIsLoopback } from './loopback.ts'

/** Minimal logger surface the plugin context already provides. */
export interface ShimLogger {
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
}

/** What the plugin needs from a running shim. */
export interface QoderShim {
  /** Resolves once the listener is up; rejects if listening failed. */
  ready: Promise<void>
  /** The shim origin, e.g. `http://127.0.0.1:39271`; valid after ready. */
  baseUrl(): string
  /**
   * The per-process shared secret the plugin's own client must carry as
   * `Authorization: Bearer <token>`. Lives only in memory; the adapter
   * resolves this as the OpenAI apiKey, which pi-ai sends as
   * `Authorization: Bearer ...`. The shim never forwards it to the CLI.
   */
  token(): string
  /** Stop serving and destroy open connections. */
  close(): Promise<void>
}

/** Constructor dependencies. */
export interface QoderShimOptions {
  /** Qoder CLI overrides (command, PAT, home dir); env vars still apply. */
  qoder?: QoderOptions
  logger?: ShimLogger
}

const REQUEST_BODY_LIMIT = 64 * 1024 * 1024

/** Chat-completion POSTs must carry a JSON body type. */
function isJsonContentType(req: IncomingMessage): boolean {
  const type = req.headers['content-type']
  return typeof type === 'string' && type.trim().toLowerCase().startsWith('application/json')
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) })
  res.end(payload)
}

function writeOpenAIError(res: ServerResponse, status: number, kind: string, message: string): void {
  writeJson(res, status, { error: { message, type: kind, code: kind } })
}

/** Read a request body with a size cap; over-limit bodies fail the request. */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > REQUEST_BODY_LIMIT) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/**
 * Start the loopback endpoint. Requests carry the per-process bearer; the
 * loopback bind plus the secret are the boundary, and the qoder credential
 * comes from the CLI's own on-disk state alone.
 */
export function createQoderShim(options: QoderShimOptions = {}): QoderShim {
  const logger = options.logger

  // Per-process shared secret. Lives only in memory; the adapter resolves it
  // as the OpenAI apiKey, which pi-ai sends as `Authorization: Bearer ...`.
  // The shim validates this before spawning the CLI. A local attacker who
  // can hit the port still cannot forge it.
  const SHARED_SECRET = randomBytes(32).toString('base64url')

  /** Constant-time bearer check; absent or mismatched bearers are rejected. */
  function bearerOk(req: IncomingMessage): boolean {
    const header = req.headers.authorization
    if (typeof header !== 'string') return false
    const match = /^Bearer\s+(.+)$/i.exec(header.trim())
    if (match === null) return false
    const presented = match[1] as string
    const a = Buffer.from(presented)
    const b = Buffer.from(SHARED_SECRET)
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
  }

  const server: Server = createServer((req, res) => {
    void handle(req, res)
  })

  const ready = new Promise<void>((resolve, reject) => {
    server.once('listening', () => resolve())
    server.once('error', reject)
  })

  server.listen(0, '127.0.0.1')

  const baseUrl = (): string => {
    const address = server.address()
    if (address === null || typeof address === 'string') {
      throw new Error('qoder shim has no listening address')
    }
    return `http://127.0.0.1:${address.port}`
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      // Inbound hardening: every request must name the loopback host, and
      // browser-sent origins must be loopback too. The plugin's own client
      // always satisfies both; DNS-rebinding pages and cross-origin POSTs
      // do not.
      if (!hostIsLoopback(req.headers.host)) {
        writeOpenAIError(res, 403, 'host_not_allowed', 'Host header must name the loopback interface')
        return
      }
      if (!originIsLoopback(req.headers.origin)) {
        writeOpenAIError(res, 403, 'origin_not_allowed', 'Origin must be a loopback origin')
        return
      }
      if (!bearerOk(req)) {
        writeOpenAIError(res, 401, 'unauthorized', 'missing or invalid Authorization bearer')
        return
      }
      const url = req.url ?? '/'
      if (req.method === 'GET' && (url === '/healthz' || url === '/healthz/')) {
        writeJson(res, 200, { ok: true })
        return
      }
      if (req.method === 'GET' && (url === '/v1/models' || url === '/v1/models/')) {
        // Readiness is re-checked per read: a CLI installed or a login that
        // happened after startup must not leave a stale 401 (or a stale 200).
        const status = qoderStatus(options.qoder)
        if (!status.ready) {
          writeOpenAIError(res, 401, 'qoder_not_ready', status.reason)
          return
        }
        writeJson(res, 200, { object: 'list', data: QODER_MODELS.map(qoderModelListEntry) })
        return
      }
      if (req.method === 'POST' && (url === '/v1/chat/completions' || url === '/v1/chat/completions/')) {
        await chatCompletions(req, res)
        return
      }
      writeOpenAIError(res, 404, 'not_found', `no such route: ${req.method} ${url}`)
    } catch (error: unknown) {
      if (!res.headersSent) {
        writeOpenAIError(res, 500, 'internal', String(error))
      } else {
        res.end()
      }
    }
  }

  async function chatCompletions(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!isJsonContentType(req)) {
      writeOpenAIError(res, 415, 'unsupported_media_type', 'Content-Type must be application/json')
      return
    }
    const status: QoderStatus = qoderStatus(options.qoder)
    if (!status.ready) {
      writeOpenAIError(res, 401, 'qoder_not_ready', status.reason)
      return
    }

    const raw = (await readBody(req)).toString('utf8')
    let body: unknown
    try {
      body = JSON.parse(raw)
    } catch {
      writeOpenAIError(res, 400, 'invalid_json', 'request body is not valid JSON')
      return
    }
    const stream = (body as { stream?: unknown }).stream === true
    /** The DSH-facing model id, for the ledger row (the CLI name is per-run). */
    const externalModel = typeof (body as { model?: unknown }).model === 'string' && (body as { model: string }).model !== ''
      ? (body as { model: string }).model
      : 'qoder-auto'
    const promptChars = Array.isArray((body as { messages?: unknown }).messages)
      ? ((body as { messages: Array<{ content?: unknown }> }).messages)
        .reduce((sum: number, m) => sum + flattenContent(m?.content).length, 0)
      : 0

    // The client (pi-ai) going away must not leave an orphan CLI running;
    // the ceiling bounds a CLI that never exits.
    const controller = new AbortController()
    req.on('close', () => controller.abort(new Error('client disconnected')))
    const timeoutMs = QODER_TIMEOUT_MS
    const timeoutTimer = setTimeout(() => controller.abort(new Error(`qoderclicn 超过 ${Math.round(timeoutMs / 1000)}s 未结束`)), timeoutMs)
    if (typeof timeoutTimer.unref === 'function') timeoutTimer.unref()

    try {
      if (stream) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        })
      }
      const chunks: ChatChunk[] = []
      for await (const chunk of qoderChatStream(body, {
        ...options.qoder,
        signal: controller.signal,
        timeoutMs,
        onRunComplete: (result: QoderRunResult, cliModel: string) => {
          // Fire-and-forget: the ledger is best-effort bookkeeping, and its
          // failure must never reach the chat stream that paid for it.
          void appendQoderLedgerEntry({
            ts: Date.now(),
            model: externalModel,
            cli: cliModel,
            credits: result.credits,
            ms: result.ms,
            turns: result.turns,
            chars: promptChars,
            error: result.isError,
          }, error => {
            logger?.warn('dsh-qoder-connect: usage ledger append failed', error)
          })
        },
      })) {
        if (controller.signal.aborted && !stream) break
        if (stream) {
          if (res.writableEnded) break
          res.write(`data: ${JSON.stringify(chunk)}\n\n`)
        } else {
          chunks.push(chunk)
        }
      }
      if (controller.signal.aborted) return
      if (stream) {
        if (!res.writableEnded) {
          res.write('data: [DONE]\n\n')
          res.end()
        }
        return
      }
      const completion = aggregateQoderChunks(chunks, body)
      writeJson(res, 200, completion)
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message.slice(0, 400) : String(error).slice(0, 400)
      logger?.warn('dsh-qoder-connect: qoder proxy error', error)
      if (controller.signal.aborted) return
      if (stream) {
        // Headers are already on the wire; the SSE error convention is a
        // comment-free data line the client can surface.
        if (!res.writableEnded) {
          res.write(`data: ${JSON.stringify({ error: { message, type: 'qoder_upstream_failed' } })}\n\n`)
          res.end()
        }
        return
      }
      writeOpenAIError(res, 502, 'qoder_upstream_failed', message)
    } finally {
      clearTimeout(timeoutTimer)
    }
  }

  return {
    ready,
    baseUrl,
    token: () => SHARED_SECRET,
    close: () => new Promise<void>((resolve, reject) => {
      server.close(() => resolve())
      server.closeAllConnections()
      server.once('error', reject)
    }),
  }
}
