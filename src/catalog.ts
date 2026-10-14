/**
 * The qoder model catalog: the served roster plus its visibility.
 *
 * The roster starts as the built-in {@link QODER_MODELS} fallback and is
 * replaced by whatever `qoderclicn --list-models` reports, so a model Qoder
 * adds later appears without a plugin update. Visibility is separate from the
 * roster because an empty roster is how DSH hides a model group: a machine
 * with no CLI or no login must not offer the Qoder models at all, and a login
 * that happens while DSH is running must reveal them without re-registering
 * the provider.
 *
 * @module dsh-qoder-connect/catalog
 */

import { QODER_MODELS, type QoderModel } from './qoder.ts'

/** One served model row. */
export interface QoderCatalogEntry {
  /** The DSH-facing model id. */
  id: string
  /** The CLI's own spelling, shown as the display name. */
  name: string
}

/** The live catalog: the roster plus its current visibility. */
export class QoderCatalog {
  private entries: readonly QoderCatalogEntry[]
  private visible = false
  /** Where the current roster came from, for the settings card. */
  private rosterSource: 'builtin' | 'cli' = 'builtin'

  constructor(models: readonly QoderModel[] = QODER_MODELS) {
    this.entries = models.map(model => ({ id: model.externalId, name: model.cliModel }))
  }

  /** The rows to serve; empty while hidden. */
  current(): readonly QoderCatalogEntry[] {
    return this.visible ? this.entries : []
  }

  /** Every row, whether or not the group is currently shown. */
  all(): readonly QoderCatalogEntry[] {
    return this.entries
  }

  /** Whether the group is currently shown. */
  isVisible(): boolean {
    return this.visible
  }

  /** Whether the roster is the CLI's live answer or the built-in fallback. */
  source(): 'builtin' | 'cli' {
    return this.rosterSource
  }

  /**
   * Set visibility.
   * @returns whether the state actually changed.
   */
  setVisible(visible: boolean): boolean {
    if (this.visible === visible) return false
    this.visible = visible
    return true
  }

  /**
   * Replace the roster with a freshly fetched one.
   *
   * An empty `models` is refused: DSH hides a group whose roster is empty, so
   * accepting one would make a transient CLI hiccup look like "Qoder has no
   * models". Callers pass `null` through from the fetch instead of reaching
   * here.
   *
   * @returns whether the served rows actually changed.
   */
  setModels(models: readonly QoderModel[], source: 'builtin' | 'cli' = 'cli'): boolean {
    if (models.length === 0) return false
    const next = models.map(model => ({ id: model.externalId, name: model.cliModel }))
    const same = next.length === this.entries.length
      && next.every((entry, index) => entry.id === this.entries[index]?.id && entry.name === this.entries[index]?.name)
    this.rosterSource = source
    if (same) return false
    this.entries = next
    return true
  }
}
