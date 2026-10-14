/** Qoder status card contributed to the Plugins page's Official group. */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-locale/client'
import { QODER_CONFIG_PATH, QODER_STATUS_PATH } from '../status-paths.ts'
import type { QoderWebModel, QoderWebReasoning, QoderWebStatus } from '../status-paths.ts'
import { isQoderWebStatus } from './status-document.ts'
import { en } from './locales.ts'
import type { QoderSettingsCopy, QoderSettingsKey } from './locales.ts'

/**
 * The vocabularies the CLI accepts, duplicated from the host half because
 * the browser bundle cannot import `qoder.ts` (it reaches for node:child_process).
 * A value outside these lists makes the CLI exit before serving the request,
 * so the selects must never offer one.
 */
const EFFORT_LEVELS = ['auto', 'none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultracode'] as const
const THINKING_MODES = ['auto', 'adaptive', 'enabled', 'disabled'] as const
const MAX_THINKING_BUDGET = 1_000_000

/**
 * Card props: the `plugins.item` owner share (`view`), the framework
 * `t` seat synthesized from the declared namespace, and the runtime faces.
 *
 * `t` is deliberately optional with an English fallback: the seat is
 * framework-synthesized, and a card that cannot render its copy must still
 * render its status rather than throw into the page.
 */
export type QoderPluginCardProps =
  PropsRuntime<'plugins.item'>
  & { t?: TranslateNS<'settings.qoder'> | undefined }

const POLL_INTERVAL_MS = 60_000

const bodyStyle: CSSProperties = { margin: 0, fontSize: 14, lineHeight: '22px', color: 'var(--dsw-alias-label-secondary)' }
const errorStyle: CSSProperties = { ...bodyStyle, color: 'var(--dsw-alias-state-error-primary)' }
const rowStyle: CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }
const buttonStyle: CSSProperties = { boxSizing: 'border-box', minHeight: 34, padding: '6px 14px', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 18, background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)', font: 'inherit', fontSize: 14, cursor: 'pointer' }
const monoStyle: CSSProperties = { fontFamily: 'var(--dsw-alias-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)', fontSize: 12, wordBreak: 'break-all' }

/** Fallback translator: English copy, {name} placeholders interpolated. */
function fallbackT(key: QoderSettingsKey, params?: Record<string, unknown>): string {
  const template = (en as QoderSettingsCopy)[key] ?? key
  return params === undefined
    ? template
    : template.replace(/\{(\w+)\}/gu, (_match, name: string) => String(params[name] ?? ''))
}

/** One labeled fact row. */
function FactRow({ label, children }: { label: string; children: ReactNode }): ReactNode {
  return (
    <div style={rowStyle}>
      <span style={{ color: 'var(--dsw-alias-label-tertiary)', fontSize: 13 }}>{label}</span>
      <span style={{ textAlign: 'right' }}>{children}</span>
    </div>
  )
}

/** The model list, as a wrapped set of chips. */
function ModelChips({ models }: { models: readonly QoderWebModel[] }): ReactNode {
  if (models.length === 0) return null
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, paddingTop: 4 }}>
      {models.map(model => (
        <span
          key={model.id}
          style={{
            padding: '2px 10px',
            borderRadius: 999,
            fontSize: 12,
            lineHeight: '18px',
            background: 'var(--dsw-alias-bg-layer-1, rgba(127, 127, 127, 0.12))',
            color: 'var(--dsw-alias-label-secondary)',
          }}
        >
          {model.name}
        </span>
      ))}
    </div>
  )
}

/** Read the status document; `mode` decides whether the read repeats. */
function useQoderStatus(mode: 'off' | 'once' | 'poll'): {
  status: QoderWebStatus | undefined
  readFailure: string | undefined
  refresh: () => Promise<void>
  busy: boolean
} {
  const [status, setStatus] = useState<QoderWebStatus>()
  const [readFailure, setReadFailure] = useState<string>()
  const [busy, setBusy] = useState(false)
  const mounted = useRef(true)
  /**
   * Identity of the newest read that may write. Assigned when a read
   * *starts*, so a response is superseded by anything begun after it —
   * "the response whose request started last wins".
   */
  const readSeq = useRef(0)
  const manualControllers = useRef(new Set<AbortController>())

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      for (const controller of manualControllers.current) controller.abort()
      manualControllers.current.clear()
    }
  }, [])

  /**
   * Read the status document and apply it under the two policies the card's
   * correctness rests on:
   *
   * - a non-document body (empty, `null`, a non-JSON page) is a failed read,
   *   not something to store and then dereference in the render;
   * - a failed read never discards a document already on screen.
   */
  const read = useCallback(async (signal?: AbortSignal): Promise<void> => {
    const seq = ++readSeq.current
    const current = (): boolean => mounted.current && signal?.aborted !== true && seq === readSeq.current
    try {
      const response = await fetch(QODER_STATUS_PATH, {
        headers: { accept: 'application/json' },
        credentials: 'same-origin',
        ...signal === undefined ? {} : { signal },
      })
      const value: unknown = await response.json().catch(() => undefined)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      if (!isQoderWebStatus(value)) throw new Error('status response was not recognized')
      if (!current()) return
      setStatus(value)
      setReadFailure(undefined)
    } catch (error: unknown) {
      if (!current()) return
      const message = error instanceof Error ? error.message : 'request failed'
      setReadFailure(message)
      setStatus(previous => previous === undefined ? { status: 'error', message } : previous)
    }
  }, [])

  useEffect(() => {
    // The one-liner reads once so the card list always shows a real state;
    // the detail view additionally polls while it is the open page.
    if (mode === 'off') return
    const controller = new AbortController()
    void read(controller.signal)
    return () => { controller.abort() }
  }, [mode, read])

  useEffect(() => {
    // Gated on polling mode; a failed read must not disarm this effect, or
    // one transient error would leave the detail body blank.
    if (mode !== 'poll') return
    const controller = new AbortController()
    const timer = window.setInterval(() => { void read(controller.signal) }, POLL_INTERVAL_MS)
    return () => {
      controller.abort()
      window.clearInterval(timer)
    }
  }, [mode, read])

  const refresh = useCallback(async (): Promise<void> => {
    const controller = new AbortController()
    manualControllers.current.add(controller)
    setBusy(true)
    try {
      await read(controller.signal)
    } finally {
      manualControllers.current.delete(controller)
      setBusy(false)
    }
  }, [read])

  return { status, readFailure, refresh, busy }
}

/** The one-liner the card list and the detail header render. */
function SummaryLine({ status, t }: { status: QoderWebStatus | undefined; t: QoderPluginCardProps['t'] }): ReactNode {
  const translate = t ?? fallbackT
  if (status === undefined) return <span>{translate('refreshing')}</span>
  if (status.status === 'error') return <span style={errorStyle}>{status.message}</span>
  if (status.status === 'not-ready') {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <Dot ok={false} />
        {translate('notReady')}
        <span style={{ color: 'var(--dsw-alias-label-tertiary)' }}>{status.reason}</span>
      </span>
    )
  }
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <Dot ok />
      {translate('ready')}
      <span style={{ color: 'var(--dsw-alias-label-tertiary)' }}>{status.models.length} {translate('models')}</span>
    </span>
  )
}

function Dot({ ok }: { ok: boolean }): ReactNode {
  return (
    <span
      aria-hidden
      style={{
        width: 8,
        height: 8,
        borderRadius: 999,
        background: ok
          ? 'var(--dsw-alias-state-success-primary, #22a06b)'
          : 'var(--dsw-alias-state-error-primary, #d93025)',
      }}
    />
  )
}

/** The detail body the plugin's own page renders. */
function DetailBody({ status, readFailure, busy, onRefresh, onSaved, onRefetchModels, fetchingModels, modelNote, t }: {
  status: QoderWebStatus | undefined
  readFailure: string | undefined
  busy: boolean
  onRefresh: () => void
  onSaved: () => Promise<void>
  onRefetchModels: () => void
  fetchingModels: boolean
  modelNote: string | undefined
  t: QoderPluginCardProps['t']
}): ReactNode {
  const translate = t ?? fallbackT
  if (status === undefined) return <p style={bodyStyle}>{translate('refreshing')}</p>
  if (status.status === 'error') return <p style={errorStyle}>{status.message}</p>
  const ready = status.status === 'ready'
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={rowStyle}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 9, fontSize: 15, fontWeight: 500, color: 'var(--dsw-alias-label-primary)' }}>
          <Dot ok={ready} />
          {ready ? translate('ready') : translate('notReady')}
        </span>
        <button type="button" style={buttonStyle} disabled={busy} onClick={onRefresh}>
          {busy ? translate('refreshing') : translate('refresh')}
        </button>
      </div>
      {readFailure !== undefined ? <p style={errorStyle}>{readFailure}</p> : null}
      <FactRow label={translate('cli')}>
        <span style={monoStyle}>{status.cli ?? '—'}</span>
      </FactRow>
      <FactRow label={translate('login')}>
        {ready
          ? (status.source === 'oauth' ? translate('loginOauth') : translate('loginPat'))
          : (status.oauth ? translate('loginOauth') : status.pat ? translate('loginPat') : translate('loginNone'))}
      </FactRow>
      <FactRow label={translate('oauthFile')}>
        <span style={monoStyle}>{status.oauthFile}</span>
      </FactRow>
      <ReasoningControls initial={status.reasoning} onSaved={onSaved} t={t} />
      {!ready ? (
        <p style={bodyStyle}>
          {status.reason}
          {' '}
          {status.cli === undefined ? translate('hintCli') : translate('hintLogin')}
        </p>
      ) : null}
      {ready && status.models.length > 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={rowStyle}>
            <span style={{ color: 'var(--dsw-alias-label-tertiary)', fontSize: 13 }}>{translate('models')}</span>
            <button type="button" style={buttonStyle} disabled={fetchingModels} onClick={onRefetchModels}>
              {fetchingModels ? translate('refreshingModels') : translate('refreshModels')}
            </button>
          </div>
          <ModelChips models={status.models} />
          {/* Which roster is being served, because a stale built-in list is
              exactly what makes a model Qoder just added look missing. */}
          <span style={{ color: 'var(--dsw-alias-label-tertiary)', fontSize: 12 }}>
            {status.rosterSource === 'cli' ? translate('rosterCli') : translate('rosterBuiltin')}
          </span>
          {modelNote !== undefined ? <p style={errorStyle}>{modelNote}</p> : null}
        </div>
      ) : null}
    </div>
  )
}

/**
 * The reasoning controls: effort, thinking mode, and an optional token
 * budget. Edits are staged locally and written on Save, so a half-typed
 * budget never becomes a request parameter.
 */
function ReasoningControls({ initial, onSaved, t }: {
  initial: QoderWebReasoning
  onSaved: () => Promise<void>
  t: QoderPluginCardProps['t']
}): ReactNode {
  const translate = t ?? fallbackT
  const [effort, setEffort] = useState(initial.effort)
  const [thinking, setThinking] = useState(initial.thinking)
  const [budget, setBudget] = useState(initial.budget === 0 ? '' : String(initial.budget))
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string>()
  const [failure, setFailure] = useState<string>()

  // Re-sync when the host reports a different stored value (a reset from
  // elsewhere, or the first status read landing after mount).
  useEffect(() => {
    setEffort(initial.effort)
    setThinking(initial.thinking)
    setBudget(initial.budget === 0 ? '' : String(initial.budget))
  }, [initial.effort, initial.thinking, initial.budget])

  const dirty = effort !== initial.effort
    || thinking !== initial.thinking
    || budget !== (initial.budget === 0 ? '' : String(initial.budget))

  const save = useCallback(async (next: { effort: string; thinking: string; budget: string }): Promise<void> => {
    setBusy(true)
    setNote(undefined)
    setFailure(undefined)
    try {
      const parsedBudget = next.budget.trim() === '' ? 0 : Number(next.budget)
      if (!Number.isInteger(parsedBudget) || parsedBudget < 0 || parsedBudget > MAX_THINKING_BUDGET) {
        throw new Error(`${translate('thinkingBudget')}: 0–${MAX_THINKING_BUDGET}`)
      }
      const response = await fetch(QODER_CONFIG_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          reasoningEffort: next.effort,
          thinking: next.thinking,
          thinkingBudget: parsedBudget,
        }),
      })
      const payload: unknown = await response.json().catch(() => undefined)
      if (!response.ok) {
        const message = (payload as { error?: unknown } | undefined)?.error
        throw new Error(typeof message === 'string' && message !== '' ? message : `HTTP ${response.status}`)
      }
      setNote(translate('saved'))
      await onSaved()
    } catch (error: unknown) {
      setFailure(error instanceof Error ? error.message : translate('requestFailed'))
    } finally {
      setBusy(false)
    }
  }, [onSaved, translate])

  const controlStyle: CSSProperties = {
    ...buttonStyle,
    minHeight: 30,
    padding: '4px 9px',
    borderRadius: 8,
    fontSize: 13,
    minWidth: 150,
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingTop: 4 }}>
      <span style={{ color: 'var(--dsw-alias-label-tertiary)', fontSize: 13 }}>{translate('reasoning')}</span>
      <div style={rowStyle}>
        <span style={{ color: 'var(--dsw-alias-label-tertiary)', fontSize: 13 }}>{translate('effort')}</span>
        <select
          style={controlStyle}
          value={effort}
          disabled={busy}
          onChange={event => { setEffort(event.target.value) }}
        >
          <option value="">{translate('reasoningDefault')}</option>
          {EFFORT_LEVELS.map(level => <option key={level} value={level}>{level}</option>)}
        </select>
      </div>
      <div style={rowStyle}>
        <span style={{ color: 'var(--dsw-alias-label-tertiary)', fontSize: 13 }}>{translate('thinking')}</span>
        <select
          style={controlStyle}
          value={thinking}
          disabled={busy}
          onChange={event => { setThinking(event.target.value) }}
        >
          <option value="">{translate('reasoningDefault')}</option>
          {THINKING_MODES.map(mode => <option key={mode} value={mode}>{mode}</option>)}
        </select>
      </div>
      <div style={rowStyle}>
        <span style={{ color: 'var(--dsw-alias-label-tertiary)', fontSize: 13 }}>{translate('thinkingBudget')}</span>
        <input
          style={controlStyle}
          inputMode="numeric"
          placeholder={translate('reasoningDefault')}
          value={budget}
          disabled={busy}
          onChange={event => { setBudget(event.target.value.replace(/[^\d]/gu, '')) }}
        />
      </div>
      <div style={rowStyle}>
        <span style={{ color: 'var(--dsw-alias-label-tertiary)', fontSize: 12, maxWidth: 340 }}>{translate('reasoningHint')}</span>
        <span style={{ display: 'inline-flex', gap: 8 }}>
          <button
            type="button"
            style={buttonStyle}
            disabled={busy || !dirty}
            onClick={() => { void save({ effort, thinking, budget }) }}
          >
            {busy ? translate('saving') : translate('save')}
          </button>
        </span>
      </div>
      {note !== undefined ? <p style={{ ...bodyStyle, fontSize: 13 }}>{note}</p> : null}
      {failure !== undefined ? <p style={errorStyle}>{failure}</p> : null}
    </div>
  )
}

/**
 * Render Qoder readiness: the one-liner the card list shows (`summary`) and
 * the full document on the plugin's own page (`page`).
 *
 * The two views mount as separate component instances (the page dispatches
 * each occurrence with `only`), so each keeps its own read state.
 */
export function QoderPluginCard({ view, t }: QoderPluginCardProps): ReactNode {
  // The one-liner reads once; the detail view reads and polls.
  const { status, readFailure, refresh, busy } = useQoderStatus(view === 'page' ? 'poll' : 'once')
  const translate = t ?? fallbackT
  const onRefresh = useCallback((): void => { void refresh() }, [refresh])
  const onSaved = useCallback(async (): Promise<void> => { await refresh() }, [refresh])

  // The roster re-fetch is a separate busy flag from the status read: it
  // spawns the CLI (seconds) where the read is a local file check, and
  // conflating them would gray out unrelated controls.
  const [fetchingModels, setFetchingModels] = useState(false)
  const [modelNote, setModelNote] = useState<string>()
  const onRefetchModels = useCallback((): void => {
    setFetchingModels(true)
    setModelNote(undefined)
    void (async () => {
      try {
        const response = await fetch(QODER_CONFIG_PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ action: 'refreshModels' }),
        })
        const payload: unknown = await response.json().catch(() => undefined)
        if (!response.ok) {
          const message = (payload as { error?: unknown } | undefined)?.error
          throw new Error(typeof message === 'string' && message !== '' ? message : `HTTP ${response.status}`)
        }
        await refresh()
      } catch (error: unknown) {
        setModelNote(error instanceof Error ? error.message : translate('requestFailed'))
      } finally {
        setFetchingModels(false)
      }
    })()
  }, [refresh, translate])

  if (view === 'summary') return <SummaryLine status={status} t={t} />
  return (
    <DetailBody
      status={status}
      readFailure={readFailure}
      busy={busy}
      onRefresh={onRefresh}
      onSaved={onSaved}
      onRefetchModels={onRefetchModels}
      fetchingModels={fetchingModels}
      modelNote={modelNote}
      t={t}
    />
  )
}
