/**
 * Local usage ledger for the qoder route.
 *
 * Every completed CLI run carries its credit cost in the stream-json
 * `result` record (`total_credits`) — the only place the Qoder CLI reports
 * money. This module persists one JSONL line per run under the dsh home so
 * the `dsh-qoder-credits` widget can show consumption without any vendor
 * usage-history API (there is none).
 *
 * The file is written here and read by the credits plugin; the two agree on
 * the entry shape below and nothing else. Node built-ins only.
 *
 * @module dsh-qoder-connect/ledger
 */

import { appendFile, mkdir } from 'node:fs/promises'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

/** One completed CLI run, as persisted. */
export interface QoderLedgerEntry {
  /** Epoch ms when the run finished. */
  ts: number
  /** DSH-facing model id, e.g. `qoder-qwen3.7-max`. */
  model: string
  /** The CLI's own model spelling, e.g. `Qwen3.7-Max`. */
  cli: string
  /** Credits the CLI charged for this run. */
  credits: number
  /** Wall-clock duration of the run, ms. */
  ms: number
  /** CLI turns the run took. */
  turns: number
  /** Flattened prompt length in characters (the CLI reports no tokens). */
  chars: number
  /** Whether the CLI itself flagged the run as an error. */
  error: boolean
}

/** Where the ledger lives: `$DSH_HOME/qoder-credits/ledger.jsonl`. */
export function qoderLedgerPath(): string {
  return dshHomePath('qoder-credits', 'ledger.jsonl')
}

/**
 * Serialized append chain.
 *
 * A chat stream finishes on its own timer, so two runs can settle at the
 * same moment; `appendFile` with separate handles would interleave their
 * writes on some platforms. One in-process promise chain keeps every line
 * whole without a lock file.
 */
let appendChain: Promise<void> = Promise.resolve()

/**
 * Append one run to the ledger. Never throws: a failed write costs a data
 * point, never the chat that produced it.
 *
 * @returns a promise that settles once the line is on disk (or the failure
 *   is swallowed); callers may fire-and-forget.
 */
export function appendQoderLedgerEntry(entry: QoderLedgerEntry, onError?: (error: unknown) => void): Promise<void> {
  const next = appendChain.then(async () => {
    try {
      const file = qoderLedgerPath()
      await mkdir(dshHomePath('qoder-credits'), { recursive: true })
      await appendFile(file, `${JSON.stringify(entry)}\n`, 'utf8')
    } catch (error: unknown) {
      onError?.(error)
    }
  })
  // Keep the chain alive regardless of this append's outcome.
  appendChain = next.then(
    () => undefined,
    () => undefined,
  )
  return next
}
