/**
 * Durable copy of the last roster the CLI actually reported.
 *
 * The served roster has three tiers, best first:
 *
 * 1. **live** — `qoderclicn --list-models` answered just now;
 * 2. **saved** — the last live answer, persisted here;
 * 3. **builtin** — the snapshot compiled into the plugin.
 *
 * Tier 2 is what this module exists for. Without it a restart — or a CLI
 * that answers `null` because it is mid-upgrade, not on PATH in a new shell,
 * or simply slow — drops the picker straight from live to builtin, so a
 * machine that had this account's real model list silently shows a stale
 * one. The saved copy is written only from a successful live answer, so it
 * can never be worse than what the CLI itself reported.
 *
 * The file is the plugin's own rebuildable state, so it lives beside the
 * ledger under `$DSH_HOME/qoder-connect/` and is safe to delete: losing it
 * costs one CLI spawn to rebuild, never correctness.
 *
 * @module dsh-qoder-connect/catalog-store
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

/** One persisted roster row. */
export interface QoderSavedModel {
  /** The DSH-facing model id. */
  id: string
  /** The CLI's own spelling. */
  name: string
}

/** The persisted document. */
export interface QoderSavedRoster {
  /** Schema version; anything else is discarded rather than migrated. */
  version: 1
  /** Epoch ms when a live answer was last persisted. */
  savedAt: number
  /** The roster, in the order the CLI reported it. */
  models: QoderSavedModel[]
}

/** Where the saved roster lives: `$DSH_HOME/qoder-connect/roster.json`. */
export function qoderRosterPath(): string {
  return dshHomePath('qoder-connect', 'roster.json')
}

/**
 * Read the saved roster.
 *
 * Every failure mode — missing file, unreadable JSON, a foreign schema, an
 * empty or malformed roster — answers `null` rather than throwing, because
 * the caller's fallback (the built-in list) is a perfectly good answer and a
 * corrupt cache must never cost the plugin its startup.
 */
export async function loadQoderRoster(): Promise<QoderSavedRoster | null> {
  try {
    const raw = await readFile(qoderRosterPath(), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return null
    const document = parsed as Partial<QoderSavedRoster>
    if (document.version !== 1) return null
    if (!Array.isArray(document.models) || document.models.length === 0) return null
    const models: QoderSavedModel[] = []
    for (const entry of document.models) {
      if (typeof entry !== 'object' || entry === null) return null
      const row = entry as Partial<QoderSavedModel>
      if (typeof row.id !== 'string' || row.id === '') return null
      if (typeof row.name !== 'string' || row.name === '') return null
      models.push({ id: row.id, name: row.name })
    }
    return {
      version: 1,
      savedAt: typeof document.savedAt === 'number' && Number.isFinite(document.savedAt) ? document.savedAt : 0,
      models,
    }
  } catch {
    // Absent or unreadable is the ordinary case on a first run.
    return null
  }
}

/**
 * Persist a live roster.
 *
 * Written through a temp file and a rename so a crash mid-write cannot leave
 * a truncated document behind — the next read would otherwise discard the
 * whole cache over a half-written line.
 *
 * Never throws: a failed write costs the next restart's tier, not this run.
 */
export async function saveQoderRoster(models: readonly QoderSavedModel[]): Promise<void> {
  if (models.length === 0) return
  try {
    const dir = dshHomePath('qoder-connect')
    await mkdir(dir, { recursive: true })
    const target = qoderRosterPath()
    const temporary = `${target}.${process.pid}.tmp`
    const document: QoderSavedRoster = { version: 1, savedAt: Date.now(), models: [...models] }
    await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
    await rename(temporary, target)
  } catch {
    // Best-effort by design; see the module comment.
  }
}
