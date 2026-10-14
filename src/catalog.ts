/**
 * The qoder model catalog: the served roster plus its visibility.
 *
 * The roster starts as the built-in {@link QODER_MODELS} fallback and is
 * replaced by whatever `qoderclicn --list-models` reports, so a model Qoder
 * adds later appears without a plugin update. Between those two sits the
 * saved tier: the last live answer, persisted across restarts, so a machine
 * whose CLI cannot answer *right now* still serves this account's real roster
 * instead of falling back to the compiled snapshot.
 *
 * Visibility is separate from the roster because an empty roster is how DSH
 * hides a model group: a machine with no CLI or no login must not offer the
 * Qoder models at all, and a login that happens while DSH is running must
 * reveal them without re-registering the provider.
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

/** Where the current roster came from, best tier first. */
export type QoderRosterSource = 'cli' | 'saved' | 'builtin'

/** The live catalog: the roster plus its current visibility. */
export class QoderCatalog {
  private entries: readonly QoderCatalogEntry[]
  private visible = false
  /** Where the current roster came from, for the settings card. */
  private rosterSource: QoderRosterSource = 'builtin'
  /**
   * Model ids the user switched off. Kept apart from the roster because it is
   * a user preference, not a fact about Qoder: the roster is replaced wholesale
   * by every refresh, while a hidden id must survive one — otherwise switching
   * a model off would silently un-hide it the next time the CLI answered.
   */
  private hidden = new Set<string>()

  constructor(models: readonly QoderModel[] = QODER_MODELS) {
    this.entries = models.map(model => ({ id: model.externalId, name: model.cliModel }))
  }

  /** The rows to serve; empty while hidden. */
  current(): readonly QoderCatalogEntry[] {
    if (!this.visible) return []
    return this.entries.filter(entry => !this.hidden.has(entry.id))
  }

  /** Every row, whether or not the group is currently shown. */
  all(): readonly QoderCatalogEntry[] {
    return this.entries
  }

  /** Every row with its on/off state, for the card's model switches. */
  withVisibility(): Array<QoderCatalogEntry & { on: boolean }> {
    return this.entries.map(entry => ({ ...entry, on: !this.hidden.has(entry.id) }))
  }

  /** The ids currently switched off. */
  hiddenIds(): readonly string[] {
    return [...this.hidden]
  }

  /** Whether the group is currently shown. */
  isVisible(): boolean {
    return this.visible
  }

  /** Where the current roster came from. */
  source(): QoderRosterSource {
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
   * Replace the set of switched-off model ids.
   *
   * Ids the roster does not know are kept anyway: a model hidden while the
   * built-in fallback served must stay hidden after the CLI's own roster
   * arrives, or the switch would appear to undo itself.
   *
   * @returns whether the served rows actually changed.
   */
  setHidden(ids: readonly string[]): boolean {
    const next = new Set(ids.filter(id => typeof id === 'string' && id !== ''))
    const same = next.size === this.hidden.size && [...next].every(id => this.hidden.has(id))
    if (same) return false
    this.hidden = next
    return true
  }

  /**
   * Adopt the persisted roster from a previous run.
   *
   * Only ever called at startup, before the CLI is asked: it is the tier that
   * keeps a restart from showing the compiled snapshot while the real answer
   * is still being fetched. A live answer that arrives later replaces it
   * through {@link setModels} and is persisted in turn.
   *
   * @returns whether the served rows actually changed.
   */
  hydrate(entries: readonly QoderCatalogEntry[]): boolean {
    if (entries.length === 0) return false
    const same = entries.length === this.entries.length
      && entries.every((entry, index) => entry.id === this.entries[index]?.id && entry.name === this.entries[index]?.name)
    if (same && this.rosterSource === 'saved') return false
    this.entries = entries.map(entry => ({ id: entry.id, name: entry.name }))
    this.rosterSource = 'saved'
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
  setModels(models: readonly QoderModel[], source: 'cli' | 'builtin' = 'cli'): boolean {
    if (models.length === 0) return false
    const next = models.map(model => ({ id: model.externalId, name: model.cliModel }))
    const same = next.length === this.entries.length
      && next.every((entry, index) => entry.id === this.entries[index]?.id && entry.name === this.entries[index]?.name)
    const changed = !same || this.rosterSource !== source
    this.rosterSource = source
    if (same) return changed
    this.entries = next
    return true
  }
}
