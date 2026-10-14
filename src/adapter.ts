/**
 * The `qoder` pi-ai provider: one loopback-backed adapter registered into
 * the Harness LLM seam, assembled from public `dsh-llm-pi-ai` extension
 * points the way `dsh-workbuddy-connect` assembles its WorkBuddy route.
 *
 * @module dsh-qoder-connect/adapter
 */

import { createProvider } from '@earendil-works/pi-ai'
import type { Api, AuthContext, CredentialStore, Model, Provider } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import type { ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { QoderCatalog } from './catalog.ts'
import {
  formatQoderPrice,
  thinkingLevelMapFor,
  type QoderModelFacts,
} from './model-catalog.ts'
import type { QoderShim } from './shim.ts'

/** Provider route this bundle owns. */
export const QODER_PROVIDER = 'qoder'

/** Provider idle ceiling while one stream read is outstanding. */
export const QODER_STREAM_IDLE_TIMEOUT_MS = 300_000

/**
 * Conservative capacity defaults for the qoder catalog.
 *
 * The CLI publishes no context-window or output-capability facts through
 * `--list-models` (it prints names only), so these are stated assumptions
 * rather than upstream declarations: they size the model for the Harness
 * without ever becoming per-request caps on their own. The official catalog
 * replaces the window whenever it can be read.
 */
const QODER_CONTEXT_WINDOW = 262_144
const QODER_MAX_TOKENS = 32_768

/**
 * Which context window a model is served at.
 *
 * `default` is the window the official client itself uses (the catalog's
 * `is_default` entry); `max` is the largest window the catalog declares for
 * that model, which the upstream serves but the client does not select by
 * default. The choice rides on `--context-window` per request and is reported
 * to the picker, so the two never disagree about what is in effect.
 */
export type QoderContextWindowMode = 'default' | 'max'

/**
 * Image-request budgets at the dsh-llm-pi-ai defaults; the profile type made
 * them required in 0.1.1-rc.2. These bound what the host may hand a request:
 * images the CLI cannot serve are refused before they reach the shim, and the
 * shim re-checks the size itself before writing a temp file.
 */
const REQUEST_IMAGE_BUDGETS = {
  maxRequestImageBytes: 20_971_520,
  requestImagePixelBudget: 4_194_304,
  requestImageMaxBytes: 1_048_576,
} as const

/**
 * Inert pi-ai auth plane. The qoder route authenticates only through the
 * shim shared secret resolved per request by `resolveApiKey`, so pi-ai's own
 * credential lifecycle and ambient discovery must never manufacture a
 * credential for it. `PiAiAdapterOptions.auth` is required since 0.1.1-rc.2;
 * every ambient question here answers "nothing stored, nothing set".
 */
const INERT_AUTH: { credentials: CredentialStore; authContext: AuthContext } = {
  credentials: {
    async read() { return undefined },
    async list() { return [] },
    async modify() {
      throw new Error('dsh-qoder-connect: the qoder route has no pi-ai credential lifecycle')
    },
    async delete() {},
  },
  authContext: {
    async env() { return undefined },
    async fileExists() { return false },
  },
}

/** No per-token pricing is knowable for a subscription quota; report zero. */
const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const

/**
 * The window one model is served at.
 *
 * `max` takes the largest window the catalog declares — the upstream serves
 * it, the official client just does not pick it by default. It is only ever
 * taken from the catalog's own list, never computed, because the CLI accepts
 * an arbitrary `--context-window` without complaint and would otherwise be
 * handed a number nothing backs.
 */
function contextWindowFor(facts: QoderModelFacts | undefined, mode: QoderContextWindowMode): number {
  if (facts === undefined) return QODER_CONTEXT_WINDOW
  if (mode === 'max' && facts.contextWindows.length > 0) {
    // The list is sorted ascending by the parser, so the last entry is the max.
    return facts.contextWindows[facts.contextWindows.length - 1]!
  }
  return facts.contextWindow ?? QODER_CONTEXT_WINDOW
}

/**
 * Build one pi-ai model descriptor pointing at the loopback shim.
 *
 * `facts` is the official catalog's row for this model, when readable. It is
 * what makes four things accurate that would otherwise be guesses:
 *
 * - **Reasoning levels.** The upstream SILENTLY IGNORES an unsupported
 *   `reasoning_effort` rather than rejecting it, so declaring a level the
 *   model does not serve produces a picker entry that does nothing. Earlier
 *   this plugin declared the same five levels for every model; the official
 *   catalog shows the sets genuinely differ (Qwen3.8-Max serves
 *   low/medium/xhigh, DeepSeek-Flash low/high/max, and Qwen3.7-Max/Plus have
 *   no levels at all — only on/off).
 * - **Context window.** A hardcoded 262144 was used before; the catalog
 *   carries the client's own configured window, and the max switch takes the
 *   largest one it declares.
 * - **Price.** The vendor's published multiplier, shown in the name.
 * - **Image input.** The CLI surface accepts `--attachment`, so a model the
 *   catalog marks `is_vl` is advertised as image-capable instead of being
 *   under-claimed to text-only.
 *
 * Without facts the model still works: it keeps its identity, text input and
 * token caps, and simply declares no reasoning control.
 */
function toPiModel(
  externalId: string,
  cliModel: string,
  baseUrl: string,
  facts: QoderModelFacts | undefined,
  windowMode: QoderContextWindowMode,
): Model<Api> {
  const levelMap = thinkingLevelMapFor(facts)
  // `is_vl` is the *upstream* model accepting images, which the CLI surface
  // can now actually forward through `--attachment` — so the capability is
  // advertised only when the catalog says the model has it, and only then.
  // Under-claiming (text-only) still refuses the image client-side rather
  // than failing mid-turn, which is the safe direction to be wrong in.
  const input = facts?.supportsImages === true ? ['text', 'image'] as const : ['text'] as const
  return {
    id: externalId,
    // The displayed name carries the vendor's own price multiplier. Appending
    // it here (rather than in the catalog) keeps the id — which goes on the
    // wire and keys the usage ledger — untouched.
    name: `${cliModel}${formatQoderPrice(facts)}`,
    api: 'openai-completions',
    provider: QODER_PROVIDER,
    baseUrl,
    input: [...input],
    // A model the catalog shows no discrete levels for declares no reasoning
    // at all: pi-ai would otherwise report the single level `off`, and
    // selecting it is byte-for-byte the same request as naming nothing — a
    // control that cannot do what it says.
    reasoning: levelMap !== null,
    ...levelMap === null ? {} : { thinkingLevelMap: levelMap },
    cost: NO_COST,
    contextWindow: contextWindowFor(facts, windowMode),
    maxTokens: QODER_MAX_TOKENS,
    compat: { maxTokensField: 'max_tokens', supportsReasoningEffort: levelMap !== null },
  } as unknown as Model<Api>
}

/** Constructor dependencies. */
export interface QoderAdapterOptions {
  shim: QoderShim
  /**
   * The live catalog: its *visible* rows are the models this adapter serves.
   * An empty catalog (not ready) is how the Qoder group stays out of the
   * picker, so the host never offers a model that cannot be served.
   */
  catalog: QoderCatalog
  /** Resolve the durable attachment service at request time, when present. */
  resolveAttachments?: () => AttachmentStore | undefined
  /**
   * The official catalog's per-model facts, read synchronously from a
   * snapshot the host refreshes in the background. Absent or empty means the
   * models are served without price, per-model levels or official context
   * windows — a machine that has never run the official client must still
   * get a working picker, so this can never be a required input.
   */
  modelFacts?: () => ReadonlyMap<string, QoderModelFacts>
  /**
   * Which context window the models are served at. A thunk, like
   * {@link QoderAdapterOptions.modelFacts}, so a switch flipped on the card
   * republishes with the next snapshot instead of freezing at startup.
   */
  contextWindowMode?: () => QoderContextWindowMode
}

/** What {@link createQoderAdapter} hands back. */
export interface QoderAdapter {
  adapter: PiAiAdapter
  /** Rebuild the adapter's provider snapshot; call after a readiness change. */
  invalidate: () => void
}

/**
 * Assemble the adapter. The provider's `getModels` reads the live catalog,
 * and every model's `baseUrl` is re-resolved per read so the shim's
 * ephemeral port applies from the first snapshot after startup.
 *
 * The profile is constructed by hand rather than through dsh-llm-pi-ai's
 * internal `resolveProfiles()`: that helper is not part of the package's
 * public export surface, so hand-assembly is the only supported path and
 * every newly required field must be adopted here explicitly.
 */
export function createQoderAdapter(options: QoderAdapterOptions): QoderAdapter {
  const { shim, catalog, resolveAttachments, modelFacts, contextWindowMode } = options

  const buildModels = (): Model<Api>[] => {
    // The OpenAI SDK pi-ai drives appends `/chat/completions` to baseURL,
    // so the shim's routes line up with the `/v1` prefix in place.
    const baseUrl = `${shim.baseUrl()}/v1`
    // Look facts up by the CLI spelling the catalog also uses; a model the
    // catalog does not know keeps its bare name and declares no reasoning.
    const facts = modelFacts?.()
    const windowMode = contextWindowMode?.() ?? 'default'
    return catalog.current().map(entry =>
      toPiModel(entry.id, entry.name, baseUrl, facts?.get(entry.name.toLowerCase()), windowMode))
  }

  const base = createProvider({
    id: QODER_PROVIDER,
    name: 'Qoder',
    auth: {
      apiKey: {
        name: 'Qoder CLI login',
        async resolve({ credential }) {
          const apiKey = credential?.key
          return apiKey === undefined || apiKey.length === 0
            ? undefined
            : { auth: { apiKey }, source: 'Qoder' }
        },
      },
    },
    models: buildModels(),
    api: openAICompletionsApi(),
  })

  // `getModels` is delegated to a live read (the reuse-catalog pattern from
  // dsh-llm-pi-ai): stream dispatch still runs through the constructed
  // provider, while the catalog answer tracks the readiness sweep.
  const provider: Provider = { ...base, getModels: () => buildModels() }

  const profile: ResolvedPiAiProviderProfile = {
    provider: QODER_PROVIDER,
    displayName: 'Qoder',
    streamIdleTimeoutMs: QODER_STREAM_IDLE_TIMEOUT_MS,
    retryPolicy: resolveRetryPolicy(undefined, 'dsh-qoder-connect retryPolicy'),
    configuredMaxTokens: new Map(),
    // Required since 0.1.5-alpha.2; the static catalog only exposes models
    // the CLI itself lists, so there is never a per-model failure to report.
    modelErrors: new Map(),
    ...REQUEST_IMAGE_BUDGETS,
    piProvider: provider,
  }

  let profiles = new Map<string, ResolvedPiAiProviderProfile>([[QODER_PROVIDER, profile]])

  const adapter = new PiAiAdapter({
    profiles: () => profiles,
    auth: INERT_AUTH,
    // Resolve the shim's per-process shared secret as the OpenAI apiKey so
    // pi-ai sends it as `Authorization: Bearer <shared-secret>`. The shim
    // validates this before spawning the CLI, so the secret never reaches
    // the child process.
    resolveApiKey: async () => shim.token(),
    ...resolveAttachments === undefined ? {} : { resolveAttachments },
  })

  return {
    adapter,
    invalidate: () => {
      profiles = new Map<string, ResolvedPiAiProviderProfile>([[QODER_PROVIDER, profile]])
    },
  }
}
