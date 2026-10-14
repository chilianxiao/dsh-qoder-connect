/**
 * The official Qoder model catalog: per-model price, thinking levels and
 * context windows, read from the desktop/CLI client's own on-disk cache.
 *
 * WHY THIS EXISTS
 *
 * Qoder declares per-model facts the plugin cannot get from the CLI:
 * `qoderclicn --list-models` prints names only, and the chat response reports
 * `credits` with `original_credits` always equal, so nothing in the request
 * path reveals a multiplier. The official client *does* keep the full catalog
 * on disk at `<home>/.models/<uid>/catalog-v6`, but it is sealed in a QMC v1
 * container rather than plain JSON — which is why an earlier revision of this
 * plugin concluded no price data was reachable and fell back to *measuring*
 * ratios from the local usage ledger. That measurement was wrong: it compared
 * average credits per call while cost also tracks answer length and thinking
 * depth (two runs with identical 31-character prompts billed 7.43 and 0.61
 * credits), and against this file's own numbers it was off by ~24x.
 *
 * The container is deterministic and the key is not a secret — it is derived
 * from the account uid, which sits in plaintext in the sibling `default` file:
 *
 *   envelope = base64("QMC\x01" + nonce[12] + ciphertext || tag)
 *   key      = HKDF-SHA256(ikm = uid, salt = "qoder-model-cache-enc",
 *                          info = "model-cache-v1", length = 32)
 *   cipher   = AES-256-GCM
 *
 * Node's built-in `crypto` covers all of it, so this module adds no
 * dependency and performs no network access.
 *
 * EVERYTHING HERE IS BEST-EFFORT. A missing file, an unreadable one, a
 * failed tag check or an unexpected shape all answer `null`, and the caller
 * keeps whatever it had. The picker must keep working on a machine that has
 * never opened the official client.
 *
 * @module dsh-qoder-connect/model-catalog
 */

import { createDecipheriv, hkdfSync } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

/** Magic prefix of a QMC v1 envelope. */
const QMC_MAGIC = 'QMC\x01'

/** HKDF inputs for the catalog key; fixed by the client's implementation. */
const QMC_HKDF_SALT = 'qoder-model-cache-enc'
const QMC_HKDF_INFO = 'model-cache-v1'

/**
 * The scene whose model set this plugin serves.
 *
 * The document groups models by scene (`chat`, `developer`, `assistant`,
 * `quest`, …). This plugin serves Chat Completions, so `chat` is the right
 * set; the others describe surfaces with their own rosters.
 */
const CATALOG_SCENE = 'chat'

/** The thinking levels pi-ai understands, which the effort map is keyed by. */
const PI_THINKING_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

/** One off-peak promotion window. */
export interface QoderPromotion {
  /** Multiplier applied inside the window (e.g. 0.4 = 40% of the peak price). */
  discountFactor: number
  /** Window start, `HH:MM` in the promotion's own timezone. */
  windowStart: string
  /** Window end, `HH:MM`. */
  windowEnd: string
  /** The upstream's own badge text, when it supplied one. */
  badge: string | null
  /** IANA timezone the window is expressed in. */
  timezone: string | null
}

/** The catalog facts for one model. */
export interface QoderModelFacts {
  /** Upstream model key, e.g. `qmodel_latest` (what `x-model-key` would carry). */
  key: string
  /** The upstream's own display name, as the CLI also spells it. */
  displayName: string
  /**
   * Official price multiplier. `0` with `free` set means the model is
   * currently free rather than free of charge forever, so keep the two
   * together when rendering.
   */
  priceFactor: number | null
  /** The pre-promotion price, present when a promotion is configured. */
  originalPriceFactor: number | null
  /** Whether the upstream marks the model as carrying a free allowance. */
  free: boolean
  /** The configured off-peak promotion, when there is one. */
  promotion: QoderPromotion | null
  /** Default context window in tokens, when the catalog declares one. */
  contextWindow: number | null
  /** Every context window the official client offers for this model. */
  contextWindows: readonly number[]
  /**
   * Thinking efforts the upstream actually accepts, in the catalog's own
   * order. Empty means the model has no discrete levels.
   *
   * This matters because the upstream SILENTLY IGNORES an unsupported effort
   * rather than rejecting it: sending `high` to a model that only serves
   * `low`/`medium`/`xhigh` succeeds and quietly falls back to the model's
   * default. Declaring the true set is therefore the only way the picker can
   * avoid offering a control that does nothing.
   */
  efforts: readonly string[]
  /** The effort the upstream marks as default, when it marks one. */
  defaultEffort: string | null
  /** Whether the catalog declares thinking can be turned off entirely. */
  canDisableThinking: boolean
  /**
   * Whether the model declares images (`is_vl`). Recorded for diagnostics
   * only — the CLI's prompt is one argv string, so this plugin still cannot
   * forward an image and deliberately does not advertise the capability.
   */
  supportsImages: boolean
}

/** One successfully read catalog. */
export interface QoderCatalogSnapshot {
  /** Facts keyed by the display name lowercased (how the CLI names models). */
  facts: ReadonlyMap<string, QoderModelFacts>
  /** The account uid the container was keyed by. */
  uid: string
  /** The file the facts came from, for diagnostics. */
  file: string
}

/** Options for {@link loadQoderModelFacts}. */
export interface LoadCatalogOptions {
  /** Home directory to probe; defaults to `os.homedir()`. */
  homeDir?: string
}

/** Candidate per-user directories, in probe order. */
function catalogHomeCandidates(homeDir: string): string[] {
  return [
    path.join(homeDir, '.qoder-cn'),    // Qoder CN CLI/desktop (verified)
    path.join(homeDir, '.qoder'),       // international qodercli
    path.join(homeDir, '.qoderworkcn'), // layout documented by proxy-hub
  ]
}

/**
 * Decrypt one QMC v1 container.
 *
 * Throws on a malformed envelope, a wrong key, or a failed tag check — the
 * caller treats every throw as "no catalog". AES-256-GCM's tag is what makes
 * a wrong `uid` detectable rather than silently producing garbage.
 *
 * @param blob - the file's contents (base64 text).
 * @param uid - the account uid the key is derived from.
 * @returns the decrypted UTF-8 document.
 */
export function decryptQmcCatalog(blob: string, uid: string): string {
  const envelope = Buffer.from(blob.trim(), 'base64')
  if (envelope.length < 4 + 12 + 16) throw new Error('QMC envelope too short')
  if (envelope.subarray(0, 4).toString('latin1') !== QMC_MAGIC) {
    throw new Error('not a QMC v1 envelope')
  }
  const nonce = envelope.subarray(4, 16)
  const sealed = envelope.subarray(16)
  const ciphertext = sealed.subarray(0, sealed.length - 16)
  const tag = sealed.subarray(sealed.length - 16)

  const key = Buffer.from(hkdfSync(
    'sha256',
    Buffer.from(uid, 'utf8'),
    Buffer.from(QMC_HKDF_SALT, 'utf8'),
    Buffer.from(QMC_HKDF_INFO, 'utf8'),
    32,
  ))
  const decipher = createDecipheriv('aes-256-gcm', key, nonce)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
}

/** Read a number, or null when the field is absent or not finite. */
function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** Read a non-empty string, or null. */
function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

/** Parse the promotion object, or null when absent or unusable. */
function parsePromotion(raw: unknown): QoderPromotion | null {
  if (typeof raw !== 'object' || raw === null) return null
  const promo = raw as Record<string, unknown>
  const discount = num(promo['discount_factor'])
  if (discount === null || discount <= 0) return null
  const badgeObj = promo['badge']
  const badge = typeof badgeObj === 'object' && badgeObj !== null
    // The upstream ships zh/en; prefer Chinese to match this plugin's copy.
    ? str((badgeObj as Record<string, unknown>)['zh']) ?? str((badgeObj as Record<string, unknown>)['en'])
    : null
  return {
    discountFactor: discount,
    windowStart: str(promo['window_start']) ?? '',
    windowEnd: str(promo['window_end']) ?? '',
    badge,
    timezone: str(promo['timezone']),
  }
}

/**
 * Parse one catalog entry's context windows.
 *
 * `context_config` is a map of label → `{token_count, is_default?}`. The
 * entry's own default is what the official client uses, so it becomes this
 * model's window; `max_input_tokens` is the fallback and is deliberately NOT
 * treated as the window, because it is a hard input cap rather than the
 * client's configured working window.
 */
function parseContext(raw: Record<string, unknown>): { contextWindow: number | null; contextWindows: number[] } {
  const config = raw['context_config']
  const windows: number[] = []
  let preferred: number | null = null
  if (typeof config === 'object' && config !== null && !Array.isArray(config)) {
    for (const entry of Object.values(config as Record<string, unknown>)) {
      if (typeof entry !== 'object' || entry === null) continue
      const record = entry as Record<string, unknown>
      const count = num(record['token_count'])
      if (count === null || count <= 0) continue
      windows.push(count)
      if (record['is_default'] === true) preferred = count
    }
  }
  windows.sort((a, b) => a - b)
  const fallback = num(raw['max_input_tokens'])
  const contextWindow = preferred ?? (fallback !== null && fallback > 0 ? fallback : null)
  return { contextWindow, contextWindows: windows }
}

/**
 * Parse one catalog entry's thinking capability.
 *
 * The shape is `thinking_config: { disabled?: {}, enabled?: { efforts?: {...},
 * is_default?: true } }`. A model with no `thinking_config` at all (the `auto`
 * router, MiniMax) offers no control; a model with `enabled` but no `efforts`
 * offers only on/off, which pi-ai cannot express as a level either — so both
 * yield an empty effort list, and the adapter withholds the picker rather
 * than showing one whose every option is ignored upstream.
 */
function parseThinking(raw: Record<string, unknown>): {
  efforts: string[]
  defaultEffort: string | null
  canDisableThinking: boolean
} {
  const config = raw['thinking_config']
  if (typeof config !== 'object' || config === null) {
    return { efforts: [], defaultEffort: null, canDisableThinking: false }
  }
  const record = config as Record<string, unknown>
  const canDisableThinking = typeof record['disabled'] === 'object' && record['disabled'] !== null
  const enabled = record['enabled']
  if (typeof enabled !== 'object' || enabled === null) {
    return { efforts: [], defaultEffort: null, canDisableThinking }
  }
  const enabledRecord = enabled as Record<string, unknown>
  const rawEfforts = enabledRecord['efforts']
  if (typeof rawEfforts !== 'object' || rawEfforts === null) {
    return { efforts: [], defaultEffort: null, canDisableThinking }
  }
  const efforts: string[] = []
  let defaultEffort: string | null = null
  for (const [level, value] of Object.entries(rawEfforts as Record<string, unknown>)) {
    // Only levels pi-ai can name are usable; anything else would be an effort
    // the picker cannot represent.
    if (!(PI_THINKING_LEVELS as readonly string[]).includes(level)) continue
    efforts.push(level)
    if (typeof value === 'object' && value !== null && (value as Record<string, unknown>)['is_default'] === true) {
      defaultEffort = level
    }
  }
  // Keep the catalog's order but put the default last-free ordering aside:
  // callers only need membership, and the default is carried separately.
  return { efforts, defaultEffort, canDisableThinking }
}

/**
 * Parse one decrypted catalog document into per-model facts.
 *
 * Exported separately from decryption so the parsing rules can be tested
 * against a literal document without constructing an encrypted container.
 *
 * @param document - the decrypted JSON text.
 * @returns facts keyed by lowercased display name; empty when unusable.
 */
export function parseCatalogDocument(document: string): Map<string, QoderModelFacts> {
  const facts = new Map<string, QoderModelFacts>()
  let parsed: unknown
  try {
    parsed = JSON.parse(document)
  } catch {
    return facts
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return facts
  const scene = (parsed as Record<string, unknown>)[CATALOG_SCENE]
  if (!Array.isArray(scene)) return facts

  for (const entry of scene) {
    if (typeof entry !== 'object' || entry === null) continue
    const raw = entry as Record<string, unknown>
    const displayName = str(raw['display_name'])
    const key = str(raw['key'])
    if (displayName === null || key === null) continue
    const thinking = parseThinking(raw)
    const context = parseContext(raw)
    facts.set(displayName.toLowerCase(), {
      key,
      displayName,
      priceFactor: num(raw['price_factor']),
      originalPriceFactor: num(raw['original_price_factor']),
      free: raw['is_free'] === true,
      promotion: parsePromotion(raw['promotion']),
      contextWindow: context.contextWindow,
      contextWindows: context.contextWindows,
      efforts: thinking.efforts,
      defaultEffort: thinking.defaultEffort,
      canDisableThinking: thinking.canDisableThinking,
      supportsImages: raw['is_vl'] === true,
    })
  }
  return facts
}

/** Read the account uid the catalog is keyed by, from the sibling `default` file. */
async function readUid(modelsDir: string): Promise<string | null> {
  try {
    const parsed = JSON.parse(await readFile(path.join(modelsDir, 'default'), 'utf8')) as { uid?: unknown }
    return str(parsed.uid)
  } catch {
    return null
  }
}

/**
 * Locate the newest readable `catalog-v6` under a models directory.
 *
 * The directory is named by uid, and `default` names the active one; the uid
 * is taken from the directory name (the key must match the container's) while
 * `default` only decides which to prefer when several exist.
 */
async function findCatalogFile(modelsDir: string): Promise<{ file: string; uid: string } | null> {
  let dirs: string[]
  try {
    dirs = await readdir(modelsDir)
  } catch {
    return null
  }
  const preferredUid = await readUid(modelsDir)
  const candidates: Array<{ file: string; uid: string; mtime: number }> = []
  for (const name of dirs) {
    const file = path.join(modelsDir, name, 'catalog-v6')
    if (!existsSync(file)) continue
    try {
      const info = await stat(file)
      candidates.push({ file, uid: name, mtime: info.mtimeMs })
    } catch {
      // Unreadable entry: skip it, another may serve.
    }
  }
  if (candidates.length === 0) return null
  const preferred = preferredUid === null ? undefined : candidates.find(c => c.uid === preferredUid)
  const chosen = preferred ?? candidates.sort((a, b) => b.mtime - a.mtime)[0]
  return chosen === undefined ? null : { file: chosen.file, uid: chosen.uid }
}

/**
 * Read, decrypt and parse the official catalog.
 *
 * Never throws: every failure — no client installed, no cache yet, a changed
 * container format, a tampered file — answers `null`, and the caller keeps
 * serving models without the extra facts.
 */
export async function loadQoderModelFacts(options: LoadCatalogOptions = {}): Promise<QoderCatalogSnapshot | null> {
  const homeDir = options.homeDir ?? homedir()
  for (const home of catalogHomeCandidates(homeDir)) {
    const found = await findCatalogFile(path.join(home, '.models'))
    if (found === null) continue
    try {
      const blob = await readFile(found.file, 'utf8')
      const facts = parseCatalogDocument(decryptQmcCatalog(blob, found.uid))
      if (facts.size === 0) continue
      return { facts, uid: found.uid, file: found.file }
    } catch {
      // A different layout may still work; try the next candidate.
    }
  }
  return null
}

/**
 * The pi-ai thinking-level map for one model.
 *
 * Every level is decided explicitly. `off` and `minimal` are always `null`:
 * pi-ai sends `thinkingLevelMap.off` on EVERY request that names no level, so
 * giving it a string would silently disable thinking by default instead of
 * leaving the CLI's own default in place, and the upstream has no `minimal`.
 *
 * @param facts - the model's facts, or undefined when the catalog is unread.
 * @returns the map, or null when the model offers no discrete level (the
 *   caller then declares no reasoning at all, so the picker offers nothing
 *   rather than a control that cannot do what it says).
 */
export function thinkingLevelMapFor(facts: QoderModelFacts | undefined): Record<string, string | null> | null {
  if (facts === undefined || facts.efforts.length === 0) return null
  const map: Record<string, string | null> = { off: null, minimal: null }
  for (const level of PI_THINKING_LEVELS) {
    // The official effort names are also the CLI's `--reasoning-effort`
    // spellings, so the declared value is the wire value.
    map[level] = facts.efforts.includes(level) ? level : null
  }
  return map
}

/**
 * Format a model's official price for its display name.
 *
 * The spelling follows dsh-workbuddy-connect (`x0.79`) because the value is
 * the same kind of fact there and here — a multiplier the vendor publishes —
 * so unlike the measured ratio this replaced, it does not overstate itself.
 * The off-peak badge is appended when the catalog configures one, since the
 * discount is invisible in the static multiplier.
 */
export function formatQoderPrice(facts: QoderModelFacts | undefined): string {
  if (facts === undefined) return ''
  const parts: string[] = []
  if (facts.priceFactor !== null) parts.push(`x${facts.priceFactor}`)
  if (facts.free && facts.priceFactor === 0) parts.push('限时免费')
  else if (facts.promotion !== null && facts.promotion.badge !== null) parts.push(facts.promotion.badge)
  return parts.length === 0 ? '' : ` · ${parts.join(' · ')}`
}
