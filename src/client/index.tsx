/** Browser half: Qoder readiness inside Plugin configuration. */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// `slots` service (Context augmentation) — the renderer owns the registry.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// `locale` service (Context augmentation).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Declares the `plugins.item` list slot and its `PluginConfigViewProps` owner share.
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { QoderPluginCard } from './QoderPluginCard.tsx'
import { en, zh } from './locales.ts'
import type { QoderSettingsKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Qoder plugin card copy. */
    'settings.qoder': QoderSettingsKey
  }
}

/** Stable browser-plugin name. */
export const name = 'dsh-qoder-connect-client'

/**
 * Client services required by the Plugin configuration contribution.
 *
 * The `slots` registry lives in `@deepseek-ai/dsh-client-ui-renderer`, the
 * `locale` service in `@deepseek-ai/dsh-client-locale`, and the
 * `plugins.item` slot is declared by
 * `@deepseek-ai/dsh-client-ui-plugin-manager`. All three are named in the
 * package's `dsh.client.inject` list, so cordis has activated them before
 * this plugin's fiber starts.
 */
export const inject = ['slots', 'locale']

/** The card's entry id inside the `plugins.item` list slot. */
const CARD_ID = 'dsh-qoder-connect'

/**
 * Register card copy and the Qoder card under Plugin configuration.
 *
 * The entire body is wrapped so that a DSH slot-API breaking change degrades
 * to a `console.error` instead of throwing into the DSH loader and raising
 * the red "Failed to load plugins" banner. The host provider keeps working:
 * the `qoder` model channel is unaffected, and `dsh-qoder-connect status`
 * reports readiness without a browser.
 */
export function apply(ctx: ClientContext): void {
  try {
    const namespace = 'settings.qoder'
    ctx.effect(() => ctx.locale.register(namespace, { zh, en }), 'dsh-qoder-connect: settings copy')
    ctx.slots.inject('plugins.item', () => ctx.slots.register({
      name: 'plugins.item',
      id: CARD_ID,
      // List display order: after the bundles' own rows, before ad-hoc additions.
      order: 30,
      label: 'Qoder',
      // The framework synthesizes the `t` seat from this namespace's dictionary.
      locale: namespace,
    }, QoderPluginCard))
  } catch (error: unknown) {
    // Degrade silently on the page: the host provider still serves models.
    // Developers see the full cause in the browser console; users see no banner.
    console.error('[dsh-qoder-connect] client card failed to load (host provider unaffected):', error)
  }
}
