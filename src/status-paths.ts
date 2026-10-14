/**
 * Node-free constants and types shared by the Host and browser halves.
 *
 * @module dsh-qoder-connect/status-paths
 */

/** Plugin-owned status endpoint consumed by its browser half. */
export const QODER_STATUS_PATH = '/plugins/dsh-qoder-connect/status'

/**
 * Same-origin write endpoint for the reasoning controls. The card's settings
 * page owns editing; this exists so the controls live on the plugin's own
 * card rather than the generic settings form.
 */
export const QODER_CONFIG_PATH = '/plugins/dsh-qoder-connect/config'

/** One model as the settings card displays it. */
export interface QoderWebModel {
  id: string
  /** The CLI's own spelling, e.g. `Qwen3.8-Max`. */
  name: string
}

/** The reasoning controls currently in effect, as the card renders them. */
export interface QoderWebReasoning {
  /** Selected `--reasoning-effort`, or '' when the flag is not sent. */
  effort: string
  /** Selected `--thinking` mode, or '' when the flag is not sent. */
  thinking: string
  /** Selected `--thinking-budget`, or 0 when the flag is not sent. */
  budget: number
}

/**
 * Where the served model roster came from.
 *
 * `cli` means `qoderclicn --list-models` answered, so the picker shows this
 * account's own models — including any Qoder added after this plugin
 * shipped. `builtin` means the fetch did not answer and the shipped fallback
 * stands, which is worth surfacing: a silently stale roster is exactly what
 * makes a newly added model look missing.
 */
export type QoderRosterSource = 'cli' | 'builtin'

/** The JSON document the plugin card renders. */
export type QoderWebStatus =
  | {
    status: 'ready'
    /** The resolved CLI command. */
    cli: string
    /** Whether the OAuth login state file or a PAT is in use. */
    source: 'oauth' | 'pat'
    /** The OAuth state file probed for, whether or not it exists. */
    oauthFile: string
    /** Human-readable readiness explanation. */
    reason: string
    models: readonly QoderWebModel[]
    /** The reasoning controls in effect for this configuration. */
    reasoning: QoderWebReasoning
    /** Whether the roster is the CLI's live answer or the built-in fallback. */
    rosterSource: QoderRosterSource
  }
  | {
    status: 'not-ready'
    /** Why no chat request can be served right now. */
    reason: string
    /** The resolved CLI command when one was found. */
    cli?: string
    /** Whether an OAuth login state file exists on disk. */
    oauth: boolean
    /** Whether a PAT is available. */
    pat: boolean
    /** The OAuth state file probed for. */
    oauthFile: string
    /** The reasoning controls in effect for this configuration. */
    reasoning: QoderWebReasoning
    /** Whether the roster is the CLI's live answer or the built-in fallback. */
    rosterSource: QoderRosterSource
  }
  | { status: 'error'; message: string }
