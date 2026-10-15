import z from "@deepseek-ai/schemastery";
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import { IncomingMessage, ServerResponse } from "node:http";
import { Context } from "@deepseek-ai/cordis";
import { SettingsForms, SettingsNamespace } from "@deepseek-ai/dsh-settings";
import { AttachmentStore } from "@deepseek-ai/dsh-attachment";
//#region src/qoder.d.ts
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
/** One model the qoder provider exposes: the DSH-facing id and the CLI spelling. */
interface QoderModel {
  /** Model id advertised to DSH and sent on the wire as `model`. */
  externalId: string;
  /** The `--model` value the `qoderclicn` CLI expects. */
  cliModel: string;
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
declare const QODER_MODELS: readonly QoderModel[];
/**
 * The DSH-facing model id for one CLI spelling.
 *
 * Every id in {@link QODER_MODELS} is `qoder-` plus the lowercased CLI name,
 * so a model the CLI adds later gets a stable, predictable id without a code
 * change — and ids recorded in the usage ledger keep resolving. Names are
 * already unique case-insensitively, which the fetch path relies on.
 */
declare function qoderExternalId(cliModel: string): string;
/** Default model when a request body omits one. */
declare const QODER_DEFAULT_MODEL = "Qwen3.7-Max";
/**
 * Reasoning-effort levels `--reasoning-effort` accepts, in the CLI's own
 * order. Verified against CLI 1.1.59: any other value makes the CLI exit
 * before the request is served ("Invalid reasoning effort: ...").
 */
declare const QODER_REASONING_EFFORTS: readonly ["auto", "none", "low", "medium", "high", "xhigh", "max", "ultracode"];
/** Thinking modes `--thinking` accepts; verified against CLI 1.1.59. */
declare const QODER_THINKING_MODES: readonly ["auto", "adaptive", "enabled", "disabled"];
/** One reasoning-effort level. */
type QoderReasoningEffort = typeof QODER_REASONING_EFFORTS[number];
/** One thinking mode. */
type QoderThinkingMode = typeof QODER_THINKING_MODES[number];
/** Ceiling on `--thinking-budget`, matching the CLI's own usable range. */
declare const QODER_MAX_THINKING_BUDGET = 1000000;
/** Overall ceiling for one CLI run, in milliseconds. */
declare const QODER_TIMEOUT_MS = 600000;
/** Readiness facts for the qoder path. Never throws — callers surface `reason`. */
interface QoderStatus {
  id: 'qoder';
  /** Whether a chat request can be served right now. */
  ready: boolean;
  /** The resolved CLI command, or null when none was found. */
  cli: string | null;
  /** Whether an OAuth login state file exists on disk. */
  oauth: boolean;
  /** Whether a PAT is available (option or environment). */
  pat: boolean;
  /** The OAuth state file that exists, or the documented default. */
  oauthFile: string;
  /** Human-readable explanation; present in both ready and not-ready answers. */
  reason: string;
}
/** Options shared by every qoder entry point. */
interface QoderOptions {
  /** CLI command name or absolute path; defaults to `qoderclicn`. */
  command?: string;
  /** Extra argv inserted before the subcommand arguments. */
  prefixArgs?: readonly string[];
  /** PAT used when no OAuth login state exists. */
  pat?: string;
  /**
   * Reasoning effort for every run (`--reasoning-effort`). Absent leaves the
   * CLI's own default in place — the flag is only ever added when set, so an
   * unknown spelling can never be sent by accident.
   */
  reasoningEffort?: QoderReasoningEffort;
  /** Thinking mode for every run (`--thinking`). Absent uses the CLI default. */
  thinking?: QoderThinkingMode;
  /**
   * Fixed thinking-token budget (`--thinking-budget`). Implies thinking
   * enabled, so it is only sent when explicitly configured.
   */
  thinkingBudget?: number;
  /** Home directory to probe; defaults to `os.homedir()`. */
  homeDir?: string;
  /**
   * Serve models at the largest context window the official catalog declares
   * for them (`--context-window`) instead of the window the official client
   * picks by default. Recorded here so the status card can show what is in
   * effect; the value itself comes from {@link QoderOptions.resolveContextWindow}.
   */
  contextWindowMax?: boolean;
  /**
   * Resolve the explicit `--context-window` value for one CLI model name.
   *
   * A resolver rather than a number because the window is a per-model fact:
   * the official catalog lists several windows per model (typically 200K /
   * 400K / 1M) and only the caller holding that catalog knows which are real.
   * Returning undefined omits the flag, which leaves the CLI's own configured
   * default in place.
   *
   * The value is passed through unvalidated on purpose: the CLI accepts any
   * number without complaint (verified — `--context-window 999` runs), so
   * guarding has to happen where the catalog is known, not here.
   */
  resolveContextWindow?: (cliModel: string) => number | undefined;
  /** Abort signal for one chat run. */
  signal?: AbortSignal;
  /**
   * Called exactly once when one run finishes — success, error, abort, or
   * timeout — with whatever the CLI reported. Used to persist the usage
   * ledger; must never throw (its failures are the caller's problem).
   */
  onRunComplete?: (result: QoderRunResult, model: string) => void;
  /** Overall ceiling for one chat run, in milliseconds. */
  timeoutMs?: number;
}
/**
 * Candidate OAuth-state files left by `qoderclicn login`, in probe order.
 * The contents are an encrypted blob — only existence is checked here; the
 * CLI itself reads and decrypts it.
 */
declare function qoderOauthUserCandidates(homeDir?: string): string[];
/** First existing candidate, or the documented default when none exists. */
declare function qoderOauthUserPath(options?: QoderOptions): string;
/** Drop every cached resolution (tests, and a config change repointing the CLI). */
declare function clearQoderCliCache(): void;
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
declare function parseListModelsOutput(stdout: string): QoderModel[] | null;
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
declare function fetchQoderModels(options?: QoderOptions): Promise<QoderModel[] | null>;
/**
 * Readiness of the qoder path: CLI installed AND (OAuth login OR PAT).
 * Never throws — callers surface `reason` to the user.
 */
declare function qoderStatus(options?: QoderOptions): QoderStatus;
/** Extract the text delta from one stream-json line; null for non-text records. */
declare function parseCliDelta(line: string): string | null;
/** What the CLI's final `result` record says about one run. */
interface QoderRunResult {
  /** Credits the CLI charged (`total_credits`); 0 when absent. */
  credits: number;
  /** Wall-clock duration of the run (`duration_ms`); 0 when absent. */
  ms: number;
  /** CLI turns the run took (`num_turns`); 0 when absent. */
  turns: number;
  /** Whether the CLI flagged the run as an error (`is_error`). */
  isError: boolean;
}
/**
 * Extract the run summary from one stream-json line; null for every other
 * record. The `result` record is the CLI's last line and the only place it
 * reports credit cost — the session event logs carry no credits at all.
 */
declare function parseCliResult(line: string): QoderRunResult | null;
/** Options for {@link buildCliPrompt}. */
interface BuildCliPromptOptions {
  /** Ceiling on the flattened history; defaults to {@link QODER_MAX_PROMPT_CHARS}. */
  maxPromptChars?: number;
  /** Ceiling on the system prompt; defaults to {@link QODER_MAX_SYSTEM_CHARS}. */
  maxSystemChars?: number;
}
/** What {@link buildCliPrompt} built, including what it had to drop. */
interface CliPrompt {
  /** The `--append-system-prompt` value (possibly truncated). */
  system: string;
  /** The one-shot prompt (recent messages kept, older ones dropped). */
  prompt: string;
  /** How many earlier messages were dropped to fit the cap. */
  dropped: number;
  /** Whether any text was cut to fit the caps. */
  truncated: boolean;
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
declare function buildCliPrompt(messages: unknown, options?: BuildCliPromptOptions): CliPrompt;
/** Map a wire model id (externalId or CLI spelling) to the CLI's `--model` value. */
declare function cliModelFor(model: string): string;
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
declare function buildReasoningArgs(options?: QoderOptions): string[];
/** One OpenAI chat.completion.chunk object. */
interface ChatChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: Array<{
    index: 0;
    delta: {
      content?: string;
    };
    finish_reason: string | null;
  }>;
}
/**
 * Run one chat completion through the CLI, yielding OpenAI chunk objects as
 * the stream-json lines arrive. Honors `signal` (client gone) and `timeoutMs`
 * (overall ceiling) by killing the child. The final chunk always carries
 * finish_reason 'stop'.
 */
declare function qoderChatStream(body: unknown, options?: QoderOptions): AsyncGenerator<ChatChunk>;
/** Aggregate streamed chunks into one chat.completion (usage estimated: chars/4). */
declare function aggregateQoderChunks(chunks: readonly ChatChunk[], requestBody: unknown): {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: Array<{
    index: 0;
    message: {
      role: 'assistant';
      content: string;
    };
    finish_reason: 'stop';
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
};
//#endregion
//#region src/version.d.ts
/**
 * Build-time version injected by tsdown from package.json.
 *
 * @module dsh-qoder-connect/version
 */
/** The plugin's own version, as published in package.json. */
declare const QODER_CONNECT_VERSION: string;
//#endregion
//#region src/catalog.d.ts
/** One served model row. */
interface QoderCatalogEntry {
  /** The DSH-facing model id. */
  id: string;
  /** The CLI's own spelling, shown as the display name. */
  name: string;
}
/** Where the current roster came from, best tier first. */
type QoderRosterSource = 'cli' | 'saved' | 'builtin';
/** The live catalog: the roster plus its current visibility. */
declare class QoderCatalog {
  private entries;
  private visible;
  /** Where the current roster came from, for the settings card. */
  private rosterSource;
  /**
   * Model ids the user switched off. Kept apart from the roster because it is
   * a user preference, not a fact about Qoder: the roster is replaced wholesale
   * by every refresh, while a hidden id must survive one — otherwise switching
   * a model off would silently un-hide it the next time the CLI answered.
   */
  private hidden;
  constructor(models?: readonly QoderModel[]);
  /** The rows to serve; empty while hidden. */
  current(): readonly QoderCatalogEntry[];
  /** Every row, whether or not the group is currently shown. */
  all(): readonly QoderCatalogEntry[];
  /** Every row with its on/off state, for the card's model switches. */
  withVisibility(): Array<QoderCatalogEntry & {
    on: boolean;
  }>;
  /** The ids currently switched off. */
  hiddenIds(): readonly string[];
  /** Whether the group is currently shown. */
  isVisible(): boolean;
  /** Where the current roster came from. */
  source(): QoderRosterSource;
  /**
   * Set visibility.
   * @returns whether the state actually changed.
   */
  setVisible(visible: boolean): boolean;
  /**
   * Replace the set of switched-off model ids.
   *
   * Ids the roster does not know are kept anyway: a model hidden while the
   * built-in fallback served must stay hidden after the CLI's own roster
   * arrives, or the switch would appear to undo itself.
   *
   * @returns whether the served rows actually changed.
   */
  setHidden(ids: readonly string[]): boolean;
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
  hydrate(entries: readonly QoderCatalogEntry[]): boolean;
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
  setModels(models: readonly QoderModel[], source?: 'cli' | 'builtin'): boolean;
}
//#endregion
//#region src/model-catalog.d.ts
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
/** One off-peak promotion window. */
interface QoderPromotion {
  /** Multiplier applied inside the window (e.g. 0.4 = 40% of the peak price). */
  discountFactor: number;
  /** Window start, `HH:MM` in the promotion's own timezone. */
  windowStart: string;
  /** Window end, `HH:MM`. */
  windowEnd: string;
  /** The upstream's own badge text, when it supplied one. */
  badge: string | null;
  /** IANA timezone the window is expressed in. */
  timezone: string | null;
}
/** The catalog facts for one model. */
interface QoderModelFacts {
  /** Upstream model key, e.g. `qmodel_latest` (what `x-model-key` would carry). */
  key: string;
  /** The upstream's own display name, as the CLI also spells it. */
  displayName: string;
  /**
   * Official price multiplier. `0` with `free` set means the model is
   * currently free rather than free of charge forever, so keep the two
   * together when rendering.
   */
  priceFactor: number | null;
  /** The pre-promotion price, present when a promotion is configured. */
  originalPriceFactor: number | null;
  /** Whether the upstream marks the model as carrying a free allowance. */
  free: boolean;
  /** The configured off-peak promotion, when there is one. */
  promotion: QoderPromotion | null;
  /** Default context window in tokens, when the catalog declares one. */
  contextWindow: number | null;
  /** Every context window the official client offers for this model. */
  contextWindows: readonly number[];
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
  efforts: readonly string[];
  /** The effort the upstream marks as default, when it marks one. */
  defaultEffort: string | null;
  /** Whether the catalog declares thinking can be turned off entirely. */
  canDisableThinking: boolean;
  /**
   * Whether the model declares images (`is_vl`). Recorded for diagnostics
   * only — the CLI's prompt is one argv string, so this plugin still cannot
   * forward an image and deliberately does not advertise the capability.
   */
  supportsImages: boolean;
}
/** One successfully read catalog. */
interface QoderCatalogSnapshot {
  /** Facts keyed by the display name lowercased (how the CLI names models). */
  facts: ReadonlyMap<string, QoderModelFacts>;
  /** The account uid the container was keyed by. */
  uid: string;
  /** The file the facts came from, for diagnostics. */
  file: string;
}
/** Options for {@link loadQoderModelFacts}. */
interface LoadCatalogOptions {
  /** Home directory to probe; defaults to `os.homedir()`. */
  homeDir?: string;
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
declare function decryptQmcCatalog(blob: string, uid: string): string;
/**
 * Parse one decrypted catalog document into per-model facts.
 *
 * Exported separately from decryption so the parsing rules can be tested
 * against a literal document without constructing an encrypted container.
 *
 * @param document - the decrypted JSON text.
 * @returns facts keyed by lowercased display name; empty when unusable.
 */
declare function parseCatalogDocument(document: string): Map<string, QoderModelFacts>;
/**
 * Read, decrypt and parse the official catalog.
 *
 * Never throws: every failure — no client installed, no cache yet, a changed
 * container format, a tampered file — answers `null`, and the caller keeps
 * serving models without the extra facts.
 */
declare function loadQoderModelFacts(options?: LoadCatalogOptions): Promise<QoderCatalogSnapshot | null>;
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
declare function thinkingLevelMapFor(facts: QoderModelFacts | undefined): Record<string, string | null> | null;
/**
 * Format a model's official price for its display name.
 *
 * The spelling follows dsh-workbuddy-connect (`x0.79`) because the value is
 * the same kind of fact there and here — a multiplier the vendor publishes —
 * so unlike the measured ratio this replaced, it does not overstate itself.
 * The off-peak badge is appended when the catalog configures one, since the
 * discount is invisible in the static multiplier.
 */
declare function formatQoderPrice(facts: QoderModelFacts | undefined): string;
//#endregion
//#region src/shim.d.ts
/** Minimal logger surface the plugin context already provides. */
interface ShimLogger {
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}
/** What the plugin needs from a running shim. */
interface QoderShim {
  /** Resolves once the listener is up; rejects if listening failed. */
  ready: Promise<void>;
  /** The shim origin, e.g. `http://127.0.0.1:39271`; valid after ready. */
  baseUrl(): string;
  /**
   * The per-process shared secret the plugin's own client must carry as
   * `Authorization: Bearer <token>`. Lives only in memory; the adapter
   * resolves this as the OpenAI apiKey, which pi-ai sends as
   * `Authorization: Bearer ...`. The shim never forwards it to the CLI.
   */
  token(): string;
  /** Stop serving and destroy open connections. */
  close(): Promise<void>;
}
/** Constructor dependencies. */
interface QoderShimOptions {
  /**
   * Qoder CLI overrides (command, PAT, home dir); env vars still apply.
   *
   * A thunk is read once per request rather than snapshotted at construction,
   * so a setting edited on the card reaches the next chat run without a
   * restart. A plain object is still accepted and behaves as a constant.
   */
  qoder?: QoderOptions | (() => QoderOptions);
  logger?: ShimLogger;
}
/**
 * Start the loopback endpoint. Requests carry the per-process bearer; the
 * loopback bind plus the secret are the boundary, and the qoder credential
 * comes from the CLI's own on-disk state alone.
 */
declare function createQoderShim(options?: QoderShimOptions): QoderShim;
//#endregion
//#region src/adapter.d.ts
/** Provider route this bundle owns. */
declare const QODER_PROVIDER = "qoder";
/** Provider idle ceiling while one stream read is outstanding. */
declare const QODER_STREAM_IDLE_TIMEOUT_MS = 300000;
/**
 * Which context window a model is served at.
 *
 * `default` is the window the official client itself uses (the catalog's
 * `is_default` entry); `max` is the largest window the catalog declares for
 * that model, which the upstream serves but the client does not select by
 * default. The choice rides on `--context-window` per request and is reported
 * to the picker, so the two never disagree about what is in effect.
 */
type QoderContextWindowMode = 'default' | 'max';
/** Constructor dependencies. */
interface QoderAdapterOptions {
  shim: QoderShim;
  /**
   * The live catalog: its *visible* rows are the models this adapter serves.
   * An empty catalog (not ready) is how the Qoder group stays out of the
   * picker, so the host never offers a model that cannot be served.
   */
  catalog: QoderCatalog;
  /** Resolve the durable attachment service at request time, when present. */
  resolveAttachments?: () => AttachmentStore | undefined;
  /**
   * The official catalog's per-model facts, read synchronously from a
   * snapshot the host refreshes in the background. Absent or empty means the
   * models are served without price, per-model levels or official context
   * windows — a machine that has never run the official client must still
   * get a working picker, so this can never be a required input.
   */
  modelFacts?: () => ReadonlyMap<string, QoderModelFacts>;
  /**
   * Which context window the models are served at. A thunk, like
   * {@link QoderAdapterOptions.modelFacts}, so a switch flipped on the card
   * republishes with the next snapshot instead of freezing at startup.
   */
  contextWindowMode?: () => QoderContextWindowMode;
}
/** What {@link createQoderAdapter} hands back. */
interface QoderAdapter {
  adapter: PiAiAdapter;
  /** Rebuild the adapter's provider snapshot; call after a readiness change. */
  invalidate: () => void;
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
declare function createQoderAdapter(options: QoderAdapterOptions): QoderAdapter;
//#endregion
//#region src/catalog-store.d.ts
/**
 * Durable copy of the last roster the CLI actually reported.
 *
 * The served roster has three tiers, best first:
 *
 * 1. **live** — `qoderclicn --list-models` answered just now;
 * 2. **saved** — the last live answer, persisted here;
 * 3. **builtin** — the snapshot compiled into the plugin.
 *
 * Tier 2 is what this module exists for. Without it a restart — or a CLI
 * that answers `null` because it is mid-upgrade, not on PATH in a new shell,
 * or simply slow — drops the picker straight from live to builtin, so a
 * machine that had this account's real model list silently shows a stale
 * one. The saved copy is written only from a successful live answer, so it
 * can never be worse than what the CLI itself reported.
 *
 * The file is the plugin's own rebuildable state, so it lives beside the
 * ledger under `$DSH_HOME/qoder-connect/` and is safe to delete: losing it
 * costs one CLI spawn to rebuild, never correctness.
 *
 * @module dsh-qoder-connect/catalog-store
 */
/** One persisted roster row. */
interface QoderSavedModel {
  /** The DSH-facing model id. */
  id: string;
  /** The CLI's own spelling. */
  name: string;
}
/** The persisted document. */
interface QoderSavedRoster {
  /** Schema version; anything else is discarded rather than migrated. */
  version: 1;
  /** Epoch ms when a live answer was last persisted. */
  savedAt: number;
  /** The roster, in the order the CLI reported it. */
  models: QoderSavedModel[];
}
/** Where the saved roster lives: `$DSH_HOME/qoder-connect/roster.json`. */
declare function qoderRosterPath(): string;
/**
 * Read the saved roster.
 *
 * Every failure mode — missing file, unreadable JSON, a foreign schema, an
 * empty or malformed roster — answers `null` rather than throwing, because
 * the caller's fallback (the built-in list) is a perfectly good answer and a
 * corrupt cache must never cost the plugin its startup.
 */
declare function loadQoderRoster(): Promise<QoderSavedRoster | null>;
/**
 * Persist a live roster.
 *
 * Written through a temp file and a rename so a crash mid-write cannot leave
 * a truncated document behind — the next read would otherwise discard the
 * whole cache over a half-written line.
 *
 * Never throws: a failed write costs the next restart's tier, not this run.
 */
declare function saveQoderRoster(models: readonly QoderSavedModel[]): Promise<void>;
//#endregion
//#region src/images.d.ts
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
/** What {@link materializeImageAttachments} produced for one run. */
interface QoderImageMaterial {
  /** Temp file paths to pass as `--attachment`, in the order they appeared. */
  paths: string[];
  /**
   * Image parts that were seen but could not be turned into a file — a
   * remote URL, an unsupported encoding, an oversized body, or a malformed
   * data URL. Surfaced so a caller can tell "no images" from "images lost".
   */
  skipped: number;
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
declare function materializeImageAttachments(messages: unknown): Promise<QoderImageMaterial>;
/**
 * Remove one run's materialized images.
 *
 * Every path came from the same temp directory, so the directory is removed
 * recursively and the individual paths are best-effort. Never throws.
 */
declare function disposeImageAttachments(paths: readonly string[]): Promise<void>;
//#endregion
//#region src/ledger.d.ts
/**
 * Local usage ledger for the qoder route.
 *
 * Every completed CLI run carries its credit cost in the stream-json
 * `result` record (`total_credits`) — the only place the Qoder CLI reports
 * money. This module persists one JSONL line per run under the dsh home so
 * the `dsh-qoder-credits` widget can show consumption without any vendor
 * usage-history API (there is none).
 *
 * The file is written here and read by the credits plugin; the two agree on
 * the entry shape below and nothing else. Node built-ins only.
 *
 * @module dsh-qoder-connect/ledger
 */
/** One completed CLI run, as persisted. */
interface QoderLedgerEntry {
  /** Epoch ms when the run finished. */
  ts: number;
  /** DSH-facing model id, e.g. `qoder-qwen3.7-max`. */
  model: string;
  /** The CLI's own model spelling, e.g. `Qwen3.7-Max`. */
  cli: string;
  /** Credits the CLI charged for this run. */
  credits: number;
  /** Wall-clock duration of the run, ms. */
  ms: number;
  /** CLI turns the run took. */
  turns: number;
  /** Flattened prompt length in characters (the CLI reports no tokens). */
  chars: number;
  /** Whether the CLI itself flagged the run as an error. */
  error: boolean;
}
/** Where the ledger lives: `$DSH_HOME/qoder-credits/ledger.jsonl`. */
declare function qoderLedgerPath(): string;
/**
 * Append one run to the ledger. Never throws: a failed write costs a data
 * point, never the chat that produced it.
 *
 * @returns a promise that settles once the line is on disk (or the failure
 *   is swallowed); callers may fire-and-forget.
 */
declare function appendQoderLedgerEntry(entry: QoderLedgerEntry, onError?: (error: unknown) => void): Promise<void>;
//#endregion
//#region src/status-paths.d.ts
/**
 * Node-free constants and types shared by the Host and browser halves.
 *
 * @module dsh-qoder-connect/status-paths
 */
/** Plugin-owned status endpoint consumed by its browser half. */
declare const QODER_STATUS_PATH = "/plugins/dsh-qoder-connect/status";
/**
 * Same-origin write endpoint for the reasoning controls. The card's settings
 * page owns editing; this exists so the controls live on the plugin's own
 * card rather than the generic settings form.
 */
declare const QODER_CONFIG_PATH = "/plugins/dsh-qoder-connect/config";
/** One model as the settings card displays it. */
interface QoderWebModel {
  id: string;
  /** The CLI's own spelling, e.g. `Qwen3.8-Max`. */
  name: string;
}
/** One model with its on/off state, for the card's model switches. */
interface QoderWebModelSwitch extends QoderWebModel {
  /** Whether the model is offered in the picker. */
  on: boolean;
}
/** The reasoning controls currently in effect, as the card renders them. */
interface QoderWebReasoning {
  /** Selected `--reasoning-effort`, or '' when the flag is not sent. */
  effort: string;
  /** Selected `--thinking` mode, or '' when the flag is not sent. */
  thinking: string;
  /** Selected `--thinking-budget`, or 0 when the flag is not sent. */
  budget: number;
}
/** The context-window switch currently in effect, as the card renders it. */
interface QoderWebContextWindow {
  /**
   * Whether models are served at the largest window the official catalog
   * declares for them (`--context-window`) rather than the window the
   * official client picks by default.
   */
  max: boolean;
}
/**
 * Where the served model roster came from, best tier first.
 *
 * `cli` means `qoderclicn --list-models` answered just now, so the picker
 * shows this account's own models — including any Qoder added after this
 * plugin shipped. `saved` means the CLI could not answer this time and the
 * roster persisted from its last successful answer is standing in. `builtin`
 * means neither was available and the compiled fallback serves, which is
 * worth surfacing: a silently stale roster is exactly what makes a newly
 * added model look missing.
 */
type QoderRosterSource$1 = 'cli' | 'saved' | 'builtin';
/** The JSON document the plugin card renders. */
type QoderWebStatus = {
  status: 'ready';
  /** The resolved CLI command. */
  cli: string;
  /** Whether the OAuth login state file or a PAT is in use. */
  source: 'oauth' | 'pat';
  /** The OAuth state file probed for, whether or not it exists. */
  oauthFile: string;
  /** Human-readable readiness explanation. */
  reason: string;
  models: readonly QoderWebModel[];
  /** Every model with its on/off state, so the card can render switches
   *  for models that are currently hidden too. */
  switches: readonly QoderWebModelSwitch[];
  /** The reasoning controls in effect for this configuration. */
  reasoning: QoderWebReasoning;
  /** The context-window switch in effect for this configuration. */
  contextWindow: QoderWebContextWindow;
  /** Whether the roster is the CLI's live answer or the built-in fallback. */
  rosterSource: QoderRosterSource$1;
} | {
  status: 'not-ready';
  /** Why no chat request can be served right now. */
  reason: string;
  /** The resolved CLI command when one was found. */
  cli?: string;
  /** Whether an OAuth login state file exists on disk. */
  oauth: boolean;
  /** Whether a PAT is available. */
  pat: boolean;
  /** The OAuth state file probed for. */
  oauthFile: string;
  /** The reasoning controls in effect for this configuration. */
  reasoning: QoderWebReasoning;
  /** The context-window switch in effect for this configuration. */
  contextWindow: QoderWebContextWindow;
  /** Every model with its on/off state, so the card can render switches
   *  for models that are currently hidden too. */
  switches: readonly QoderWebModelSwitch[];
  /** Whether the roster is the CLI's live answer or the built-in fallback. */
  rosterSource: QoderRosterSource$1;
} | {
  status: 'error';
  message: string;
};
//#endregion
//#region src/web-status.d.ts
/** Constructor dependencies. */
interface QoderStatusRouteOptions {
  catalog: QoderCatalog;
  /** Qoder CLI overrides; env vars still apply. */
  qoder?: QoderOptions;
  /**
   * Settings namespace backing the editable reasoning fields, resolved at
   * request time. Absent (headless, or settings not yet attached) simply
   * means the write route answers 501.
   */
  settings?: () => Promise<SettingsForms | undefined>;
  /**
   * The namespace the card's writes target, and the plugin's own namespace.
   * Required for the write route; without it writes are refused.
   */
  settingsNs?: string;
  /**
   * Re-read everything the picker shows: the CLI's model roster and the
   * official catalog's price, thinking levels and context windows.
   * Absent means the card's refresh button only re-reads the current status.
   */
  refreshModels?: () => Promise<void>;
  /**
   * How many models the official catalog's facts covered on the last read.
   * Reported by the refresh response so the card can show whether the price
   * and levels actually came from the official catalog or the fallback.
   */
  factsCount?: () => number;
  /**
   * Called after the host has accepted a settings write.
   *
   * The write commits the volatile refs in place, so the plugin's own live
   * reads already see the new values by the time this runs; what still needs
   * doing is republishing the adapter snapshot, because a context-window
   * switch or a model toggle changes what the picker serves and nothing else
   * would notice until the next readiness sweep.
   */
  onSettingsChanged?: () => void;
}
/**
 * The reasoning controls as the card renders them: the live options plus the
 * vocabularies the CLI accepts, so the UI never offers a level the CLI would
 * reject outright.
 */
declare function qoderWebReasoning(qoder?: QoderOptions): QoderWebReasoning;
/**
 * The context-window switch as the card renders it.
 *
 * Read off the live options rather than from a stored setting, so the card
 * shows what is actually in effect for the next request — including a value
 * edited elsewhere while the card was open.
 */
declare function qoderWebContextWindow(qoder?: QoderOptions): QoderWebContextWindow;
/**
 * Assemble the card's status document. Readiness is read-only; nothing here
 * contacts the network — the CLI probe is a local `--version` spawn.
 */
declare function qoderWebStatus(deps: QoderStatusRouteOptions): QoderWebStatus;
/** Mount the GET status route on an optional webServer context. */
declare function registerQoderStatusRoute(ctx: Context, deps: QoderStatusRouteOptions): void;
/** One validated settings write from the card. */
interface QoderConfigPatch {
  reasoningEffort?: string;
  thinking?: string;
  thinkingBudget?: number;
  contextWindowMax?: boolean;
  hiddenModels?: string[];
}
/**
 * Validate one posted patch against the CLI's own vocabularies.
 *
 * The CLI treats an unknown `--reasoning-effort` as fatal, so a bad value
 * must be refused at the edge rather than persisted and then replayed into
 * every later request. `''` is accepted for the two selects and means "do not
 * send this flag"; the empty string cannot reach the schema as a valid level.
 *
 * `contextWindowMax` is a plain boolean — the number it stands for is a
 * per-model fact read from the official catalog at request time, so there is
 * nothing here for a caller to get wrong.
 */
declare function parseQoderConfigPatch(body: unknown): {
  patch: QoderConfigPatch;
} | {
  error: string;
};
/**
 * Backwards-compatible alias for {@link parseQoderConfigPatch}.
 *
 * The route outgrew its original name when the context-window switch joined
 * the reasoning controls, but the reasoning spelling is what the existing
 * call sites and tests use, so it stays available.
 */
declare const parseReasoningPatch: typeof parseQoderConfigPatch;
/**
 * The write route's handler: validate the patch, then merge it into the
 * plugin's own settings namespace so the change is durable and reaches the
 * live config thunk through the section's `onChange`.
 */
declare function qoderConfigHandler(deps: QoderStatusRouteOptions): (req: IncomingMessage, res: ServerResponse) => Promise<void>;
/** Mount both the read and write routes; the write route is best-effort. */
declare function registerQoderRoutes(ctx: Context, deps: QoderStatusRouteOptions): void;
//#endregion
//#region src/index.d.ts
/** Stable Cordis plugin name. */
declare const name = "llm-qoder";
/** The model registry required before the provider can register. */
declare const inject: string[];
/**
 * Settings namespace this plugin's card writes through.
 *
 * It is the **profile entry id** — the package name as it appears in the
 * profile's `dependencies` and `dsh.profile.bundles` — not the model provider
 * id. DSH's settings service resolves a namespace by matching
 * `entry.options.id` (`dsh-settings` `SettingsForms.write`), and an entry id
 * is the bundle's package name, so the two are different keys that happen to
 * describe the same plugin.
 *
 * Getting this wrong is not a silent no-op: the write throws
 * `No configurable plugin entry "<ns>"`, which surfaces on the card as a
 * failed save with no hint that the namespace was the problem. The provider
 * id (`qoder`) is the right answer for `llm.registerAdapter` and the wrong
 * one here.
 */
declare const QODER_SETTINGS_NS: SettingsNamespace;
/**
 * A `Volatile` reference as schemastery hands it to a plugin.
 *
 * A schema field marked `volatile()` validates to one of these instead of a
 * plain value, so that the loader can commit an edit in place rather than
 * remounting the plugin. The getter is typed loosely on purpose: cosmokit's
 * `Volatile<T>` reports a readonly view of `T`, which does not line up with
 * the mutable `T` this plugin stores, and the only thing done with the result
 * is read it.
 */
interface VolatileRef {
  get(): unknown;
}
/** Plugin configuration. */
interface Config {
  /**
   * Qoder CLI command name or absolute path, overriding `QODERCN_CLI` and
   * the default `qoderclicn`. Point this at the executable when the CLI is
   * not on PATH (the Qoder installer puts it under `~/.qoder-cn/bin/`).
   */
  cli?: string;
  /**
   * Reasoning effort sent as `--reasoning-effort` on every run. Empty (the
   * default) omits the flag entirely and lets the CLI decide.
   */
  reasoningEffort?: QoderReasoningEffort;
  /** Thinking mode sent as `--thinking`. Empty omits the flag. */
  thinking?: QoderThinkingMode;
  /**
   * Fixed thinking-token budget sent as `--thinking-budget`. Unset omits the
   * flag; the CLI treats it as implying thinking enabled.
   */
  thinkingBudget?: number;
  /**
   * Serve models at the largest context window the official catalog declares
   * for them instead of the window the official client picks by default
   * (`--context-window`). Off leaves the CLI's own configured default alone.
   *
   * Only ever a switch between two catalog-declared windows: the value sent
   * is read from the catalog, never computed, because the CLI accepts any
   * number without complaint and would otherwise be handed a fiction.
   */
  contextWindowMax?: boolean;
  /**
   * Model ids switched off in the picker. An empty list (the default) serves
   * every model the roster carries.
   *
   * Held as a user preference rather than derived from the roster, so it
   * survives a refresh: switching a model off and then having the CLI answer
   * must not silently switch it back on.
   */
  hiddenModels?: string[];
}
/**
 * The config as the host hands it to `apply()`.
 *
 * Identical to {@link Config} except that every field may arrive as a
 * `Volatile` ref rather than a plain value, because each schema field is
 * marked `volatile()` so the host can commit a card edit in place instead of
 * remounting the plugin. {@link readConfig} is the one place that resolves
 * them; everything downstream of it sees plain {@link Config}.
 */
type AppliedConfig = { [K in keyof Config]: Config[K] | VolatileRef | undefined; };
/**
 * The plugin schema.
 *
 * Every field is `volatile()`, which is what lets the card save without DSH
 * tearing the plugin down: an ordinary config change remounts the entry
 * (losing the loopback shim, the catalog and the readiness sweep), while a
 * volatile-only change is committed in place by the loader.
 *
 * The price is that `apply()` receives these fields wrapped in `Volatile`
 * refs rather than as plain values — see {@link readConfig} and
 * {@link AppliedConfig}.
 *
 * Deliberately left without a type annotation: schemastery's `z<T>` constrains
 * a schema's input and output to the same `T`, and here they differ — the
 * profile document holds plain values while validation returns refs. The
 * inferred type is the honest one; the logical shape lives in the `Config`
 * interface, which is what every consumer of this module actually annotates
 * against.
 */
declare const Config: z<Schemastery.ObjectS<NoInfer<{
  cli: z<string, string, "volatile">;
  reasoningEffort: z<"auto" | "none" | "low" | "medium" | "high" | "xhigh" | "max" | "ultracode", "auto" | "none" | "low" | "medium" | "high" | "xhigh" | "max" | "ultracode", "volatile">;
  thinking: z<"auto" | "adaptive" | "enabled" | "disabled", "auto" | "adaptive" | "enabled" | "disabled", "volatile">;
  thinkingBudget: z<number, number, "volatile">;
  contextWindowMax: z<boolean, boolean, "volatile">;
  hiddenModels: z<NoInfer<string[]>, NoInfer<string[]>, "volatile">;
}>>, Schemastery.ObjectT<NoInfer<{
  cli: z<string, string, "volatile">;
  reasoningEffort: z<"auto" | "none" | "low" | "medium" | "high" | "xhigh" | "max" | "ultracode", "auto" | "none" | "low" | "medium" | "high" | "xhigh" | "max" | "ultracode", "volatile">;
  thinking: z<"auto" | "adaptive" | "enabled" | "disabled", "auto" | "adaptive" | "enabled" | "disabled", "volatile">;
  thinkingBudget: z<number, number, "volatile">;
  contextWindowMax: z<boolean, boolean, "volatile">;
  hiddenModels: z<NoInfer<string[]>, NoInfer<string[]>, "volatile">;
}>>, "plain">;
declare function apply(ctx: Context, config: AppliedConfig): void;
//#endregion
export { AppliedConfig, Config, QODER_CONFIG_PATH, QODER_CONNECT_VERSION, QODER_DEFAULT_MODEL, QODER_MAX_THINKING_BUDGET, QODER_MODELS, QODER_PROVIDER, QODER_REASONING_EFFORTS, QODER_SETTINGS_NS, QODER_STATUS_PATH, QODER_STREAM_IDLE_TIMEOUT_MS, QODER_THINKING_MODES, QODER_TIMEOUT_MS, type QoderAdapter, QoderCatalog, type QoderCatalogEntry, type QoderCatalogSnapshot, type QoderContextWindowMode, type QoderImageMaterial, type QoderLedgerEntry, type QoderModelFacts, type QoderPromotion, type QoderReasoningEffort, type QoderRosterSource, type QoderRunResult, type QoderSavedModel, type QoderSavedRoster, type QoderShim, type QoderStatus, type QoderThinkingMode, type QoderWebContextWindow, type QoderWebReasoning, type QoderWebStatus, aggregateQoderChunks, appendQoderLedgerEntry, apply, buildCliPrompt, buildReasoningArgs, clearQoderCliCache, cliModelFor, createQoderAdapter, createQoderShim, decryptQmcCatalog, disposeImageAttachments, fetchQoderModels, formatQoderPrice, inject, loadQoderModelFacts, loadQoderRoster, materializeImageAttachments, name, parseCatalogDocument, parseCliDelta, parseCliResult, parseListModelsOutput, parseQoderConfigPatch, parseReasoningPatch, qoderChatStream, qoderConfigHandler, qoderExternalId, qoderLedgerPath, qoderOauthUserCandidates, qoderOauthUserPath, qoderRosterPath, qoderStatus, qoderWebContextWindow, qoderWebReasoning, qoderWebStatus, registerQoderRoutes, registerQoderStatusRoute, saveQoderRoster, thinkingLevelMapFor };