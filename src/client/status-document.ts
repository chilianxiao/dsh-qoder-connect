/** Shape check for the status document, read by the card. */

import type { QoderWebStatus } from '../status-paths.ts'

/**
 * Whether a parsed status response really is a status document.
 *
 * A 200 is not a promise about the body: it may be empty, literal `null`, a
 * non-JSON page from a proxy, or an array. Storing an unreadable value puts
 * something in state that the next render dereferences.
 *
 * The check is deliberately limited to the discriminator (plus `error`'s
 * `message`, which the error paragraph renders): validating optional fields
 * here would reject documents the host legitimately omits fields from.
 */
export function isQoderWebStatus(value: unknown): value is QoderWebStatus {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const wrapped = value as Record<string, unknown>
  const status = wrapped['status']
  if (status === 'ready' || status === 'not-ready') return true
  return status === 'error' && typeof wrapped['message'] === 'string'
}
