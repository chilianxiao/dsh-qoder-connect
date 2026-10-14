/**
 * Image attachments for the qoder route.
 *
 * The CLI's prompt is one argv string, which is why this plugin long declared
 * `input: ['text']`. That reasoning was incomplete: `qoderclicn` also accepts
 * `--attachment <file>`, and the upstream models the official catalog marks
 * `is_vl` really do read the attached image — verified by handing the CLI a
 * logo and getting its text back. So an image never has to be flattened into
 * the prompt at all; it rides as a file path beside it.
 *
 * What this module does is only the plumbing between the two surfaces: DSH
 * sends images as base64 data URLs inside OpenAI message content parts, and
 * the CLI wants filesystem paths. So the data URLs are decoded into a
 * private temp directory whose lifetime is exactly one run.
 *
 * Three deliberate restrictions, all inherited from the CLI surface rather
 * than invented here:
 *
 * - **Data URLs only.** A remote `http(s)` image URL is skipped, not fetched:
 *   the plugin makes no upstream HTTP request anywhere, and DSH's own
 *   attachment pipeline hands images over as data URLs.
 * - **base64 only.** A percent-encoded data URL carries no bytes to decode.
 * - **Bounded.** The host already caps request images (see the adapter's
 *   REQUEST_IMAGE_BUDGETS); a second, independent ceiling here keeps a
 *   malformed or hostile body from filling the temp volume.
 *
 * @module dsh-qoder-connect/images
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

/** Independent ceiling on one decoded image, in bytes. */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024

/** Ceiling on how many images one request may materialize. */
const MAX_IMAGE_COUNT = 16

/** Media type → file extension, so the CLI can sniff what it was handed. */
const EXTENSIONS: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
  'image/heic': '.heic',
  'image/heif': '.heif',
}

/** What {@link materializeImageAttachments} produced for one run. */
export interface QoderImageMaterial {
  /** Temp file paths to pass as `--attachment`, in the order they appeared. */
  paths: string[]
  /**
   * Image parts that were seen but could not be turned into a file — a
   * remote URL, an unsupported encoding, an oversized body, or a malformed
   * data URL. Surfaced so a caller can tell "no images" from "images lost".
   */
  skipped: number
}

/**
 * Decode one base64 data URL.
 *
 * @returns the bytes and a file extension, or null when the URL is not a
 *   base64 data URL of a supported image type.
 */
function decodeDataUrl(url: string): { bytes: Buffer; extension: string } | null {
  const match = /^data:([^;,]*)?(;base64)?,(.*)$/s.exec(url)
  if (match === null) return null
  const mediaType = (match[1] ?? '').trim().toLowerCase()
  if (match[2] === undefined) return null
  const payload = match[3] ?? ''
  if (payload === '') return null
  const extension = EXTENSIONS[mediaType]
  if (extension === undefined) return null
  let bytes: Buffer
  try {
    bytes = Buffer.from(payload, 'base64')
  } catch {
    return null
  }
  // A truncated or non-base64 payload decodes to garbage rather than throwing;
  // re-encoding is the cheapest sanity check that real bytes came back. Both
  // sides are normalized the same way so a line-wrapped data URL — which some
  // encoders emit — still round-trips instead of being rejected as corrupt.
  if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) return null
  const normalizedPayload = payload.replace(/\s/g, '').replace(/=+$/, '')
  const normalizedRoundTrip = bytes.toString('base64').replace(/=+$/, '')
  if (normalizedRoundTrip !== normalizedPayload) return null
  return { bytes, extension }
}

/**
 * Pull the image URL out of one OpenAI content part.
 *
 * The shape this plugin actually receives is `{ type: 'image_url',
 * image_url: { url } }`. The Anthropic-style `{ type: 'image', source: {...} }`
 * is accepted too because both spellings reach OpenAI-compatible surfaces in
 * the wild, and a part of either shape with a `data:` URL is the same job.
 */
function imageUrlOf(part: unknown): string | null {
  if (typeof part !== 'object' || part === null) return null
  const record = part as { type?: unknown; image_url?: unknown; imageUrl?: unknown; source?: unknown; url?: unknown }
  const type = typeof record.type === 'string' ? record.type : ''
  if (type !== 'image_url' && type !== 'image') return null

  const nested = record.image_url ?? record.imageUrl
  if (typeof nested === 'object' && nested !== null) {
    const url = (nested as { url?: unknown }).url
    if (typeof url === 'string' && url !== '') return url
  }
  if (typeof nested === 'string' && nested !== '') return nested

  // Anthropic-style inline base64 source, normalized to a data URL.
  const source = record.source
  if (typeof source === 'object' && source !== null) {
    const src = source as { type?: unknown; media_type?: unknown; mediaType?: unknown; data?: unknown }
    if (src.type === 'base64' && typeof src.data === 'string' && src.data !== '') {
      const mediaType = typeof src.media_type === 'string'
        ? src.media_type
        : typeof src.mediaType === 'string' ? src.mediaType : 'image/png'
      return `data:${mediaType};base64,${src.data}`
    }
  }

  if (typeof record.url === 'string' && record.url !== '') return record.url
  return null
}

/**
 * Materialize every image in an OpenAI `messages` array as a temp file.
 *
 * The whole request shares one temp directory, so a caller that only keeps
 * {@link QoderImageMaterial.paths} can dispose of the run's scratch space with
 * a single recursive remove.
 *
 * Never throws: a filesystem failure while materializing is reported as
 * `skipped`, because losing an image must degrade the turn to text rather
 * than fail it.
 */
export async function materializeImageAttachments(messages: unknown): Promise<QoderImageMaterial> {
  const list = Array.isArray(messages) ? messages as Array<{ content?: unknown }> : []
  const urls: string[] = []
  for (const message of list) {
    const content = message?.content
    if (!Array.isArray(content)) continue
    for (const part of content) {
      const url = imageUrlOf(part)
      if (url !== null) urls.push(url)
    }
  }
  if (urls.length === 0) return { paths: [], skipped: 0 }

  const dir = await mkdtemp(join(tmpdir(), 'dsh-qoder-connect-img-'))
  const paths: string[] = []
  let skipped = 0
  let index = 0
  for (const url of urls) {
    if (paths.length >= MAX_IMAGE_COUNT) {
      skipped += 1
      continue
    }
    const decoded = decodeDataUrl(url)
    if (decoded === null) {
      skipped += 1
      continue
    }
    index += 1
    // A random suffix keeps two concurrent runs from colliding even though
    // each already owns its own directory.
    const file = join(dir, `img-${index}-${randomBytes(4).toString('hex')}${decoded.extension}`)
    try {
      await writeFile(file, decoded.bytes)
      paths.push(file)
    } catch {
      skipped += 1
    }
  }
  if (paths.length === 0) {
    // Nothing survived; do not leave an empty directory behind.
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
  return { paths, skipped }
}

/**
 * Remove one run's materialized images.
 *
 * Every path came from the same temp directory, so the directory is removed
 * recursively and the individual paths are best-effort. Never throws.
 */
export async function disposeImageAttachments(paths: readonly string[]): Promise<void> {
  if (paths.length === 0) return
  const dirs = new Set<string>()
  for (const file of paths) {
    // The directory is the parent of every file this call handed out.
    await rm(file, { force: true }).catch(() => undefined)
    dirs.add(join(file, '..'))
  }
  for (const dir of dirs) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}
