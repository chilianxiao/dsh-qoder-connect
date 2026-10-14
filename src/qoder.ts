/**
 * Qoder reverse-proxy core, ported from proxy-hub's `adapters/qoder.js`
 * (https://github.com/1416277987/proxy-hub).
 *
 * Wraps the user's own local Qoder login as an OpenAI-compatible surface: the
 * `qoderclicn` CLI owns the account (OAuth state on disk after
 * `qoderclicn login`, or a PAT supplied via QODERCN_PERSONAL_ACCESS_TOKEN).
 * This module spawns that CLI as a child process and re-emits its stream-json
 * output as OpenAI chat chunks.
 *
 * There is deliberately no upstream HTTP call anywhere in this module — the
 * CLI is the upstream — so there are no outbound URLs to validate.
 *
 * @module dsh-qoder-connect/qoder
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

/** One model the qoder provider exposes: the DSH-facing id and the CLI spelling. */
export interface QoderModel {
  /** Model id advertised to DSH and sent on the wire as `model`. */
  externalId: string
  /** The `--model` value the `qoderclicn` CLI expects. */
  cliModel: string
}

/**
 * Models offered through the qoder provider, used as the FALLBACK roster.
 *
 * The live roster comes from `qoderclicn --list-models` (see
 * {@link fetchQoderModels}); this constant is what the plugin serves when
 * that call cannot be made — no login yet, a CLI that fails, or a CLI too old
 * to know the flag. Keeping a fallback matters because an empty roster hides
 * the whole Qoder group from the model picker, which is a worse failure than
 * a roster that is merely out of date.
 *
 * Verified against CLI 1.1.59. Deliberately a snapshot of a *stable* roster:
 * the CLI has been observed listing a model briefly and then withdrawing it
 * (`Fast` appeared in `--list-models`, then vanished and started answering
 * "not available right now; using auto instead"), so a short-lived entry must
 * not be frozen in here where it would outlive the CLI's own offer.
 */
export const QODER_MODELS: readonly QoderModel[] = [
  { externalId: 'qoder-auto', cliModel: 'Auto' },
  { externalId: 'qoder-qwen3.8-max', cliModel: 'Qwen3.8-Max' },
  { externalId: 'qoder-qwen3.8-flash', cliModel: 'Qwen3.8-Flash' },
  { externalId: 'qoder-qwen3.7-max', cliModel: 'Qwen3.7-Max' },
  { externalId: 'qoder-qwen3.7-plus', cliModel: 'Qwen3.7-Plus' },
  { externalId: 'qoder-qwen3.7-flash', cliModel: 'Qwen3.7-Flash' },
  { externalId: 'qoder-deepseek-v4-pro', cliModel: 'DeepSeek-V4-Pro' },
  { externalId: 'qoder-deepseek-flash', cliModel: 'DeepSeek-Flash' },
  { externalId: 'qoder-glm-5.3', cliModel: 'GLM-5.3' },
  { externalId: 'qoder-glm-5.3-flash', cliModel: 'GLM-5.3-Flash' },
  { externalId: 'qoder-glm-5.2', cliModel: 'GLM-5.2' },
  { externalId: 'qoder-kimi-k3', cliModel: 'Kimi-K3' },
  { externalId: 'qoder-kimi-k2.8-preview', cliModel: 'Kimi-K2.8-Preview' },
  { externalId: 'qoder-minimax-m2.7', cliModel: 'MiniMax-M2.7' },
]

/**
 * The DSH-facing model id for one CLI spelling.
 *
 * Every id in {@link QODER_MODELS} is `qoder-` plus the lowercased CLI name,
 * so a model the CLI adds later gets a stable, predictable id without a code
 * change — and ids recorded in the usage ledger keep resolving. Names are
 * already unique case-insensitively, which the fetch path relies on.
 */
export function qoderExternalId(cliModel: string): string {
  return `qoder-${cliModel.trim().toLowerCase()}`
}

/** Default model when a request body omits one. */
export const QODER_DEFAULT_MODEL = 'Qwen3.7-Max'

/**
 * Reasoning-effort levels `--reasoning-effort` accepts, in the CLI's own
 * order. Verified against CLI 1.1.59: any other value makes the CLI exit
 * before the request is served ("Invalid reasoning effort: ...").
 */
export const QODER_REASONING_EFFORTS = ['auto', 'none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultracode'] as const

/** Thinking modes `--thinking` accepts; verified against CLI 1.1.59. */
export const QODER_THINKING_MODES = ['auto', 'adaptive', 'enabled', 'disabled'] as const

/** One reasoning-effort level. */
export type QoderReasoningEffort = typeof QODER_REASONING_EFFORTS[number]

/** One thinking mode. */
export type QoderThinkingMode = typeof QODER_THINKING_MODES[number]

/** Ceiling on `--thinking-budget`, matching the CLI's own usable range. */
export const QODER_MAX_THINKING_BUDGET = 1_000_000

/**
 * The levels DSH's picker could ever offer, in pi-ai's order.
 *
 * This is only the *vocabulary* the CLI recognizes, not what any model
 * accepts: the official catalog grants each model its own subset (and some
 * models none at all), and an unsupported value is silently ignored upstream
 * rather than rejected. The adapter therefore declares levels per model from
 * the catalog (see `thinkingLevelMapFor`) instead of offering this list to
 * everyone, which is what left previously-offered levels doing nothing.
 */
export const QODER_PICKER_THINKING_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

/** Overall ceiling for one CLI run, in milliseconds. */
export const QODER_TIMEOUT_MS = 600_000

/** How long a resolved CLI path is reused before it is probed again. */
const CLI_RESOLVE_TTL_MS = 60_000

/** Readiness facts for the qoder path. Never throws — callers surface `reason`. */
export interface QoderStatus {
  id: 'qoder'
  /** Whether a chat request can be served right now. */
  ready: boolean
  /** The resolved CLI command, or null when none was found. */
  cli: string | null
  /** Whether an OAuth login state file exists on disk. */
  oauth: boolean
  /** Whether a PAT is available (option or environment). */
  pat: boolean
  /** The OAuth state file that exists, or the documented default. */
  oauthFile: string
  /** Human-readable explanation; present in both ready and not-ready answers. */
  reason: string
}

/** Options shared by every qoder entry point. */
export interface QoderOptions {
  /** CLI command name or absolute path; defaults to `qoderclicn`. */
  command?: string
  /** Extra argv inserted before the subcommand arguments. */
  prefixArgs?: readonly string[]
  /** PAT used when no OAuth login state exists. */
  pat?: string
  /**
   * Reasoning effort for every run (`--reasoning-effort`). Absent leaves the
   * CLI's own default in place — the flag is only ever added when set, so an
   * unknown spelling can never be sent by accident.
   */
  reasoningEffort?: QoderReasoningEffort
  /** Thinking mode for every run (`--thinking`). Absent uses the CLI default. */
  thinking?: QoderThinkingMode
  /**
   * Fixed thinking-token budget (`--thinking-budget`). Implies thinking
   * enabled, so it is only sent when explicitly configured.
   */
  thinkingBudget?: number
  /** Home directory to probe; defaults to `os.homedir()`. */
  homeDir?: string
  /** Abort signal for one chat run. */
  signal?: AbortSignal
  /**
   * Called exactly once when one run finishes — success, error, abort, or
   * timeout — with whatever the CLI reported. Used to persist the usage
   * ledger; must never throw (its failures are the caller's problem).
   */
  onRunComplete?: (result: QoderRunResult, model: string) => void
  /** Overall ceiling for one chat run, in milliseconds. */
  timeoutMs?: number
}

/** One resolved CLI invocation target. */
interface ResolvedCli {
  command: string
  /** True for .cmd/.bat shims, which must be started through the shell. */
  viaCmd: boolean
}

/**
 * Candidate OAuth-state files left by `qoderclicn login`, in probe order.
 * The contents are an encrypted blob — only existence is checked here; the
 * CLI itself reads and decrypts it.
 */
export function qoderOauthUserCandidates(homeDir: string = homedir()): string[] {
  return [
    path.join(homeDir, '.qoderworkcn', '.auth-cn', 'user'), // layout documented by proxy-hub
    path.join(homeDir, '.qoder-cn', '.auth', 'user'),       // Qoder CN CLI layout (verified)
    path.join(homeDir, '.qoder', '.auth', 'user'),          // international qodercli layout
  ]
}

/** First existing candidate, or the documented default when none exists. */
export function qoderOauthUserPath(options: QoderOptions = {}): string {
  const candidates = qoderOauthUserCandidates(options.homeDir ?? homedir())
  return candidates.find(candidate => existsSync(candidate)) ?? candidates[0]!
}

function hasOauthLogin(options: QoderOptions): boolean {
  return qoderOauthUserCandidates(options.homeDir ?? homedir()).some(candidate => existsSync(candidate))
}

function commandOf(options: QoderOptions): string {
  return options.command ?? process.env.QODERCN_CLI ?? 'qoderclicn'
}

function prefixArgsOf(options: QoderOptions): readonly string[] {
  return options.prefixArgs ?? []
}

function homeDirOf(options: QoderOptions): string {
  return options.homeDir ?? homedir()
}

function patOf(options: QoderOptions): string | undefined {
  if (typeof options.pat === 'string' && options.pat !== '') return options.pat
  const fromEnv = process.env.QODERCN_PERSONAL_ACCESS_TOKEN
  return fromEnv === undefined || fromEnv === '' ? undefined : fromEnv
}

/**
 * On Windows a global npm CLI is usually a .cmd shim, and Node refuses to
 * spawn .cmd/.bat directly (EINVAL since the CVE-2024-27980 fix). Passing
 * argv to cmd.exe does not work either: Node escapes inner quotes as \",
 * which cmd.exe does not understand. The form that does work is a single
 * fully-quoted command line run through shell:true — every token quoted, so
 * prompt text containing & | > < stays literal inside the quotes.
 */
function cliSuffixes(): string[] {
  return process.platform === 'win32' ? ['', '.cmd', '.exe', '.bat'] : ['']
}

function isCmdShim(candidate: string): boolean {
  return process.platform === 'win32' && /\.(cmd|bat)$/i.test(candidate)
}

/**
 * Well-known install locations for the default command names, used when the
 * CLI is not on PATH (the Qoder installer puts it under ~/.qoder-cn/bin/...).
 * An explicit QODERCN_CLI path is never second-guessed.
 */
function defaultInstallCandidates(command: string, homeDir: string): string[] {
  if (command.includes('/') || command.includes('\\')) return []
  const known: Record<string, string[]> = {
    qoderclicn: [path.join(homeDir, '.qoder-cn', 'bin', 'qoderclicn')],
    qodercli: [path.join(homeDir, '.qoder', 'bin', 'qodercli')],
  }
  const dirs = known[command.toLowerCase()] ?? []
  return dirs.flatMap(dir => cliSuffixes().map(suffix => path.join(dir, `${command}${suffix}`)))
}

/** Quote one command line for cmd.exe: every token in double quotes, inner quotes doubled. */
function quoteCmdLine(command: string, args: readonly string[]): string {
  return [command, ...args].map(token => `"${String(token).replace(/"/g, '""')}"`).join(' ')
}

/**
 * Resolve which candidate actually executes: null when none is installed.
 * Returns { command, viaCmd } — viaCmd marks .cmd/.bat shims, which must be
 * started as a quoted command line through shell:true.
 *
 * PATH is probed before the well-known install dirs (an explicit user setup
 * wins), and within each location a directly-spawnable binary is preferred
 * over a .cmd shim. Note: cmd.exe expands %VAR% in arguments, so a prompt
 * containing percent-signs may be altered on the shim path; plain
 * executables (the common case) are unaffected.
 */
function resolveCli(command: string, prefixArgs: readonly string[], homeDir: string): ResolvedCli | null {
  const groups = [
    cliSuffixes().map(suffix => `${command}${suffix}`), // PATH, by name
    defaultInstallCandidates(command, homeDir),        // well-known install dirs
  ]
  for (const candidates of groups) {
    for (const candidate of candidates) {
      if (isCmdShim(candidate)) continue // cannot be spawned directly; probed below
      const probe = spawnSync(candidate, [...prefixArgs, '--version'], { windowsHide: true, timeout: 15_000 })
      if (probe.error === undefined) return { command: candidate, viaCmd: false }
    }
    for (const candidate of candidates) {
      if (!isCmdShim(candidate)) continue
      // A zero status proves the shim ran; cmd.exe itself exits 9009 for a
      // missing command, which must not count as "installed".
      const probe = spawnSync(quoteCmdLine(candidate, [...prefixArgs, '--version']), { shell: true, windowsHide: true, timeout: 15_000 })
      if (probe.error === undefined && probe.status === 0) return { command: candidate, viaCmd: true }
    }
  }
  return null
}

/**
 * Kill the CLI child. Through a cmd.exe shim the real CLI is a grandchild
 * that inherited the stdout pipe: killing only cmd.exe leaves the pipe open
 * and readers hang, so the whole tree is taken down with taskkill.
 */
function killCli(child: ReturnType<typeof spawn>, viaCmd: boolean): void {
  if (child.exitCode !== null || child.signalCode !== null) return
  if (viaCmd && process.platform === 'win32' && child.pid !== undefined) {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).unref()
      return
    } catch {
      // fall through to the plain kill
    }
  }
  child.kill()
}

/** Start the CLI child process, routing .cmd/.bat shims through the shell. */
function startCli(resolved: ResolvedCli, prefixArgs: readonly string[], args: readonly string[], env: NodeJS.ProcessEnv): ReturnType<typeof spawn> {
  try {
    if (resolved.viaCmd) {
      return spawn(quoteCmdLine(resolved.command, [...prefixArgs, ...args]), { shell: true, env, windowsHide: true })
    }
    return spawn(resolved.command, [...prefixArgs, ...args], { env, windowsHide: true })
  } catch (error: unknown) {
    // A too-long command line throws synchronously here (Windows caps argv
    // at 32,767 chars) rather than surfacing as an 'error' event, so the
    // caps in buildCliPrompt are the real defense and this is the readable
    // backstop for whatever still slips through.
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(
      `无法启动 Qoder CLI（${detail}）。对话历史可能过长：请新开一个会话，或在设置里调低 QODER_MAX_PROMPT_CHARS。`,
    )
  }
}

/**
 * Cache of resolved CLI paths, keyed by command+homeDir.
 *
 * Probing spawns the CLI once per candidate (`--version`), which is far too
 * heavy to repeat on every readiness sweep. Entries expire after
 * {@link CLI_RESOLVE_TTL_MS} so a CLI installed or upgraded while DSH runs is
 * picked up on the next sweep.
 */
const resolveCache = new Map<string, { resolved: ResolvedCli | null; at: number }>()

/** Drop every cached resolution (tests, and a config change repointing the CLI). */
export function clearQoderCliCache(): void {
  resolveCache.clear()
}

/** Ceiling on one `--list-models` run; it never talks to the network. */
const LIST_MODELS_TIMEOUT_MS = 20_000

/**
 * Parse `qoderclicn --list-models` output into the served roster.
 *
 * The format (CLI 1.1.59) is a `MODEL` header followed by one model name per
 * line; there is no `--json`. Parsing is deliberately conservative — the
 * header, blank lines and anything that cannot be a model name are dropped,
 * and duplicates (case-insensitively, since the id lowercases) are collapsed
 * so one model can never appear twice in the picker.
 *
 * `Auto` is kept wherever the CLI lists it: the CLI's own default belongs in
 * the picker even though it names no specific model.
 *
 * @returns the parsed roster, or `null` when nothing usable was found — the
 *   caller then keeps the previous/fallback list rather than emptying the
 *   group, because an empty roster hides Qoder from the picker entirely.
 */
export function parseListModelsOutput(stdout: string): QoderModel[] | null {
  const models: QoderModel[] = []
  const seen = new Set<string>()
  for (const rawLine of stdout.split(/\r?\n/u)) {
    // Strip a Table/box-drawing border or bullet a future CLI might add,
    // plus surrounding whitespace, before judging the token.
    const name = rawLine.replace(/^[\s|│┃*•\-]+/u, '').replace(/[\s|│┃]+$/u, '').trim()
    if (name === '') continue
    if (/^models?$/iu.test(name)) continue          // the `MODEL` header
    if (/^name$/iu.test(name)) continue             // a hypothetical column header
    // Reject lines that carry no model name: error text, a usage banner, or
    // a stray separator. Model names are short single tokens.
    if (name.length > 60 || name.includes('  ')) continue
    if (/^(error|usage|unknown|invalid|warning)[:\s]/iu.test(name)) continue
    const id = qoderExternalId(name)
    if (seen.has(id)) continue
    seen.add(id)
    models.push({ externalId: id, cliModel: name })
  }
  return models.length > 0 ? models : null
}

/**
 * Ask the CLI for its current model roster.
 *
 * Runs `--list-models` once. This is deliberately NOT part of the readiness
 * sweep: the sweep is a cheap file/probe check on a 30s timer, whereas this
 * spawns a process (seconds). The caller decides when it is worth paying for.
 *
 * Never throws — an unreachable CLI, a non-zero exit, an unparseable roster
 * and a timeout all answer `null`, which the caller reads as "keep what you
 * have".
 */
export async function fetchQoderModels(options: QoderOptions = {}): Promise<QoderModel[] | null> {
  const command = commandOf(options)
  const prefixArgs = prefixArgsOf(options)
  const homeDir = homeDirOf(options)
  const resolved = resolveCliCached(command, prefixArgs, homeDir)
  if (resolved === null) return null
  // A login is not required to list models, but the CLI needs something in
  // the environment it can work with; mirror the chat path's PAT handling so
  // a PAT-only setup lists the same roster it can actually call.
  const env: NodeJS.ProcessEnv = { ...process.env }
  if (hasOauthLogin(options)) delete env.QODERCN_PERSONAL_ACCESS_TOKEN
  else {
    const pat = patOf(options)
    if (pat !== undefined) env.QODERCN_PERSONAL_ACCESS_TOKEN = pat
  }

  return new Promise<QoderModel[] | null>(resolve => {
    let stdout = ''
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (value: QoderModel[] | null): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      resolve(value)
    }
    let child: ReturnType<typeof spawn>
    try {
      child = startCli(resolved, prefixArgs, ['--list-models'], env)
    } catch {
      resolve(null)
      return
    }
    timer = setTimeout(() => {
      killCli(child, resolved.viaCmd)
      finish(null)
    }, LIST_MODELS_TIMEOUT_MS)
    if (typeof timer.unref === 'function') timer.unref()

    child.stdout?.on('data', (chunk: Buffer | string) => { stdout += chunk })
    child.on('error', () => { finish(null) })
    child.on('close', (code: number | null) => {
      if (code !== 0) {
        finish(null)
        return
      }
      finish(parseListModelsOutput(stdout))
    })
  })
}

function resolveCliCached(command: string, prefixArgs: readonly string[], homeDir: string): ResolvedCli | null {
  const key = `${command}\u0000${homeDir}\u0000${prefixArgs.join('\u0000')}`
  const now = Date.now()
  const hit = resolveCache.get(key)
  if (hit !== undefined && now - hit.at < CLI_RESOLVE_TTL_MS) return hit.resolved
  const resolved = resolveCli(command, prefixArgs, homeDir)
  resolveCache.set(key, { resolved, at: now })
  return resolved
}

/**
 * Readiness of the qoder path: CLI installed AND (OAuth login OR PAT).
 * Never throws — callers surface `reason` to the user.
 */
export function qoderStatus(options: QoderOptions = {}): QoderStatus {
  const command = commandOf(options)
  const prefixArgs = prefixArgsOf(options)
  const homeDir = homeDirOf(options)
  const resolved = resolveCliCached(command, prefixArgs, homeDir)
  const oauth = hasOauthLogin(options)
  const pat = patOf(options) !== undefined
  if (resolved === null) {
    return {
      id: 'qoder',
      ready: false,
      cli: null,
      oauth,
      pat,
      oauthFile: qoderOauthUserPath(options),
      reason: `未找到 Qoder CLI（${command}）：请先安装 Qoder 并执行 qoderclicn login`,
    }
  }
  if (!oauth && !pat) {
    return {
      id: 'qoder',
      ready: false,
      cli: resolved.command,
      oauth,
      pat,
      oauthFile: qoderOauthUserPath(options),
      reason: '未登录：请执行 qoderclicn login，或设置环境变量 QODERCN_PERSONAL_ACCESS_TOKEN',
    }
  }
  return {
    id: 'qoder',
    ready: true,
    cli: resolved.command,
    oauth,
    pat,
    oauthFile: qoderOauthUserPath(options),
    reason: oauth ? `ok（登录态落盘于 ${qoderOauthUserPath(options)}）` : 'ok（QODERCN_PERSONAL_ACCESS_TOKEN）',
  }
}

/** Extract the text delta from one stream-json line; null for non-text records. */
export function parseCliDelta(line: string): string | null {
  let record: unknown
  try {
    record = JSON.parse(line)
  } catch {
    return null
  }
  if (typeof record !== 'object' || record === null) return null
  if ((record as { type?: unknown }).type !== 'assistant') return null
  const message = (record as { message?: { content?: unknown } }).message
  const content = message?.content
  if (!Array.isArray(content)) return null
  const text = content
    .filter((part): part is { type: string; text?: unknown } =>
      typeof part === 'object' && part !== null && (part as { type?: unknown }).type === 'text')
    .map(part => (typeof part.text === 'string' ? part.text : ''))
    .join('')
  return text === '' ? null : text
}

/** What the CLI's final `result` record says about one run. */
export interface QoderRunResult {
  /** Credits the CLI charged (`total_credits`); 0 when absent. */
  credits: number
  /** Wall-clock duration of the run (`duration_ms`); 0 when absent. */
  ms: number
  /** CLI turns the run took (`num_turns`); 0 when absent. */
  turns: number
  /** Whether the CLI flagged the run as an error (`is_error`). */
  isError: boolean
}

/**
 * Extract the run summary from one stream-json line; null for every other
 * record. The `result` record is the CLI's last line and the only place it
 * reports credit cost — the session event logs carry no credits at all.
 */
export function parseCliResult(line: string): QoderRunResult | null {
  let record: unknown
  try {
    record = JSON.parse(line)
  } catch {
    return null
  }
  if (typeof record !== 'object' || record === null) return null
  if ((record as { type?: unknown }).type !== 'result') return null
  const typed = record as {
    total_credits?: unknown
    duration_ms?: unknown
    num_turns?: unknown
    is_error?: unknown
  }
  return {
    credits: typeof typed.total_credits === 'number' && Number.isFinite(typed.total_credits) ? typed.total_credits : 0,
    ms: typeof typed.duration_ms === 'number' && Number.isFinite(typed.duration_ms) ? typed.duration_ms : 0,
    turns: typeof typed.num_turns === 'number' && Number.isFinite(typed.num_turns) ? typed.num_turns : 0,
    isError: typed.is_error === true,
  }
}

/** Flatten an OpenAI message content (string or parts array) to plain text. */
export function flattenContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map(part => (typeof part?.text === 'string' ? part.text : '')).join('')
  }
  return ''
}

/**
 * Ceiling on the flattened one-shot prompt, in characters.
 *
 * The CLI takes the whole conversation as ONE argv string, and Windows
 * `CreateProcess` caps a command line at 32,767 characters — past that the
 * spawn itself fails with ENAMETOOLONG and the request never reaches the
 * CLI. A long DSH session easily exceeds that (a real session with 330
 * assistant messages measured 360K characters), so the prompt is capped by
 * keeping the most recent messages and dropping older ones.
 *
 * 24,000 leaves headroom for the flags and the system prompt inside the
 * 32,767 argv budget; it is also well inside any served model's context
 * window (~6-8K tokens).
 */
export const QODER_MAX_PROMPT_CHARS = 24_000

/** Ceiling on the `--append-system-prompt` value, in characters. */
export const QODER_MAX_SYSTEM_CHARS = 4_000

/** Marker prepended when earlier messages were dropped to fit the cap. */
const DROPPED_MARKER = (count: number): string =>
  `[系统提示：受单次 prompt 长度限制，较早的 ${count} 条消息已省略，请基于下方现有内容继续回答]`

/** Marker appended when one message's own text was cut to fit the cap. */
const TRUNCATED_MARKER = '[……本条消息因长度限制被截断]'

/** Marker appended when the system prompt itself was cut to fit its cap. */
const TRUNCATED_SYSTEM_MARKER = '[……系统提示因长度限制被截断]'

/** Read a positive integer from the environment, clamped to a safe range. */
function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = Number(process.env[name])
  if (!Number.isFinite(raw) || raw <= 0) return fallback
  return Math.min(max, Math.max(min, Math.floor(raw)))
}

/** Options for {@link buildCliPrompt}. */
export interface BuildCliPromptOptions {
  /** Ceiling on the flattened history; defaults to {@link QODER_MAX_PROMPT_CHARS}. */
  maxPromptChars?: number
  /** Ceiling on the system prompt; defaults to {@link QODER_MAX_SYSTEM_CHARS}. */
  maxSystemChars?: number
}

/** Keep the head of `text` within `limit`, marking the cut. */
function truncateHead(text: string, limit: number, marker: string): string {
  if (text.length <= limit) return text
  const keep = Math.max(0, limit - marker.length - 1)
  return `${text.slice(0, keep)}\n${marker}`
}

/** What {@link buildCliPrompt} built, including what it had to drop. */
export interface CliPrompt {
  /** The `--append-system-prompt` value (possibly truncated). */
  system: string
  /** The one-shot prompt (recent messages kept, older ones dropped). */
  prompt: string
  /** How many earlier messages were dropped to fit the cap. */
  dropped: number
  /** Whether any text was cut to fit the caps. */
  truncated: boolean
}

/**
 * The CLI takes a single one-shot prompt: the system message becomes
 * --append-system-prompt and the remaining messages are concatenated into
 * the prompt (the CLI has no multi-turn stdin protocol).
 *
 * Because the whole history rides in argv, both parts are capped: the
 * system prompt by {@link QODER_MAX_SYSTEM_CHARS} and the flattened
 * history by {@link QODER_MAX_PROMPT_CHARS}, keeping the NEWEST messages
 * (the live exchange) and dropping the oldest with a marker so the model
 * knows context is missing rather than hallucinating it. The returned
 * prompt never exceeds `maxPromptChars`, separators and marker included.
 */
export function buildCliPrompt(messages: unknown, options: BuildCliPromptOptions = {}): CliPrompt {
  const maxPromptChars = options.maxPromptChars
    ?? envInt('QODER_MAX_PROMPT_CHARS', QODER_MAX_PROMPT_CHARS, 1_000, 28_000)
  const maxSystemChars = options.maxSystemChars
    ?? envInt('QODER_MAX_SYSTEM_CHARS', QODER_MAX_SYSTEM_CHARS, 200, 3_000)

  const list = Array.isArray(messages) ? messages as Array<{ role?: unknown; content?: unknown }> : []
  const systemRaw = flattenContent(list.find(m => m?.role === 'system')?.content)
  const system = truncateHead(systemRaw, maxSystemChars, TRUNCATED_SYSTEM_MARKER)

  // Room reserved up front for the dropped-history marker plus its
  // separator, so the joined prompt stays inside the cap exactly.
  const MARKER_RESERVE = 64
  const budget = Math.max(200, maxPromptChars - MARKER_RESERVE - 1)

  // Newest first, so the live exchange survives the cap. `used` counts the
  // joined length of the kept parts, separators included.
  const rest = list.filter(m => m?.role !== 'system')
  const kept: string[] = []
  let used = 0
  let index = rest.length - 1
  let truncated = systemRaw.length > maxSystemChars
  while (index >= 0) {
    const text = flattenContent(rest[index]?.content)
    index -= 1
    if (text === '') continue
    const separator = kept.length > 0 ? 1 : 0
    if (used + separator + text.length <= budget) {
      kept.unshift(text)
      used += separator + text.length
      continue
    }
    // This message does not fit whole: keep its head in the room left
    // (when there is any worth keeping) and stop.
    const room = budget - used - separator
    if (room > 40) {
      kept.unshift(truncateHead(text, room, TRUNCATED_MARKER))
      truncated = true
    }
    break
  }
  const dropped = index + 1
  const parts = dropped > 0 ? [DROPPED_MARKER(dropped), ...kept] : kept
  return { system, prompt: parts.join('\n'), dropped, truncated }
}

/** Map a wire model id (externalId or CLI spelling) to the CLI's `--model` value. */
export function cliModelFor(model: string): string {
  const entry = QODER_MODELS.find(candidate => candidate.externalId === model || candidate.cliModel === model)
  return entry?.cliModel ?? model
}

/**
 * The reasoning-control flags for one run, in the order the CLI documents
 * them. Every value is checked against the CLI's accepted list before it
 * reaches argv: the CLI exits with a fatal error on an unknown spelling
 * (rather than ignoring it), so a bad value must be dropped here instead of
 * failing the whole request downstream.
 *
 * `--thinking-budget` implies `--thinking enabled` upstream, so passing both
 * is harmless and the explicit mode wins only when it is sent after; the
 * budget is emitted last to keep that precedence predictable.
 */
export function buildReasoningArgs(options: QoderOptions = {}): string[] {
  const args: string[] = []
  const effort = options.reasoningEffort
  if (effort !== undefined && (QODER_REASONING_EFFORTS as readonly string[]).includes(effort)) {
    args.push('--reasoning-effort', effort)
  }
  const thinking = options.thinking
  if (thinking !== undefined && (QODER_THINKING_MODES as readonly string[]).includes(thinking)) {
    args.push('--thinking', thinking)
  }
  const budget = options.thinkingBudget
  if (typeof budget === 'number' && Number.isFinite(budget) && budget > 0) {
    args.push('--thinking-budget', String(Math.min(Math.floor(budget), QODER_MAX_THINKING_BUDGET)))
  }
  return args
}

/** The OpenAI `model` list entry for one qoder model. */
export function qoderModelListEntry(model: QoderModel): { id: string; object: 'model'; created: number; owned_by: string } {
  return { id: model.externalId, object: 'model', created: 0, owned_by: 'qoder' }
}

function chunkId(): string {
  return `chatcmpl-qoder-${Math.random().toString(36).slice(2, 10)}`
}

/** One OpenAI chat.completion.chunk object. */
export interface ChatChunk {
  id: string
  object: 'chat.completion.chunk'
  created: number
  model: string
  choices: Array<{ index: 0; delta: { content?: string }; finish_reason: string | null }>
}

/**
 * Run one chat completion through the CLI, yielding OpenAI chunk objects as
 * the stream-json lines arrive. Honors `signal` (client gone) and `timeoutMs`
 * (overall ceiling) by killing the child. The final chunk always carries
 * finish_reason 'stop'.
 */
export async function* qoderChatStream(body: unknown, options: QoderOptions = {}): AsyncGenerator<ChatChunk> {
  const command = commandOf(options)
  const prefixArgs = prefixArgsOf(options)
  const homeDir = homeDirOf(options)
  const requestBody = (typeof body === 'object' && body !== null ? body : {}) as {
    model?: unknown
    messages?: unknown
    reasoning_effort?: unknown
  }
  const requested = typeof requestBody.model === 'string' && requestBody.model !== '' ? requestBody.model : QODER_DEFAULT_MODEL
  const model = cliModelFor(requested)
  // Per-request level from the model picker (pi-ai sends the picked
  // `thinkingLevelMap` spelling as `reasoning_effort`) wins over the global
  // plugin setting; a spelling outside the CLI's vocabulary falls back to the
  // configured value rather than being dropped, so the global default still
  // applies.
  const wireEffort = requestBody.reasoning_effort
  const reasoningEffort = typeof wireEffort === 'string' && (QODER_REASONING_EFFORTS as readonly string[]).includes(wireEffort)
    ? wireEffort as QoderReasoningEffort
    : options.reasoningEffort
  const { system, prompt } = buildCliPrompt(requestBody.messages)
  const args = [
    '--print',
    '--output-format', 'stream-json',
    '--model', model,
    ...buildReasoningArgs({ ...options, reasoningEffort }),
    '--dangerously-skip-permissions',
    ...(system !== '' ? ['--append-system-prompt', system] : []),
    '--',
    prompt,
  ]

  const env: NodeJS.ProcessEnv = { ...process.env }
  if (hasOauthLogin(options)) {
    // The CLI treats this variable as an override of the saved login and
    // rejects every request while it holds an invalid token — drop it so the
    // `qoderclicn login` state is used, even if the variable is set in the
    // ambient environment for unrelated reasons.
    delete env.QODERCN_PERSONAL_ACCESS_TOKEN
  } else {
    const pat = patOf(options)
    if (pat !== undefined) env.QODERCN_PERSONAL_ACCESS_TOKEN = pat
  }

  const resolved = resolveCliCached(command, prefixArgs, homeDir)
  if (resolved === null) {
    throw new Error(`未找到 Qoder CLI（${command}）：请先安装 Qoder 并执行 qoderclicn login`)
  }

  const created = Math.floor(Date.now() / 1000)
  const id = chunkId()
  const emit = (text: string): ChatChunk => ({
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
  })

  const child = startCli(resolved, prefixArgs, args, env)
  const signal = options.signal
  const onAbort = (): void => { killCli(child, resolved.viaCmd) }
  if (signal !== undefined) {
    if (signal.aborted) killCli(child, resolved.viaCmd)
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  let timedOut = false
  const timer = typeof options.timeoutMs === 'number' && options.timeoutMs > 0
    ? setTimeout(() => {
      timedOut = true
      killCli(child, resolved.viaCmd)
    }, options.timeoutMs)
    : null
  if (timer !== null && typeof timer.unref === 'function') timer.unref()

  let buffer = ''
  let stderr = ''
  let exitCode: number | null = null
  let spawnError: Error | null = null
  /** The CLI's own run summary, captured from the final `result` record. */
  let runResult: QoderRunResult | null = null
  const closed = new Promise<void>(resolve => {
    child.on('error', (error: Error) => {
      spawnError = error
      // A failed spawn can leave stdout open forever; destroy it so the
      // read loop below unblocks and the real error is thrown.
      child.stdout?.destroy()
      resolve()
    })
    child.on('close', code => {
      exitCode = code
      resolve()
    })
  })
  child.stderr?.on('data', (chunk: Buffer | string) => {
    stderr += chunk
  })

  try {
    try {
      // A failed spawn can leave stdout null; the loop is skipped and the
      // spawn error below is thrown instead.
      for await (const piece of child.stdout ?? []) {
        buffer += piece
        for (;;) {
          const newline = buffer.indexOf('\n')
          if (newline < 0) break
          const line = buffer.slice(0, newline).replace(/\r$/, '')
          buffer = buffer.slice(newline + 1)
          const result = parseCliResult(line)
          if (result !== null) {
            runResult = result
            continue
          }
          const text = parseCliDelta(line)
          if (text !== null) yield emit(text)
        }
      }
    } catch (streamError: unknown) {
      // A destroyed stdout (spawn failure) surfaces here; the spawn error
      // below is the accurate one when there is one.
      if (spawnError === null) throw streamError
    }
    if (buffer.trim() !== '') {
      const result = parseCliResult(buffer)
      if (result !== null) runResult = result
      else {
        const text = parseCliDelta(buffer)
        if (text !== null) yield emit(text)
      }
    }
    await closed
    if (spawnError !== null) throw spawnError
    if (timedOut) throw new Error(`qoderclicn 超过 ${Math.round((options.timeoutMs ?? 0) / 1000)}s 未结束，已终止`)
    if (signal?.aborted) {
      // The proxy aborts with a reason ('client disconnected' / timeout text).
      const reason = (signal as AbortSignal & { reason?: { message?: unknown } }).reason
      throw new Error(typeof reason?.message === 'string' && reason.message !== '' ? reason.message : 'aborted')
    }
    if (exitCode !== 0) {
      throw new Error(`qoderclicn exited ${exitCode}: ${stderr.slice(0, 300)}`)
    }
  } finally {
    if (signal !== undefined) signal.removeEventListener('abort', onAbort)
    if (timer !== null) clearTimeout(timer)
    killCli(child, resolved.viaCmd)
    // Exactly one completion report per run: the CLI's own summary when it
    // produced one, otherwise a zero-credit error marker. Aborts, timeouts
    // and non-zero exits all land here with `isError` set, so the ledger
    // can distinguish a charged run from a failed one.
    try {
      options.onRunComplete?.(runResult ?? { credits: 0, ms: 0, turns: 0, isError: true }, model)
    } catch {
      // The callback's failures must never surface into the chat stream.
    }
  }

  yield {
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
  }
}

/** Aggregate streamed chunks into one chat.completion (usage estimated: chars/4). */
export function aggregateQoderChunks(chunks: readonly ChatChunk[], requestBody: unknown): {
  id: string
  object: 'chat.completion'
  created: number
  model: string
  choices: Array<{ index: 0; message: { role: 'assistant'; content: string }; finish_reason: 'stop' }>
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
} {
  let content = ''
  let id = `chatcmpl-qoder-${Date.now()}`
  let created = Math.floor(Date.now() / 1000)
  let model = QODER_DEFAULT_MODEL
  for (const chunk of chunks) {
    if (typeof chunk?.id === 'string') id = chunk.id
    if (typeof chunk?.created === 'number') created = chunk.created
    if (typeof chunk?.model === 'string' && chunk.model !== '') model = chunk.model
    const delta = chunk?.choices?.[0]?.delta
    if (typeof delta?.content === 'string') content += delta.content
  }
  // Estimate against the prompt that was actually sent (the capped one),
  // not the raw history — a long session's full text never reaches the CLI.
  const { prompt } = buildCliPrompt((requestBody as { messages?: unknown } | undefined)?.messages)
  const promptTokens = Math.ceil(prompt.length / 4)
  const completionTokens = Math.ceil(content.length / 4)
  return {
    id,
    object: 'chat.completion',
    created,
    model,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    // The CLI does not report usage; chars/4 mirrors the proxy-hub estimate.
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  }
}
