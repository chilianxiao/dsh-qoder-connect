import { C as qoderStatus, S as qoderOauthUserPath, T as materializeImageAttachments, _ as parseListModelsOutput, a as QODER_REASONING_EFFORTS, b as qoderModelListEntry, c as aggregateQoderChunks, d as clearQoderCliCache, f as cliModelFor, g as parseCliResult, h as parseCliDelta, i as QODER_MODELS, l as buildCliPrompt, m as flattenContent, n as QODER_DEFAULT_MODEL, o as QODER_THINKING_MODES, p as fetchQoderModels, r as QODER_MAX_THINKING_BUDGET, s as QODER_TIMEOUT_MS, t as QODER_CONNECT_VERSION, u as buildReasoningArgs, v as qoderChatStream, w as disposeImageAttachments, x as qoderOauthUserCandidates, y as qoderExternalId } from "./version-BDumUb3N.js";
import z from "@deepseek-ai/schemastery";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { appendFile, mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { createDecipheriv, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import { dshHomePath } from "@deepseek-ai/dsh-home-paths";
import { createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { resolveRetryPolicy } from "@deepseek-ai/dsh-llm";
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import { createServer } from "node:http";
//#region src/catalog.ts
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
/** The live catalog: the roster plus its current visibility. */
var QoderCatalog = class {
	entries;
	visible = false;
	/** Where the current roster came from, for the settings card. */
	rosterSource = "builtin";
	/**
	* Model ids the user switched off. Kept apart from the roster because it is
	* a user preference, not a fact about Qoder: the roster is replaced wholesale
	* by every refresh, while a hidden id must survive one — otherwise switching
	* a model off would silently un-hide it the next time the CLI answered.
	*/
	hidden = /* @__PURE__ */ new Set();
	constructor(models = QODER_MODELS) {
		this.entries = models.map((model) => ({
			id: model.externalId,
			name: model.cliModel
		}));
	}
	/** The rows to serve; empty while hidden. */
	current() {
		if (!this.visible) return [];
		return this.entries.filter((entry) => !this.hidden.has(entry.id));
	}
	/** Every row, whether or not the group is currently shown. */
	all() {
		return this.entries;
	}
	/** Every row with its on/off state, for the card's model switches. */
	withVisibility() {
		return this.entries.map((entry) => ({
			...entry,
			on: !this.hidden.has(entry.id)
		}));
	}
	/** The ids currently switched off. */
	hiddenIds() {
		return [...this.hidden];
	}
	/** Whether the group is currently shown. */
	isVisible() {
		return this.visible;
	}
	/** Where the current roster came from. */
	source() {
		return this.rosterSource;
	}
	/**
	* Set visibility.
	* @returns whether the state actually changed.
	*/
	setVisible(visible) {
		if (this.visible === visible) return false;
		this.visible = visible;
		return true;
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
	setHidden(ids) {
		const next = new Set(ids.filter((id) => typeof id === "string" && id !== ""));
		if (next.size === this.hidden.size && [...next].every((id) => this.hidden.has(id))) return false;
		this.hidden = next;
		return true;
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
	hydrate(entries) {
		if (entries.length === 0) return false;
		if (entries.length === this.entries.length && entries.every((entry, index) => entry.id === this.entries[index]?.id && entry.name === this.entries[index]?.name) && this.rosterSource === "saved") return false;
		this.entries = entries.map((entry) => ({
			id: entry.id,
			name: entry.name
		}));
		this.rosterSource = "saved";
		return true;
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
	setModels(models, source = "cli") {
		if (models.length === 0) return false;
		const next = models.map((model) => ({
			id: model.externalId,
			name: model.cliModel
		}));
		const same = next.length === this.entries.length && next.every((entry, index) => entry.id === this.entries[index]?.id && entry.name === this.entries[index]?.name);
		const changed = !same || this.rosterSource !== source;
		this.rosterSource = source;
		if (same) return changed;
		this.entries = next;
		return true;
	}
};
//#endregion
//#region src/catalog-store.ts
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
/** Where the saved roster lives: `$DSH_HOME/qoder-connect/roster.json`. */
function qoderRosterPath() {
	return dshHomePath("qoder-connect", "roster.json");
}
/**
* Read the saved roster.
*
* Every failure mode — missing file, unreadable JSON, a foreign schema, an
* empty or malformed roster — answers `null` rather than throwing, because
* the caller's fallback (the built-in list) is a perfectly good answer and a
* corrupt cache must never cost the plugin its startup.
*/
async function loadQoderRoster() {
	try {
		const raw = await readFile(qoderRosterPath(), "utf8");
		const parsed = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null) return null;
		const document = parsed;
		if (document.version !== 1) return null;
		if (!Array.isArray(document.models) || document.models.length === 0) return null;
		const models = [];
		for (const entry of document.models) {
			if (typeof entry !== "object" || entry === null) return null;
			const row = entry;
			if (typeof row.id !== "string" || row.id === "") return null;
			if (typeof row.name !== "string" || row.name === "") return null;
			models.push({
				id: row.id,
				name: row.name
			});
		}
		return {
			version: 1,
			savedAt: typeof document.savedAt === "number" && Number.isFinite(document.savedAt) ? document.savedAt : 0,
			models
		};
	} catch {
		return null;
	}
}
/**
* Persist a live roster.
*
* Written through a temp file and a rename so a crash mid-write cannot leave
* a truncated document behind — the next read would otherwise discard the
* whole cache over a half-written line.
*
* Never throws: a failed write costs the next restart's tier, not this run.
*/
async function saveQoderRoster(models) {
	if (models.length === 0) return;
	try {
		const dir = dshHomePath("qoder-connect");
		await mkdir(dir, { recursive: true });
		const target = qoderRosterPath();
		const temporary = `${target}.${process.pid}.tmp`;
		const document = {
			version: 1,
			savedAt: Date.now(),
			models: [...models]
		};
		await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, "utf8");
		await rename(temporary, target);
	} catch {}
}
//#endregion
//#region src/model-catalog.ts
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
/** Magic prefix of a QMC v1 envelope. */
const QMC_MAGIC = "QMC";
/** HKDF inputs for the catalog key; fixed by the client's implementation. */
const QMC_HKDF_SALT = "qoder-model-cache-enc";
const QMC_HKDF_INFO = "model-cache-v1";
/**
* The scene whose model set this plugin serves.
*
* The document groups models by scene (`chat`, `developer`, `assistant`,
* `quest`, …). This plugin serves Chat Completions, so `chat` is the right
* set; the others describe surfaces with their own rosters.
*/
const CATALOG_SCENE = "chat";
/** The thinking levels pi-ai understands, which the effort map is keyed by. */
const PI_THINKING_LEVELS = [
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max"
];
/** Candidate per-user directories, in probe order. */
function catalogHomeCandidates(homeDir) {
	return [
		path.join(homeDir, ".qoder-cn"),
		path.join(homeDir, ".qoder"),
		path.join(homeDir, ".qoderworkcn")
	];
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
function decryptQmcCatalog(blob, uid) {
	const envelope = Buffer.from(blob.trim(), "base64");
	if (envelope.length < 32) throw new Error("QMC envelope too short");
	if (envelope.subarray(0, 4).toString("latin1") !== QMC_MAGIC) throw new Error("not a QMC v1 envelope");
	const nonce = envelope.subarray(4, 16);
	const sealed = envelope.subarray(16);
	const ciphertext = sealed.subarray(0, sealed.length - 16);
	const tag = sealed.subarray(sealed.length - 16);
	const key = Buffer.from(hkdfSync("sha256", Buffer.from(uid, "utf8"), Buffer.from(QMC_HKDF_SALT, "utf8"), Buffer.from(QMC_HKDF_INFO, "utf8"), 32));
	const decipher = createDecipheriv("aes-256-gcm", key, nonce);
	decipher.setAuthTag(tag);
	return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
/** Read a number, or null when the field is absent or not finite. */
function num(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}
/** Read a non-empty string, or null. */
function str(value) {
	return typeof value === "string" && value !== "" ? value : null;
}
/** Parse the promotion object, or null when absent or unusable. */
function parsePromotion(raw) {
	if (typeof raw !== "object" || raw === null) return null;
	const promo = raw;
	const discount = num(promo["discount_factor"]);
	if (discount === null || discount <= 0) return null;
	const badgeObj = promo["badge"];
	const badge = typeof badgeObj === "object" && badgeObj !== null ? str(badgeObj["zh"]) ?? str(badgeObj["en"]) : null;
	return {
		discountFactor: discount,
		windowStart: str(promo["window_start"]) ?? "",
		windowEnd: str(promo["window_end"]) ?? "",
		badge,
		timezone: str(promo["timezone"])
	};
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
function parseContext(raw) {
	const config = raw["context_config"];
	const windows = [];
	let preferred = null;
	if (typeof config === "object" && config !== null && !Array.isArray(config)) for (const entry of Object.values(config)) {
		if (typeof entry !== "object" || entry === null) continue;
		const record = entry;
		const count = num(record["token_count"]);
		if (count === null || count <= 0) continue;
		windows.push(count);
		if (record["is_default"] === true) preferred = count;
	}
	windows.sort((a, b) => a - b);
	const fallback = num(raw["max_input_tokens"]);
	return {
		contextWindow: preferred ?? (fallback !== null && fallback > 0 ? fallback : null),
		contextWindows: windows
	};
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
function parseThinking(raw) {
	const config = raw["thinking_config"];
	if (typeof config !== "object" || config === null) return {
		efforts: [],
		defaultEffort: null,
		canDisableThinking: false
	};
	const record = config;
	const canDisableThinking = typeof record["disabled"] === "object" && record["disabled"] !== null;
	const enabled = record["enabled"];
	if (typeof enabled !== "object" || enabled === null) return {
		efforts: [],
		defaultEffort: null,
		canDisableThinking
	};
	const rawEfforts = enabled["efforts"];
	if (typeof rawEfforts !== "object" || rawEfforts === null) return {
		efforts: [],
		defaultEffort: null,
		canDisableThinking
	};
	const efforts = [];
	let defaultEffort = null;
	for (const [level, value] of Object.entries(rawEfforts)) {
		if (!PI_THINKING_LEVELS.includes(level)) continue;
		efforts.push(level);
		if (typeof value === "object" && value !== null && value["is_default"] === true) defaultEffort = level;
	}
	return {
		efforts,
		defaultEffort,
		canDisableThinking
	};
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
function parseCatalogDocument(document) {
	const facts = /* @__PURE__ */ new Map();
	let parsed;
	try {
		parsed = JSON.parse(document);
	} catch {
		return facts;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return facts;
	const scene = parsed[CATALOG_SCENE];
	if (!Array.isArray(scene)) return facts;
	for (const entry of scene) {
		if (typeof entry !== "object" || entry === null) continue;
		const raw = entry;
		const displayName = str(raw["display_name"]);
		const key = str(raw["key"]);
		if (displayName === null || key === null) continue;
		const thinking = parseThinking(raw);
		const context = parseContext(raw);
		facts.set(displayName.toLowerCase(), {
			key,
			displayName,
			priceFactor: num(raw["price_factor"]),
			originalPriceFactor: num(raw["original_price_factor"]),
			free: raw["is_free"] === true,
			promotion: parsePromotion(raw["promotion"]),
			contextWindow: context.contextWindow,
			contextWindows: context.contextWindows,
			efforts: thinking.efforts,
			defaultEffort: thinking.defaultEffort,
			canDisableThinking: thinking.canDisableThinking,
			supportsImages: raw["is_vl"] === true
		});
	}
	return facts;
}
/** Read the account uid the catalog is keyed by, from the sibling `default` file. */
async function readUid(modelsDir) {
	try {
		return str(JSON.parse(await readFile(path.join(modelsDir, "default"), "utf8")).uid);
	} catch {
		return null;
	}
}
/**
* Locate the newest readable `catalog-v6` under a models directory.
*
* The directory is named by uid, and `default` names the active one; the uid
* is taken from the directory name (the key must match the container's) while
* `default` only decides which to prefer when several exist.
*/
async function findCatalogFile(modelsDir) {
	let dirs;
	try {
		dirs = await readdir(modelsDir);
	} catch {
		return null;
	}
	const preferredUid = await readUid(modelsDir);
	const candidates = [];
	for (const name of dirs) {
		const file = path.join(modelsDir, name, "catalog-v6");
		if (!existsSync(file)) continue;
		try {
			const info = await stat(file);
			candidates.push({
				file,
				uid: name,
				mtime: info.mtimeMs
			});
		} catch {}
	}
	if (candidates.length === 0) return null;
	const chosen = (preferredUid === null ? void 0 : candidates.find((c) => c.uid === preferredUid)) ?? candidates.sort((a, b) => b.mtime - a.mtime)[0];
	return chosen === void 0 ? null : {
		file: chosen.file,
		uid: chosen.uid
	};
}
/**
* Read, decrypt and parse the official catalog.
*
* Never throws: every failure — no client installed, no cache yet, a changed
* container format, a tampered file — answers `null`, and the caller keeps
* serving models without the extra facts.
*/
async function loadQoderModelFacts(options = {}) {
	const homeDir = options.homeDir ?? homedir();
	for (const home of catalogHomeCandidates(homeDir)) {
		const found = await findCatalogFile(path.join(home, ".models"));
		if (found === null) continue;
		try {
			const facts = parseCatalogDocument(decryptQmcCatalog(await readFile(found.file, "utf8"), found.uid));
			if (facts.size === 0) continue;
			return {
				facts,
				uid: found.uid,
				file: found.file
			};
		} catch {}
	}
	return null;
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
function thinkingLevelMapFor(facts) {
	if (facts === void 0 || facts.efforts.length === 0) return null;
	const map = {
		off: null,
		minimal: null
	};
	for (const level of PI_THINKING_LEVELS) map[level] = facts.efforts.includes(level) ? level : null;
	return map;
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
function formatQoderPrice(facts) {
	if (facts === void 0) return "";
	const parts = [];
	if (facts.priceFactor !== null) parts.push(`x${facts.priceFactor}`);
	if (facts.free && facts.priceFactor === 0) parts.push("限时免费");
	else if (facts.promotion !== null && facts.promotion.badge !== null) parts.push(facts.promotion.badge);
	return parts.length === 0 ? "" : ` · ${parts.join(" · ")}`;
}
//#endregion
//#region src/adapter.ts
/**
* The `qoder` pi-ai provider: one loopback-backed adapter registered into
* the Harness LLM seam, assembled from public `dsh-llm-pi-ai` extension
* points the way `dsh-workbuddy-connect` assembles its WorkBuddy route.
*
* @module dsh-qoder-connect/adapter
*/
/** Provider route this bundle owns. */
const QODER_PROVIDER = "qoder";
/** Provider idle ceiling while one stream read is outstanding. */
const QODER_STREAM_IDLE_TIMEOUT_MS = 3e5;
/**
* Conservative capacity defaults for the qoder catalog.
*
* The CLI publishes no context-window or output-capability facts through
* `--list-models` (it prints names only), so these are stated assumptions
* rather than upstream declarations: they size the model for the Harness
* without ever becoming per-request caps on their own. The official catalog
* replaces the window whenever it can be read.
*/
const QODER_CONTEXT_WINDOW = 262144;
const QODER_MAX_TOKENS = 32768;
/**
* Image-request budgets at the dsh-llm-pi-ai defaults; the profile type made
* them required in 0.1.1-rc.2. These bound what the host may hand a request:
* images the CLI cannot serve are refused before they reach the shim, and the
* shim re-checks the size itself before writing a temp file.
*/
const REQUEST_IMAGE_BUDGETS = {
	maxRequestImageBytes: 20971520,
	requestImagePixelBudget: 4194304,
	requestImageMaxBytes: 1048576
};
/**
* Inert pi-ai auth plane. The qoder route authenticates only through the
* shim shared secret resolved per request by `resolveApiKey`, so pi-ai's own
* credential lifecycle and ambient discovery must never manufacture a
* credential for it. `PiAiAdapterOptions.auth` is required since 0.1.1-rc.2;
* every ambient question here answers "nothing stored, nothing set".
*/
const INERT_AUTH = {
	credentials: {
		async read() {},
		async list() {
			return [];
		},
		async modify() {
			throw new Error("dsh-qoder-connect: the qoder route has no pi-ai credential lifecycle");
		},
		async delete() {}
	},
	authContext: {
		async env() {},
		async fileExists() {
			return false;
		}
	}
};
/** No per-token pricing is knowable for a subscription quota; report zero. */
const NO_COST = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0
};
/**
* The window one model is served at.
*
* `max` takes the largest window the catalog declares — the upstream serves
* it, the official client just does not pick it by default. It is only ever
* taken from the catalog's own list, never computed, because the CLI accepts
* an arbitrary `--context-window` without complaint and would otherwise be
* handed a number nothing backs.
*/
function contextWindowFor(facts, mode) {
	if (facts === void 0) return QODER_CONTEXT_WINDOW;
	if (mode === "max" && facts.contextWindows.length > 0) return facts.contextWindows[facts.contextWindows.length - 1];
	return facts.contextWindow ?? QODER_CONTEXT_WINDOW;
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
function toPiModel(externalId, cliModel, baseUrl, facts, windowMode) {
	const levelMap = thinkingLevelMapFor(facts);
	const input = facts?.supportsImages === true ? ["text", "image"] : ["text"];
	return {
		id: externalId,
		name: `${cliModel}${formatQoderPrice(facts)}`,
		api: "openai-completions",
		provider: QODER_PROVIDER,
		baseUrl,
		input: [...input],
		reasoning: levelMap !== null,
		...levelMap === null ? {} : { thinkingLevelMap: levelMap },
		cost: NO_COST,
		contextWindow: contextWindowFor(facts, windowMode),
		maxTokens: QODER_MAX_TOKENS,
		compat: {
			maxTokensField: "max_tokens",
			supportsReasoningEffort: levelMap !== null
		}
	};
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
function createQoderAdapter(options) {
	const { shim, catalog, resolveAttachments, modelFacts, contextWindowMode } = options;
	const buildModels = () => {
		const baseUrl = `${shim.baseUrl()}/v1`;
		const facts = modelFacts?.();
		const windowMode = contextWindowMode?.() ?? "default";
		return catalog.current().map((entry) => toPiModel(entry.id, entry.name, baseUrl, facts?.get(entry.name.toLowerCase()), windowMode));
	};
	const provider = {
		...createProvider({
			id: QODER_PROVIDER,
			name: "Qoder",
			auth: { apiKey: {
				name: "Qoder CLI login",
				async resolve({ credential }) {
					const apiKey = credential?.key;
					return apiKey === void 0 || apiKey.length === 0 ? void 0 : {
						auth: { apiKey },
						source: "Qoder"
					};
				}
			} },
			models: buildModels(),
			api: openAICompletionsApi()
		}),
		getModels: () => buildModels()
	};
	const profile = {
		provider: QODER_PROVIDER,
		displayName: "Qoder",
		streamIdleTimeoutMs: QODER_STREAM_IDLE_TIMEOUT_MS,
		retryPolicy: resolveRetryPolicy(void 0, "dsh-qoder-connect retryPolicy"),
		configuredMaxTokens: /* @__PURE__ */ new Map(),
		modelErrors: /* @__PURE__ */ new Map(),
		...REQUEST_IMAGE_BUDGETS,
		piProvider: provider
	};
	let profiles = /* @__PURE__ */ new Map([[QODER_PROVIDER, profile]]);
	return {
		adapter: new PiAiAdapter({
			profiles: () => profiles,
			auth: INERT_AUTH,
			resolveApiKey: async () => shim.token(),
			...resolveAttachments === void 0 ? {} : { resolveAttachments }
		}),
		invalidate: () => {
			profiles = /* @__PURE__ */ new Map([[QODER_PROVIDER, profile]]);
		}
	};
}
//#endregion
//#region src/ledger.ts
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
/** Where the ledger lives: `$DSH_HOME/qoder-credits/ledger.jsonl`. */
function qoderLedgerPath() {
	return dshHomePath("qoder-credits", "ledger.jsonl");
}
/**
* Serialized append chain.
*
* A chat stream finishes on its own timer, so two runs can settle at the
* same moment; `appendFile` with separate handles would interleave their
* writes on some platforms. One in-process promise chain keeps every line
* whole without a lock file.
*/
let appendChain = Promise.resolve();
/**
* Append one run to the ledger. Never throws: a failed write costs a data
* point, never the chat that produced it.
*
* @returns a promise that settles once the line is on disk (or the failure
*   is swallowed); callers may fire-and-forget.
*/
function appendQoderLedgerEntry(entry, onError) {
	const next = appendChain.then(async () => {
		try {
			const file = qoderLedgerPath();
			await mkdir(dshHomePath("qoder-credits"), { recursive: true });
			await appendFile(file, `${JSON.stringify(entry)}\n`, "utf8");
		} catch (error) {
			onError?.(error);
		}
	});
	appendChain = next.then(() => void 0, () => void 0);
	return next;
}
//#endregion
//#region src/loopback.ts
/**
* Shared loopback gates for the plugin's local HTTP surfaces: the loopback
* shim and the same-origin web-status route. Both are only ever meant to be
* addressed through the machine's loopback interface.
*
* @module dsh-qoder-connect/loopback
*/
/** Loopback hostnames a local plugin surface may be addressed by. */
const LOOPBACK_HOSTS = /* @__PURE__ */ new Set([
	"127.0.0.1",
	"localhost",
	"[::1]"
]);
/** Strip the optional :port from a Host header value, IPv6-bracket aware. */
function hostnameOfHost(host) {
	let hostname = host.trim().toLowerCase();
	if (hostname.startsWith("[")) {
		const end = hostname.indexOf("]");
		return end === -1 ? hostname : hostname.slice(0, end + 1);
	}
	const colon = hostname.lastIndexOf(":");
	if (colon !== -1 && !hostname.slice(0, colon).includes(":") && /^\d+$/.test(hostname.slice(colon + 1))) hostname = hostname.slice(0, colon);
	return hostname;
}
/**
* The request's Host header must name the loopback interface. A DNS-rebinding
* page (attacker domain re-resolved to 127.0.0.1) sends its own domain in
* Host, so this check drops those before any routing happens.
*/
function hostIsLoopback(host) {
	if (host === void 0 || host.trim() === "") return false;
	return LOOPBACK_HOSTS.has(hostnameOfHost(host));
}
/**
* A browser-sent Origin (present header) must be loopback. Non-browser
* clients (the plugin's own fetch calls) send no Origin at all and pass.
*/
function originIsLoopback(origin) {
	if (origin === void 0 || origin.trim() === "") return true;
	try {
		const { hostname } = new URL(origin);
		return LOOPBACK_HOSTS.has(hostname) || hostname === "::1";
	} catch {
		return false;
	}
}
//#endregion
//#region src/shim.ts
/**
* Loopback OpenAI-compatible endpoint. The pi-ai provider points here; the
* shim gates on qoder readiness, spawns the local `qoderclicn` CLI per
* request, and re-emits its stream-json output as OpenAI chunks. It binds
* 127.0.0.1 only and never serves another interface.
*
* Inbound hardening: the loopback bind alone is not a trust boundary (any
* local process or a DNS-rebinding page can reach 127.0.0.1), so every
* request must carry a loopback Host header, browser-sent Origins must be
* loopback, chat POSTs must be application/json, and the Authorization
* header must carry the shim's per-process shared secret. The plugin's own
* client satisfies all four by construction; local attackers cannot read
* the secret out of the plugin process's memory.
*
* @module dsh-qoder-connect/shim
*/
/** Normalize the qoder options, resolving a live thunk when one was given. */
function qoderOptionsOf(options) {
	const qoder = options.qoder;
	if (typeof qoder === "function") return qoder();
	return qoder ?? {};
}
const REQUEST_BODY_LIMIT = 67108864;
/** Chat-completion POSTs must carry a JSON body type. */
function isJsonContentType(req) {
	const type = req.headers["content-type"];
	return typeof type === "string" && type.trim().toLowerCase().startsWith("application/json");
}
function writeJson(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"Content-Type": "application/json",
		"Content-Length": Buffer.byteLength(payload)
	});
	res.end(payload);
}
function writeOpenAIError(res, status, kind, message) {
	writeJson(res, status, { error: {
		message,
		type: kind,
		code: kind
	} });
}
/** Read a request body with a size cap; over-limit bodies fail the request. */
function readBody(req) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > REQUEST_BODY_LIMIT) {
				reject(/* @__PURE__ */ new Error("request body too large"));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks)));
		req.on("error", reject);
	});
}
/**
* Start the loopback endpoint. Requests carry the per-process bearer; the
* loopback bind plus the secret are the boundary, and the qoder credential
* comes from the CLI's own on-disk state alone.
*/
function createQoderShim(options = {}) {
	const logger = options.logger;
	/** The qoder options for this moment; a thunk is re-read per request. */
	const qoderOptions = () => qoderOptionsOf(options);
	const SHARED_SECRET = randomBytes(32).toString("base64url");
	/** Constant-time bearer check; absent or mismatched bearers are rejected. */
	function bearerOk(req) {
		const header = req.headers.authorization;
		if (typeof header !== "string") return false;
		const match = /^Bearer\s+(.+)$/i.exec(header.trim());
		if (match === null) return false;
		const presented = match[1];
		const a = Buffer.from(presented);
		const b = Buffer.from(SHARED_SECRET);
		if (a.length !== b.length) return false;
		return timingSafeEqual(a, b);
	}
	const server = createServer((req, res) => {
		handle(req, res);
	});
	const ready = new Promise((resolve, reject) => {
		server.once("listening", () => resolve());
		server.once("error", reject);
	});
	server.listen(0, "127.0.0.1");
	const baseUrl = () => {
		const address = server.address();
		if (address === null || typeof address === "string") throw new Error("qoder shim has no listening address");
		return `http://127.0.0.1:${address.port}`;
	};
	async function handle(req, res) {
		try {
			if (!hostIsLoopback(req.headers.host)) {
				writeOpenAIError(res, 403, "host_not_allowed", "Host header must name the loopback interface");
				return;
			}
			if (!originIsLoopback(req.headers.origin)) {
				writeOpenAIError(res, 403, "origin_not_allowed", "Origin must be a loopback origin");
				return;
			}
			if (!bearerOk(req)) {
				writeOpenAIError(res, 401, "unauthorized", "missing or invalid Authorization bearer");
				return;
			}
			const url = req.url ?? "/";
			if (req.method === "GET" && (url === "/healthz" || url === "/healthz/")) {
				writeJson(res, 200, { ok: true });
				return;
			}
			if (req.method === "GET" && (url === "/v1/models" || url === "/v1/models/")) {
				const status = qoderStatus(qoderOptions());
				if (!status.ready) {
					writeOpenAIError(res, 401, "qoder_not_ready", status.reason);
					return;
				}
				writeJson(res, 200, {
					object: "list",
					data: QODER_MODELS.map(qoderModelListEntry)
				});
				return;
			}
			if (req.method === "POST" && (url === "/v1/chat/completions" || url === "/v1/chat/completions/")) {
				await chatCompletions(req, res);
				return;
			}
			writeOpenAIError(res, 404, "not_found", `no such route: ${req.method} ${url}`);
		} catch (error) {
			if (!res.headersSent) writeOpenAIError(res, 500, "internal", String(error));
			else res.end();
		}
	}
	async function chatCompletions(req, res) {
		if (!isJsonContentType(req)) {
			writeOpenAIError(res, 415, "unsupported_media_type", "Content-Type must be application/json");
			return;
		}
		const status = qoderStatus(qoderOptions());
		if (!status.ready) {
			writeOpenAIError(res, 401, "qoder_not_ready", status.reason);
			return;
		}
		const raw = (await readBody(req)).toString("utf8");
		let body;
		try {
			body = JSON.parse(raw);
		} catch {
			writeOpenAIError(res, 400, "invalid_json", "request body is not valid JSON");
			return;
		}
		const stream = body.stream === true;
		/** The DSH-facing model id, for the ledger row (the CLI name is per-run). */
		const externalModel = typeof body.model === "string" && body.model !== "" ? body.model : "qoder-auto";
		const promptChars = Array.isArray(body.messages) ? body.messages.reduce((sum, m) => sum + flattenContent(m?.content).length, 0) : 0;
		const controller = new AbortController();
		req.on("close", () => controller.abort(/* @__PURE__ */ new Error("client disconnected")));
		const timeoutMs = QODER_TIMEOUT_MS;
		const timeoutTimer = setTimeout(() => controller.abort(/* @__PURE__ */ new Error(`qoderclicn 超过 ${Math.round(timeoutMs / 1e3)}s 未结束`)), timeoutMs);
		if (typeof timeoutTimer.unref === "function") timeoutTimer.unref();
		try {
			if (stream) res.writeHead(200, {
				"Content-Type": "text/event-stream; charset=utf-8",
				"Cache-Control": "no-cache",
				Connection: "keep-alive"
			});
			const chunks = [];
			for await (const chunk of qoderChatStream(body, {
				...qoderOptions(),
				signal: controller.signal,
				timeoutMs,
				onRunComplete: (result, cliModel) => {
					appendQoderLedgerEntry({
						ts: Date.now(),
						model: externalModel,
						cli: cliModel,
						credits: result.credits,
						ms: result.ms,
						turns: result.turns,
						chars: promptChars,
						error: result.isError
					}, (error) => {
						logger?.warn("dsh-qoder-connect: usage ledger append failed", error);
					});
				}
			})) {
				if (controller.signal.aborted && !stream) break;
				if (stream) {
					if (res.writableEnded) break;
					res.write(`data: ${JSON.stringify(chunk)}\n\n`);
				} else chunks.push(chunk);
			}
			if (controller.signal.aborted) return;
			if (stream) {
				if (!res.writableEnded) {
					res.write("data: [DONE]\n\n");
					res.end();
				}
				return;
			}
			writeJson(res, 200, aggregateQoderChunks(chunks, body));
		} catch (error) {
			const message = error instanceof Error ? error.message.slice(0, 400) : String(error).slice(0, 400);
			logger?.warn("dsh-qoder-connect: qoder proxy error", error);
			if (controller.signal.aborted) return;
			if (stream) {
				if (!res.writableEnded) {
					res.write(`data: ${JSON.stringify({ error: {
						message,
						type: "qoder_upstream_failed"
					} })}\n\n`);
					res.end();
				}
				return;
			}
			writeOpenAIError(res, 502, "qoder_upstream_failed", message);
		} finally {
			clearTimeout(timeoutTimer);
		}
	}
	return {
		ready,
		baseUrl,
		token: () => SHARED_SECRET,
		close: () => new Promise((resolve, reject) => {
			server.close(() => resolve());
			server.closeAllConnections();
			server.once("error", reject);
		})
	};
}
//#endregion
//#region src/status-paths.ts
/**
* Node-free constants and types shared by the Host and browser halves.
*
* @module dsh-qoder-connect/status-paths
*/
/** Plugin-owned status endpoint consumed by its browser half. */
const QODER_STATUS_PATH = "/plugins/dsh-qoder-connect/status";
/**
* Same-origin write endpoint for the reasoning controls. The card's settings
* page owns editing; this exists so the controls live on the plugin's own
* card rather than the generic settings form.
*/
const QODER_CONFIG_PATH = "/plugins/dsh-qoder-connect/config";
//#endregion
//#region src/web-status.ts
function json(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"Content-Type": "application/json",
		"Content-Length": Buffer.byteLength(payload)
	});
	res.end(payload);
}
/**
* The reasoning controls as the card renders them: the live options plus the
* vocabularies the CLI accepts, so the UI never offers a level the CLI would
* reject outright.
*/
function qoderWebReasoning(qoder = {}) {
	return {
		effort: qoder.reasoningEffort ?? "",
		thinking: qoder.thinking ?? "",
		budget: qoder.thinkingBudget ?? 0
	};
}
/**
* The context-window switch as the card renders it.
*
* Read off the live options rather than from a stored setting, so the card
* shows what is actually in effect for the next request — including a value
* edited elsewhere while the card was open.
*/
function qoderWebContextWindow(qoder = {}) {
	return { max: qoder.contextWindowMax === true };
}
/**
* The request must be addressed to the loopback interface, and a
* browser-attached Origin must be loopback too. The Host check drops
* DNS-rebinding pages (their Host is the attacker's domain, not loopback);
* the card's same-origin fetches carry no Origin and pass on Host alone.
*/
function loopbackRequest(req) {
	return hostIsLoopback(req.headers.host) && originIsLoopback(req.headers.origin);
}
/**
* Assemble the card's status document. Readiness is read-only; nothing here
* contacts the network — the CLI probe is a local `--version` spawn.
*/
function qoderWebStatus(deps) {
	const status = qoderStatus(deps.qoder);
	const models = deps.catalog.current().map((entry) => ({
		id: entry.id,
		name: entry.name
	}));
	const switches = deps.catalog.withVisibility().map((entry) => ({
		id: entry.id,
		name: entry.name,
		on: entry.on
	}));
	const reasoning = qoderWebReasoning(deps.qoder);
	const contextWindow = qoderWebContextWindow(deps.qoder);
	const rosterSource = deps.catalog.source();
	if (!status.ready) return {
		status: "not-ready",
		reason: status.reason,
		...status.cli === null ? {} : { cli: status.cli },
		oauth: status.oauth,
		pat: status.pat,
		oauthFile: status.oauthFile,
		reasoning,
		contextWindow,
		switches,
		rosterSource
	};
	return {
		status: "ready",
		cli: status.cli ?? "qoderclicn",
		source: status.oauth ? "oauth" : "pat",
		oauthFile: status.oauthFile,
		reason: status.reason,
		models,
		switches,
		reasoning,
		contextWindow,
		rosterSource
	};
}
/** The status route's request handler, extracted so tests can mount it on a bare server. */
function qoderStatusHandler(deps) {
	return async (req, res) => {
		if (req.method !== "GET") {
			json(res, 405, { error: "method not allowed" });
			return;
		}
		if (!loopbackRequest(req)) {
			json(res, 403, { error: "request-not-trusted" });
			return;
		}
		try {
			json(res, 200, qoderWebStatus(deps));
		} catch (error) {
			json(res, 500, { error: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500) });
		}
	};
}
/** Mount the GET status route on an optional webServer context. */
function registerQoderStatusRoute(ctx, deps) {
	ctx.effect(() => {
		const dispose = ctx.webServer.register({
			kind: "exact",
			path: QODER_STATUS_PATH,
			handler: qoderStatusHandler(deps)
		});
		return () => {
			dispose();
		};
	}, "dsh-qoder-connect: Web status route");
}
/** Body ceiling for the config write route: three small scalars. */
const CONFIG_BODY_LIMIT = 4096;
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
function parseQoderConfigPatch(body) {
	if (typeof body !== "object" || body === null || Array.isArray(body)) return { error: "body must be a JSON object" };
	const raw = body;
	const patch = {};
	if ("reasoningEffort" in raw) {
		const value = raw.reasoningEffort;
		if (value === "" || value === null) patch.reasoningEffort = "";
		else if (typeof value === "string" && QODER_REASONING_EFFORTS.includes(value)) patch.reasoningEffort = value;
		else return { error: `reasoningEffort must be one of: ${QODER_REASONING_EFFORTS.join(", ")} (or "" to clear)` };
	}
	if ("thinking" in raw) {
		const value = raw.thinking;
		if (value === "" || value === null) patch.thinking = "";
		else if (typeof value === "string" && QODER_THINKING_MODES.includes(value)) patch.thinking = value;
		else return { error: `thinking must be one of: ${QODER_THINKING_MODES.join(", ")} (or "" to clear)` };
	}
	if ("thinkingBudget" in raw) {
		const value = raw.thinkingBudget;
		if (value === null) patch.thinkingBudget = 0;
		else if (typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0 && value <= 1e6) patch.thinkingBudget = value;
		else return { error: `thinkingBudget must be an integer between 0 and ${QODER_MAX_THINKING_BUDGET}` };
	}
	if ("contextWindowMax" in raw) {
		const value = raw.contextWindowMax;
		if (typeof value !== "boolean") return { error: "contextWindowMax must be a boolean" };
		patch.contextWindowMax = value;
	}
	if ("hiddenModels" in raw) {
		const value = raw.hiddenModels;
		if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) return { error: "hiddenModels must be an array of model id strings" };
		patch.hiddenModels = [...new Set(value)];
	}
	return { patch };
}
/**
* Backwards-compatible alias for {@link parseQoderConfigPatch}.
*
* The route outgrew its original name when the context-window switch joined
* the reasoning controls, but the reasoning spelling is what the existing
* call sites and tests use, so it stays available.
*/
const parseReasoningPatch = parseQoderConfigPatch;
/** Read a request body with a size cap. */
async function readJsonBody(req) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		const buffer = chunk;
		size += buffer.length;
		if (size > CONFIG_BODY_LIMIT) throw new Error("request body too large");
		chunks.push(buffer);
	}
	return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
/**
* The write route's handler: validate the patch, then merge it into the
* plugin's own settings namespace so the change is durable and reaches the
* live config thunk through the section's `onChange`.
*/
function qoderConfigHandler(deps) {
	return async (req, res) => {
		if (req.method !== "POST") {
			json(res, 405, { error: "method not allowed" });
			return;
		}
		if (!loopbackRequest(req)) {
			json(res, 403, { error: "request-not-trusted" });
			return;
		}
		let body;
		try {
			body = await readJsonBody(req);
		} catch (error) {
			json(res, 400, { error: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300) });
			return;
		}
		if (typeof body === "object" && body !== null && body.action === "refreshModels") {
			if (deps.refreshModels === void 0) {
				json(res, 501, { error: "model refresh is not available in this profile" });
				return;
			}
			try {
				await deps.refreshModels();
				json(res, 200, {
					ok: true,
					models: deps.catalog.all(),
					rosterSource: deps.catalog.source(),
					factsCount: deps.factsCount?.() ?? 0
				});
			} catch (error) {
				json(res, 500, { error: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300) });
			}
			return;
		}
		const ns = deps.settingsNs;
		if (ns === void 0 || deps.settings === void 0) {
			json(res, 501, { error: "settings are not available in this profile" });
			return;
		}
		try {
			const provider = await deps.settings();
			if (provider === void 0) {
				json(res, 501, { error: "settings are not available in this profile" });
				return;
			}
			const parsed = parseQoderConfigPatch(body);
			if ("error" in parsed) {
				json(res, 400, { error: parsed.error });
				return;
			}
			const ops = Object.entries(parsed.patch).map(([key, value]) => value === "" ? {
				op: "unset",
				path: [key]
			} : {
				op: "set",
				path: [key],
				value
			});
			await provider.mutate(ns, ops);
			deps.onSettingsChanged?.();
			json(res, 200, {
				ok: true,
				reasoning: qoderWebReasoning(deps.qoder)
			});
		} catch (error) {
			json(res, 400, { error: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300) });
		}
	};
}
/** Mount both the read and write routes; the write route is best-effort. */
function registerQoderRoutes(ctx, deps) {
	registerQoderStatusRoute(ctx, deps);
	ctx.effect(() => {
		const dispose = ctx.webServer.register({
			kind: "exact",
			path: QODER_CONFIG_PATH,
			handler: qoderConfigHandler(deps)
		});
		return () => {
			dispose();
		};
	}, "dsh-qoder-connect: Web config route");
}
//#endregion
//#region src/index.ts
/** Stable Cordis plugin name. */
const name = "llm-qoder";
/** The model registry required before the provider can register. */
const inject = ["llm"];
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
const QODER_SETTINGS_NS = "dsh-qoder-connect";
/**
* How often readiness is re-checked, in milliseconds.
*
* A startup-only readiness check cannot notice a `qoderclicn login` that
* happens while DSH is already running, so the model group would not appear
* until a restart. This poll is cheap: an existence read of at most a few
* local files plus a cached CLI probe (`--version` at most once a minute).
* It never sends a chat request.
*
* `DSH_QODER_POLL_MS` overrides it. That exists so the sweep can be
* exercised end to end in tests and shortened while diagnosing a slow
* sign-in on a real machine; it is not a product setting and no UI exposes
* it. The value is clamped to a sane range so a mistaken override cannot
* turn the poll into a busy loop.
*/
const READINESS_POLL_MS = 3e4;
/**
* Floor and ceiling for the overridable readiness poll interval.
*/
const MIN_POLL_MS = 100;
const MAX_POLL_MS = 864e5;
/** Resolve the sweep interval, honoring the override when it is usable. */
function readinessPollMs() {
	const override = Number(process.env["DSH_QODER_POLL_MS"]);
	if (!Number.isFinite(override) || override < MIN_POLL_MS) return READINESS_POLL_MS;
	return Math.min(override, MAX_POLL_MS);
}
/** Explicit CLI override (shared by the plugin schema and its section). */
const CLI_FIELD = z.string().volatile().description("Qoder CLI command or path (defaults to QODERCN_CLI, then qoderclicn)");
/**
* Reasoning-effort selector. The union keeps the settings file honest: an
* unknown level can never be persisted, which matters because the CLI exits
* fatally on one instead of ignoring it.
*/
const REASONING_EFFORT_FIELD = z.union(QODER_REASONING_EFFORTS).volatile().description("Reasoning effort (--reasoning-effort); empty uses the CLI default");
/** Thinking-mode selector; same reasoning as the effort field. */
const THINKING_FIELD = z.union(QODER_THINKING_MODES).volatile().description("Thinking mode (--thinking); empty uses the CLI default");
/** Thinking-token budget; 0 or absent omits `--thinking-budget`. */
const THINKING_BUDGET_FIELD = z.number().volatile().description("Fixed thinking token budget (--thinking-budget); 0 uses the CLI default");
/**
* Context-window switch. A boolean rather than a number on purpose: the
* number is a per-model fact from the official catalog, so persisting one
* here would freeze a value that goes stale the moment Qoder re-declares it.
*/
const CONTEXT_WINDOW_MAX_FIELD = z.boolean().volatile().description("Serve models at the largest context window the official catalog declares (--context-window)");
/**
* Switched-off model ids. An array rather than a per-model map so the card can
* write the whole set at once — a batch "hide all" is one request, not N.
*/
const HIDDEN_MODELS_FIELD = z.array(z.string()).volatile().description("Model ids to hide from the model picker");
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
const Config = z.object({
	cli: CLI_FIELD,
	reasoningEffort: REASONING_EFFORT_FIELD,
	thinking: THINKING_FIELD,
	thinkingBudget: THINKING_BUDGET_FIELD,
	contextWindowMax: CONTEXT_WINDOW_MAX_FIELD,
	hiddenModels: HIDDEN_MODELS_FIELD
});
/**
* Read one config field, unwrapping a `Volatile` ref when there is one.
*
* The shape check rather than a version check on purpose: a host running an
* older schemastery hands the field through as a plain value, and this plugin
* still has to work there. Only a `get` method is treated as a ref, so a
* string, a number, a boolean and an array all pass through untouched.
*/
function readField(value) {
	if (value === void 0) return void 0;
	if (typeof value.get === "function") return value.get();
	return value;
}
/**
* Read the live config, with volatile refs resolved to their current values.
*
* Every consumer of the plugin's settings goes through here. Reading a ref
* each time is what makes an edit on the card visible to the next chat run
* without a restart: the loader swaps the ref's contents in place and emits
* `loader/volatile-update`, so a snapshot taken once at startup would freeze
* the value this function exists to keep current.
*/
function readConfig(config) {
	return {
		cli: readField(config.cli),
		reasoningEffort: readField(config.reasoningEffort),
		thinking: readField(config.thinking),
		thinkingBudget: readField(config.thinkingBudget),
		contextWindowMax: readField(config.contextWindowMax),
		hiddenModels: readField(config.hiddenModels)
	};
}
/**
* Resolve the explicit `--context-window` for one CLI model name.
*
* Reads the same official-catalog snapshot the adapter reports from, so the
* window on the wire and the window in the picker are always the same number.
* Undefined — the default mode, or a model the catalog does not describe —
* omits the flag and leaves the CLI's own configured window alone.
*/
function contextWindowResolver(mode, facts) {
	return (cliModel) => {
		if (mode !== "max") return void 0;
		const windows = facts().get(cliModel.toLowerCase())?.contextWindows;
		if (windows === void 0 || windows.length === 0) return void 0;
		return windows[windows.length - 1];
	};
}
/** Effective qoder CLI options for one config snapshot. */
function qoderOptionsFor(config, resolveContextWindow) {
	const options = {};
	if (config.cli !== void 0 && config.cli !== "") options.command = config.cli;
	if (config.reasoningEffort !== void 0) options.reasoningEffort = config.reasoningEffort;
	if (config.thinking !== void 0) options.thinking = config.thinking;
	if (typeof config.thinkingBudget === "number" && config.thinkingBudget > 0) options.thinkingBudget = config.thinkingBudget;
	if (config.contextWindowMax === true) {
		options.contextWindowMax = true;
		if (resolveContextWindow !== void 0) options.resolveContextWindow = resolveContextWindow;
	}
	return options;
}
/**
* Start the plugin: its loopback endpoint, provider registration, and
* configuration-card wiring.
*
* Registration waits for the shim to hold a port, because the provider's
* models read the shim origin at construction time.
*
* @returns whether the provider registered.
*/
async function start(ctx, config) {
	const shim = createQoderShim({
		qoder: () => qoderOptionsFor(current(), resolveContextWindow),
		logger: ctx.logger
	});
	try {
		await shim.ready;
	} catch (error) {
		ctx.logger.error("dsh-qoder-connect: loopback endpoint failed to start", error);
		return false;
	}
	const catalog = new QoderCatalog();
	const initialHidden = readField(config.hiddenModels);
	if (Array.isArray(initialHidden) && catalog.setHidden(initialHidden)) {}
	/**
	* Live configuration source.
	*
	* Reads through {@link readConfig} on every call rather than holding a
	* snapshot, so a volatile edit committed by the loader is visible to the
	* next chat run without a restart. This replaces the section-source
	* indirection the removed `installSection` API provided: there is no
	* separate source to swap in, the applied config *is* the live one.
	*/
	const current = () => readConfig(config);
	let releaseAdapter;
	let releaseDirectory;
	let sweep = () => {};
	let invalidate = () => {};
	/**
	* The official catalog's facts, read synchronously by the adapter.
	*
	* Held here rather than read inside `buildModels` because model listing is
	* synchronous while decrypting the container is I/O, so the host refreshes
	* this in the background and the adapter only reads the last snapshot.
	*/
	let modelFacts = /* @__PURE__ */ new Map();
	/** Which context window the models are served at, read live per request. */
	const contextWindowMode = () => current().contextWindowMax === true ? "max" : "default";
	/**
	* The explicit `--context-window` for one CLI model name, or undefined to
	* omit the flag. Resolved from the same facts snapshot the adapter reports
	* from, so the wire value and the picker's number cannot drift apart.
	*/
	const resolveContextWindow = contextWindowResolver(contextWindowMode(), () => modelFacts);
	try {
		const qoder = createQoderAdapter({
			shim,
			catalog,
			resolveAttachments: () => ctx.get("attachments"),
			modelFacts: () => modelFacts,
			contextWindowMode
		});
		invalidate = () => {
			qoder.invalidate();
			ctx.emit("llm/adapters-updated");
		};
		try {
			releaseAdapter = ctx.llm.registerAdapter([QODER_PROVIDER], qoder.adapter);
			releaseDirectory = ctx.llm.registerConfigurableProviders([{
				provider: QODER_PROVIDER,
				displayName: "Qoder",
				settingsNs: QODER_SETTINGS_NS,
				settingsPath: [],
				declared: false
			}]);
		} finally {
			if (releaseAdapter === void 0 || releaseDirectory === void 0) {
				releaseAdapter?.();
				releaseDirectory?.();
			}
		}
		try {
			ctx.effect(() => () => {
				releaseAdapter?.();
				releaseDirectory?.();
				shim.close();
			});
		} catch {
			releaseAdapter?.();
			releaseDirectory?.();
			shim.close();
		}
		/**
		* Reconcile the catalog's visibility with readiness.
		*
		* Only a *change* republishes: an unchanged answer must not rebuild the
		* adapter snapshot on every sweep, or a steady-state machine would
		* churn the model directory every 30 seconds for no new information.
		*
		* The sweep is deliberately NOT where the roster or the official catalog
		* is read. Both are read only at startup and on the card's explicit
		* refresh, so a running DSH is never busy-worked by either — and the
		* sweep stays a cheap local check that never spawns the CLI. A sweep that
		* becomes ready reveals the group; the roster then shows the built-in
		* fallback until the refresh button is pressed (which is the one place
		* both are re-read together).
		*/
		sweep = () => {
			const ready = qoderStatus(qoderOptionsFor(current())).ready;
			if (catalog.setVisible(ready)) invalidate();
		};
	} catch (error) {
		ctx.logger.error("dsh-qoder-connect: provider registration failed", error);
		shim.close();
		return false;
	}
	/**
	* Ask the CLI for its current roster and publish any change.
	*
	* Serialized so two triggers (startup and a readiness flip) cannot spawn
	* the CLI twice at once, and best-effort: a failure leaves the previous
	* roster in place rather than emptying the group.
	*
	* A live answer is also persisted, which is what keeps the *next* run from
	* degrading to the built-in snapshot while it waits for this one.
	*/
	let refreshing;
	const refreshModels = () => {
		refreshing ??= (async () => {
			try {
				const models = await fetchQoderModels(qoderOptionsFor(current()));
				if (models === null) {
					ctx.logger.warn("dsh-qoder-connect: could not list models from the CLI; keeping the current roster");
					return;
				}
				await saveQoderRoster(models.map((model) => ({
					id: model.externalId,
					name: model.cliModel
				})));
				if (catalog.setModels(models, "cli")) {
					invalidate();
					ctx.logger.info(`dsh-qoder-connect: model roster refreshed from the CLI (${models.length} models)`);
				}
			} catch (error) {
				ctx.logger.warn("dsh-qoder-connect: model roster refresh failed", error);
			} finally {
				refreshing = void 0;
			}
		})();
		return refreshing;
	};
	/**
	* Re-read everything the picker shows: the CLI's roster and the official
	* catalog's price, thinking levels and context windows.
	*
	* This is the one explicit refresh path — startup and the card's refresh
	* button both come through here. There is no timer on either half: the
	* roster costs a CLI spawn, and the catalog's file is written by the
	* official client, so polling it would only ever report a snapshot the
	* client has already decided to publish. Both halves are best-effort and
	* independent: a failure in one leaves the other's data in place.
	*/
	const refreshAll = async () => {
		await refreshModels();
		await refreshModelFacts();
	};
	/**
	* Re-read the official catalog's per-model facts.
	*
	* Only a real change republishes: `llm/adapters-updated` churns the model
	* directory, so a refresh that changed nothing must stay silent.
	*/
	const refreshModelFacts = async () => {
		try {
			const snapshot = await loadQoderModelFacts();
			const next = snapshot?.facts ?? /* @__PURE__ */ new Map();
			if (next.size === modelFacts.size && [...next].every(([name, fact]) => JSON.stringify(fact) === JSON.stringify(modelFacts.get(name)))) return;
			modelFacts = next;
			invalidate();
			if (next.size > 0) ctx.logger.info(`dsh-qoder-connect: official model catalog loaded (${next.size} models from ${snapshot?.file ?? "unknown"})`);
		} catch (error) {
			ctx.logger.warn("dsh-qoder-connect: official catalog refresh failed", error);
		}
	};
	sweep();
	const timer = setInterval(sweep, readinessPollMs());
	timer.unref?.();
	(async () => {
		const saved = await loadQoderRoster();
		if (saved !== null && catalog.hydrate(saved.models)) {
			invalidate();
			ctx.logger.info(`dsh-qoder-connect: serving the roster saved at ${new Date(saved.savedAt).toISOString()} (${saved.models.length} models)`);
		}
		await refreshAll();
	})();
	/**
	* React to a save made on the card.
	*
	* Invoked by the config route once the host has accepted a write, which is
	* the plugin's own notification path — the loader does emit
	* `loader/volatile-update` afterwards, but that name is internal to the
	* loader package and is not part of the typed event surface, so relying on
	* it would couple this plugin to an implementation detail.
	*
	* The sweep's timer would eventually re-check readiness, but a
	* context-window switch or a model toggle changes what the picker serves
	* and has to republish the adapter snapshot at once, or the picker keeps
	* showing the window and roster that were in effect before the save.
	*
	* Declared before the route that calls it: the route is registered from an
	* `inject` callback whose body only runs later, but a `const` in the same
	* scope is still in its temporal dead zone until this line executes.
	*/
	const onSettingsChanged = () => {
		clearQoderCliCache();
		if (catalog.setHidden(current().hiddenModels ?? [])) invalidate();
		invalidate();
		sweep();
	};
	ctx.inject(["webServer"], (webCtx) => {
		registerQoderRoutes(webCtx, {
			catalog,
			settingsNs: QODER_SETTINGS_NS,
			settings: async () => webCtx.get("settings"),
			refreshModels: refreshAll,
			factsCount: () => modelFacts.size,
			onSettingsChanged,
			get qoder() {
				return qoderOptionsFor(current());
			}
		});
	});
	ctx.inject(["settings"], (settingsCtx) => {
		settingsCtx.effect(() => settingsCtx.settings.configure({ auto: false }, ctx.fiber), "dsh-qoder-connect: settings page policy");
	});
	ctx.effect(() => () => {
		clearInterval(timer);
	});
	return true;
}
function apply(ctx, config) {
	start(ctx, config).then((registered) => {
		if (!registered) ctx.logger.warn("dsh-qoder-connect: the qoder provider is unavailable in this profile");
	});
}
//#endregion
export { Config, QODER_CONFIG_PATH, QODER_CONNECT_VERSION, QODER_DEFAULT_MODEL, QODER_MAX_THINKING_BUDGET, QODER_MODELS, QODER_PROVIDER, QODER_REASONING_EFFORTS, QODER_SETTINGS_NS, QODER_STATUS_PATH, QODER_STREAM_IDLE_TIMEOUT_MS, QODER_THINKING_MODES, QODER_TIMEOUT_MS, QoderCatalog, aggregateQoderChunks, appendQoderLedgerEntry, apply, buildCliPrompt, buildReasoningArgs, clearQoderCliCache, cliModelFor, createQoderAdapter, createQoderShim, decryptQmcCatalog, disposeImageAttachments, fetchQoderModels, formatQoderPrice, inject, loadQoderModelFacts, loadQoderRoster, materializeImageAttachments, name, parseCatalogDocument, parseCliDelta, parseCliResult, parseListModelsOutput, parseQoderConfigPatch, parseReasoningPatch, qoderChatStream, qoderConfigHandler, qoderExternalId, qoderLedgerPath, qoderOauthUserCandidates, qoderOauthUserPath, qoderRosterPath, qoderStatus, qoderWebContextWindow, qoderWebReasoning, qoderWebStatus, registerQoderRoutes, registerQoderStatusRoute, saveQoderRoster, thinkingLevelMapFor };
