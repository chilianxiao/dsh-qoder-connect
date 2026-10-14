import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
//#region src/qoder.ts
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
const QODER_MODELS = [
	{
		externalId: "qoder-auto",
		cliModel: "Auto"
	},
	{
		externalId: "qoder-qwen3.8-max",
		cliModel: "Qwen3.8-Max"
	},
	{
		externalId: "qoder-qwen3.8-flash",
		cliModel: "Qwen3.8-Flash"
	},
	{
		externalId: "qoder-qwen3.7-max",
		cliModel: "Qwen3.7-Max"
	},
	{
		externalId: "qoder-qwen3.7-plus",
		cliModel: "Qwen3.7-Plus"
	},
	{
		externalId: "qoder-qwen3.7-flash",
		cliModel: "Qwen3.7-Flash"
	},
	{
		externalId: "qoder-deepseek-v4-pro",
		cliModel: "DeepSeek-V4-Pro"
	},
	{
		externalId: "qoder-deepseek-flash",
		cliModel: "DeepSeek-Flash"
	},
	{
		externalId: "qoder-glm-5.3",
		cliModel: "GLM-5.3"
	},
	{
		externalId: "qoder-glm-5.3-flash",
		cliModel: "GLM-5.3-Flash"
	},
	{
		externalId: "qoder-glm-5.2",
		cliModel: "GLM-5.2"
	},
	{
		externalId: "qoder-kimi-k3",
		cliModel: "Kimi-K3"
	},
	{
		externalId: "qoder-kimi-k2.8-preview",
		cliModel: "Kimi-K2.8-Preview"
	},
	{
		externalId: "qoder-minimax-m2.7",
		cliModel: "MiniMax-M2.7"
	}
];
/**
* The DSH-facing model id for one CLI spelling.
*
* Every id in {@link QODER_MODELS} is `qoder-` plus the lowercased CLI name,
* so a model the CLI adds later gets a stable, predictable id without a code
* change — and ids recorded in the usage ledger keep resolving. Names are
* already unique case-insensitively, which the fetch path relies on.
*/
function qoderExternalId(cliModel) {
	return `qoder-${cliModel.trim().toLowerCase()}`;
}
/** Default model when a request body omits one. */
const QODER_DEFAULT_MODEL = "Qwen3.7-Max";
/**
* Reasoning-effort levels `--reasoning-effort` accepts, in the CLI's own
* order. Verified against CLI 1.1.59: any other value makes the CLI exit
* before the request is served ("Invalid reasoning effort: ...").
*/
const QODER_REASONING_EFFORTS = [
	"auto",
	"none",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
	"ultracode"
];
/** Thinking modes `--thinking` accepts; verified against CLI 1.1.59. */
const QODER_THINKING_MODES = [
	"auto",
	"adaptive",
	"enabled",
	"disabled"
];
/** Ceiling on `--thinking-budget`, matching the CLI's own usable range. */
const QODER_MAX_THINKING_BUDGET = 1e6;
/** Overall ceiling for one CLI run, in milliseconds. */
const QODER_TIMEOUT_MS = 6e5;
/** How long a resolved CLI path is reused before it is probed again. */
const CLI_RESOLVE_TTL_MS = 6e4;
/**
* Candidate OAuth-state files left by `qoderclicn login`, in probe order.
* The contents are an encrypted blob — only existence is checked here; the
* CLI itself reads and decrypts it.
*/
function qoderOauthUserCandidates(homeDir = homedir()) {
	return [
		path.join(homeDir, ".qoderworkcn", ".auth-cn", "user"),
		path.join(homeDir, ".qoder-cn", ".auth", "user"),
		path.join(homeDir, ".qoder", ".auth", "user")
	];
}
/** First existing candidate, or the documented default when none exists. */
function qoderOauthUserPath(options = {}) {
	const candidates = qoderOauthUserCandidates(options.homeDir ?? homedir());
	return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}
function hasOauthLogin(options) {
	return qoderOauthUserCandidates(options.homeDir ?? homedir()).some((candidate) => existsSync(candidate));
}
function commandOf(options) {
	return options.command ?? process.env.QODERCN_CLI ?? "qoderclicn";
}
function prefixArgsOf(options) {
	return options.prefixArgs ?? [];
}
function homeDirOf(options) {
	return options.homeDir ?? homedir();
}
function patOf(options) {
	if (typeof options.pat === "string" && options.pat !== "") return options.pat;
	const fromEnv = process.env.QODERCN_PERSONAL_ACCESS_TOKEN;
	return fromEnv === void 0 || fromEnv === "" ? void 0 : fromEnv;
}
/**
* On Windows a global npm CLI is usually a .cmd shim, and Node refuses to
* spawn .cmd/.bat directly (EINVAL since the CVE-2024-27980 fix). Passing
* argv to cmd.exe does not work either: Node escapes inner quotes as \",
* which cmd.exe does not understand. The form that does work is a single
* fully-quoted command line run through shell:true — every token quoted, so
* prompt text containing & | > < stays literal inside the quotes.
*/
function cliSuffixes() {
	return process.platform === "win32" ? [
		"",
		".cmd",
		".exe",
		".bat"
	] : [""];
}
function isCmdShim(candidate) {
	return process.platform === "win32" && /\.(cmd|bat)$/i.test(candidate);
}
/**
* Well-known install locations for the default command names, used when the
* CLI is not on PATH (the Qoder installer puts it under ~/.qoder-cn/bin/...).
* An explicit QODERCN_CLI path is never second-guessed.
*/
function defaultInstallCandidates(command, homeDir) {
	if (command.includes("/") || command.includes("\\")) return [];
	return ({
		qoderclicn: [path.join(homeDir, ".qoder-cn", "bin", "qoderclicn")],
		qodercli: [path.join(homeDir, ".qoder", "bin", "qodercli")]
	}[command.toLowerCase()] ?? []).flatMap((dir) => cliSuffixes().map((suffix) => path.join(dir, `${command}${suffix}`)));
}
/** Quote one command line for cmd.exe: every token in double quotes, inner quotes doubled. */
function quoteCmdLine(command, args) {
	return [command, ...args].map((token) => `"${String(token).replace(/"/g, "\"\"")}"`).join(" ");
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
function resolveCli(command, prefixArgs, homeDir) {
	const groups = [cliSuffixes().map((suffix) => `${command}${suffix}`), defaultInstallCandidates(command, homeDir)];
	for (const candidates of groups) {
		for (const candidate of candidates) {
			if (isCmdShim(candidate)) continue;
			if (spawnSync(candidate, [...prefixArgs, "--version"], {
				windowsHide: true,
				timeout: 15e3
			}).error === void 0) return {
				command: candidate,
				viaCmd: false
			};
		}
		for (const candidate of candidates) {
			if (!isCmdShim(candidate)) continue;
			const probe = spawnSync(quoteCmdLine(candidate, [...prefixArgs, "--version"]), {
				shell: true,
				windowsHide: true,
				timeout: 15e3
			});
			if (probe.error === void 0 && probe.status === 0) return {
				command: candidate,
				viaCmd: true
			};
		}
	}
	return null;
}
/**
* Kill the CLI child. Through a cmd.exe shim the real CLI is a grandchild
* that inherited the stdout pipe: killing only cmd.exe leaves the pipe open
* and readers hang, so the whole tree is taken down with taskkill.
*/
function killCli(child, viaCmd) {
	if (child.exitCode !== null || child.signalCode !== null) return;
	if (viaCmd && process.platform === "win32" && child.pid !== void 0) try {
		spawn("taskkill", [
			"/pid",
			String(child.pid),
			"/T",
			"/F"
		], {
			windowsHide: true,
			stdio: "ignore"
		}).unref();
		return;
	} catch {}
	child.kill();
}
/** Start the CLI child process, routing .cmd/.bat shims through the shell. */
function startCli(resolved, prefixArgs, args, env) {
	try {
		if (resolved.viaCmd) return spawn(quoteCmdLine(resolved.command, [...prefixArgs, ...args]), {
			shell: true,
			env,
			windowsHide: true
		});
		return spawn(resolved.command, [...prefixArgs, ...args], {
			env,
			windowsHide: true
		});
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(`无法启动 Qoder CLI（${detail}）。对话历史可能过长：请新开一个会话，或在设置里调低 QODER_MAX_PROMPT_CHARS。`);
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
const resolveCache = /* @__PURE__ */ new Map();
/** Drop every cached resolution (tests, and a config change repointing the CLI). */
function clearQoderCliCache() {
	resolveCache.clear();
}
/** Ceiling on one `--list-models` run; it never talks to the network. */
const LIST_MODELS_TIMEOUT_MS = 2e4;
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
function parseListModelsOutput(stdout) {
	const models = [];
	const seen = /* @__PURE__ */ new Set();
	for (const rawLine of stdout.split(/\r?\n/u)) {
		const name = rawLine.replace(/^[\s|│┃*•\-]+/u, "").replace(/[\s|│┃]+$/u, "").trim();
		if (name === "") continue;
		if (/^models?$/iu.test(name)) continue;
		if (/^name$/iu.test(name)) continue;
		if (name.length > 60 || name.includes("  ")) continue;
		if (/^(error|usage|unknown|invalid|warning)[:\s]/iu.test(name)) continue;
		const id = qoderExternalId(name);
		if (seen.has(id)) continue;
		seen.add(id);
		models.push({
			externalId: id,
			cliModel: name
		});
	}
	return models.length > 0 ? models : null;
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
async function fetchQoderModels(options = {}) {
	const command = commandOf(options);
	const prefixArgs = prefixArgsOf(options);
	const resolved = resolveCliCached(command, prefixArgs, homeDirOf(options));
	if (resolved === null) return null;
	const env = { ...process.env };
	if (hasOauthLogin(options)) delete env.QODERCN_PERSONAL_ACCESS_TOKEN;
	else {
		const pat = patOf(options);
		if (pat !== void 0) env.QODERCN_PERSONAL_ACCESS_TOKEN = pat;
	}
	return new Promise((resolve) => {
		let stdout = "";
		let settled = false;
		let timer;
		const finish = (value) => {
			if (settled) return;
			settled = true;
			if (timer !== void 0) clearTimeout(timer);
			resolve(value);
		};
		let child;
		try {
			child = startCli(resolved, prefixArgs, ["--list-models"], env);
		} catch {
			resolve(null);
			return;
		}
		timer = setTimeout(() => {
			killCli(child, resolved.viaCmd);
			finish(null);
		}, LIST_MODELS_TIMEOUT_MS);
		if (typeof timer.unref === "function") timer.unref();
		child.stdout?.on("data", (chunk) => {
			stdout += chunk;
		});
		child.on("error", () => {
			finish(null);
		});
		child.on("close", (code) => {
			if (code !== 0) {
				finish(null);
				return;
			}
			finish(parseListModelsOutput(stdout));
		});
	});
}
function resolveCliCached(command, prefixArgs, homeDir) {
	const key = `${command}\u0000${homeDir}\u0000${prefixArgs.join("\0")}`;
	const now = Date.now();
	const hit = resolveCache.get(key);
	if (hit !== void 0 && now - hit.at < CLI_RESOLVE_TTL_MS) return hit.resolved;
	const resolved = resolveCli(command, prefixArgs, homeDir);
	resolveCache.set(key, {
		resolved,
		at: now
	});
	return resolved;
}
/**
* Readiness of the qoder path: CLI installed AND (OAuth login OR PAT).
* Never throws — callers surface `reason` to the user.
*/
function qoderStatus(options = {}) {
	const command = commandOf(options);
	const resolved = resolveCliCached(command, prefixArgsOf(options), homeDirOf(options));
	const oauth = hasOauthLogin(options);
	const pat = patOf(options) !== void 0;
	if (resolved === null) return {
		id: "qoder",
		ready: false,
		cli: null,
		oauth,
		pat,
		oauthFile: qoderOauthUserPath(options),
		reason: `未找到 Qoder CLI（${command}）：请先安装 Qoder 并执行 qoderclicn login`
	};
	if (!oauth && !pat) return {
		id: "qoder",
		ready: false,
		cli: resolved.command,
		oauth,
		pat,
		oauthFile: qoderOauthUserPath(options),
		reason: "未登录：请执行 qoderclicn login，或设置环境变量 QODERCN_PERSONAL_ACCESS_TOKEN"
	};
	return {
		id: "qoder",
		ready: true,
		cli: resolved.command,
		oauth,
		pat,
		oauthFile: qoderOauthUserPath(options),
		reason: oauth ? `ok（登录态落盘于 ${qoderOauthUserPath(options)}）` : "ok（QODERCN_PERSONAL_ACCESS_TOKEN）"
	};
}
/** Extract the text delta from one stream-json line; null for non-text records. */
function parseCliDelta(line) {
	let record;
	try {
		record = JSON.parse(line);
	} catch {
		return null;
	}
	if (typeof record !== "object" || record === null) return null;
	if (record.type !== "assistant") return null;
	const content = record.message?.content;
	if (!Array.isArray(content)) return null;
	const text = content.filter((part) => typeof part === "object" && part !== null && part.type === "text").map((part) => typeof part.text === "string" ? part.text : "").join("");
	return text === "" ? null : text;
}
/**
* Extract the run summary from one stream-json line; null for every other
* record. The `result` record is the CLI's last line and the only place it
* reports credit cost — the session event logs carry no credits at all.
*/
function parseCliResult(line) {
	let record;
	try {
		record = JSON.parse(line);
	} catch {
		return null;
	}
	if (typeof record !== "object" || record === null) return null;
	if (record.type !== "result") return null;
	const typed = record;
	return {
		credits: typeof typed.total_credits === "number" && Number.isFinite(typed.total_credits) ? typed.total_credits : 0,
		ms: typeof typed.duration_ms === "number" && Number.isFinite(typed.duration_ms) ? typed.duration_ms : 0,
		turns: typeof typed.num_turns === "number" && Number.isFinite(typed.num_turns) ? typed.num_turns : 0,
		isError: typed.is_error === true
	};
}
/** Flatten an OpenAI message content (string or parts array) to plain text. */
function flattenContent(content) {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) return content.map((part) => typeof part?.text === "string" ? part.text : "").join("");
	return "";
}
/** Marker prepended when earlier messages were dropped to fit the cap. */
const DROPPED_MARKER = (count) => `[系统提示：受单次 prompt 长度限制，较早的 ${count} 条消息已省略，请基于下方现有内容继续回答]`;
/** Marker appended when one message's own text was cut to fit the cap. */
const TRUNCATED_MARKER = "[……本条消息因长度限制被截断]";
/** Marker appended when the system prompt itself was cut to fit its cap. */
const TRUNCATED_SYSTEM_MARKER = "[……系统提示因长度限制被截断]";
/** Read a positive integer from the environment, clamped to a safe range. */
function envInt(name, fallback, min, max) {
	const raw = Number(process.env[name]);
	if (!Number.isFinite(raw) || raw <= 0) return fallback;
	return Math.min(max, Math.max(min, Math.floor(raw)));
}
/** Keep the head of `text` within `limit`, marking the cut. */
function truncateHead(text, limit, marker) {
	if (text.length <= limit) return text;
	const keep = Math.max(0, limit - marker.length - 1);
	return `${text.slice(0, keep)}\n${marker}`;
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
function buildCliPrompt(messages, options = {}) {
	const maxPromptChars = options.maxPromptChars ?? envInt("QODER_MAX_PROMPT_CHARS", 24e3, 1e3, 28e3);
	const maxSystemChars = options.maxSystemChars ?? envInt("QODER_MAX_SYSTEM_CHARS", 4e3, 200, 3e3);
	const list = Array.isArray(messages) ? messages : [];
	const systemRaw = flattenContent(list.find((m) => m?.role === "system")?.content);
	const system = truncateHead(systemRaw, maxSystemChars, TRUNCATED_SYSTEM_MARKER);
	const budget = Math.max(200, maxPromptChars - 64 - 1);
	const rest = list.filter((m) => m?.role !== "system");
	const kept = [];
	let used = 0;
	let index = rest.length - 1;
	let truncated = systemRaw.length > maxSystemChars;
	while (index >= 0) {
		const text = flattenContent(rest[index]?.content);
		index -= 1;
		if (text === "") continue;
		const separator = kept.length > 0 ? 1 : 0;
		if (used + separator + text.length <= budget) {
			kept.unshift(text);
			used += separator + text.length;
			continue;
		}
		const room = budget - used - separator;
		if (room > 40) {
			kept.unshift(truncateHead(text, room, TRUNCATED_MARKER));
			truncated = true;
		}
		break;
	}
	const dropped = index + 1;
	return {
		system,
		prompt: (dropped > 0 ? [DROPPED_MARKER(dropped), ...kept] : kept).join("\n"),
		dropped,
		truncated
	};
}
/** Map a wire model id (externalId or CLI spelling) to the CLI's `--model` value. */
function cliModelFor(model) {
	return QODER_MODELS.find((candidate) => candidate.externalId === model || candidate.cliModel === model)?.cliModel ?? model;
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
function buildReasoningArgs(options = {}) {
	const args = [];
	const effort = options.reasoningEffort;
	if (effort !== void 0 && QODER_REASONING_EFFORTS.includes(effort)) args.push("--reasoning-effort", effort);
	const thinking = options.thinking;
	if (thinking !== void 0 && QODER_THINKING_MODES.includes(thinking)) args.push("--thinking", thinking);
	const budget = options.thinkingBudget;
	if (typeof budget === "number" && Number.isFinite(budget) && budget > 0) args.push("--thinking-budget", String(Math.min(Math.floor(budget), QODER_MAX_THINKING_BUDGET)));
	return args;
}
/** The OpenAI `model` list entry for one qoder model. */
function qoderModelListEntry(model) {
	return {
		id: model.externalId,
		object: "model",
		created: 0,
		owned_by: "qoder"
	};
}
function chunkId() {
	return `chatcmpl-qoder-${Math.random().toString(36).slice(2, 10)}`;
}
/**
* Run one chat completion through the CLI, yielding OpenAI chunk objects as
* the stream-json lines arrive. Honors `signal` (client gone) and `timeoutMs`
* (overall ceiling) by killing the child. The final chunk always carries
* finish_reason 'stop'.
*/
async function* qoderChatStream(body, options = {}) {
	const command = commandOf(options);
	const prefixArgs = prefixArgsOf(options);
	const homeDir = homeDirOf(options);
	const requestBody = typeof body === "object" && body !== null ? body : {};
	const model = cliModelFor(typeof requestBody.model === "string" && requestBody.model !== "" ? requestBody.model : QODER_DEFAULT_MODEL);
	const wireEffort = requestBody.reasoning_effort;
	const reasoningEffort = typeof wireEffort === "string" && QODER_REASONING_EFFORTS.includes(wireEffort) ? wireEffort : options.reasoningEffort;
	const { system, prompt } = buildCliPrompt(requestBody.messages);
	const args = [
		"--print",
		"--output-format",
		"stream-json",
		"--model",
		model,
		...buildReasoningArgs({
			...options,
			reasoningEffort
		}),
		"--dangerously-skip-permissions",
		...system !== "" ? ["--append-system-prompt", system] : [],
		"--",
		prompt
	];
	const env = { ...process.env };
	if (hasOauthLogin(options)) delete env.QODERCN_PERSONAL_ACCESS_TOKEN;
	else {
		const pat = patOf(options);
		if (pat !== void 0) env.QODERCN_PERSONAL_ACCESS_TOKEN = pat;
	}
	const resolved = resolveCliCached(command, prefixArgs, homeDir);
	if (resolved === null) throw new Error(`未找到 Qoder CLI（${command}）：请先安装 Qoder 并执行 qoderclicn login`);
	const created = Math.floor(Date.now() / 1e3);
	const id = chunkId();
	const emit = (text) => ({
		id,
		object: "chat.completion.chunk",
		created,
		model,
		choices: [{
			index: 0,
			delta: { content: text },
			finish_reason: null
		}]
	});
	const child = startCli(resolved, prefixArgs, args, env);
	const signal = options.signal;
	const onAbort = () => {
		killCli(child, resolved.viaCmd);
	};
	if (signal !== void 0) {
		if (signal.aborted) killCli(child, resolved.viaCmd);
		else signal.addEventListener("abort", onAbort, { once: true });
	}
	let timedOut = false;
	const timer = typeof options.timeoutMs === "number" && options.timeoutMs > 0 ? setTimeout(() => {
		timedOut = true;
		killCli(child, resolved.viaCmd);
	}, options.timeoutMs) : null;
	if (timer !== null && typeof timer.unref === "function") timer.unref();
	let buffer = "";
	let stderr = "";
	let exitCode = null;
	let spawnError = null;
	/** The CLI's own run summary, captured from the final `result` record. */
	let runResult = null;
	const closed = new Promise((resolve) => {
		child.on("error", (error) => {
			spawnError = error;
			child.stdout?.destroy();
			resolve();
		});
		child.on("close", (code) => {
			exitCode = code;
			resolve();
		});
	});
	child.stderr?.on("data", (chunk) => {
		stderr += chunk;
	});
	try {
		try {
			for await (const piece of child.stdout ?? []) {
				buffer += piece;
				for (;;) {
					const newline = buffer.indexOf("\n");
					if (newline < 0) break;
					const line = buffer.slice(0, newline).replace(/\r$/, "");
					buffer = buffer.slice(newline + 1);
					const result = parseCliResult(line);
					if (result !== null) {
						runResult = result;
						continue;
					}
					const text = parseCliDelta(line);
					if (text !== null) yield emit(text);
				}
			}
		} catch (streamError) {
			if (spawnError === null) throw streamError;
		}
		if (buffer.trim() !== "") {
			const result = parseCliResult(buffer);
			if (result !== null) runResult = result;
			else {
				const text = parseCliDelta(buffer);
				if (text !== null) yield emit(text);
			}
		}
		await closed;
		if (spawnError !== null) throw spawnError;
		if (timedOut) throw new Error(`qoderclicn 超过 ${Math.round((options.timeoutMs ?? 0) / 1e3)}s 未结束，已终止`);
		if (signal?.aborted) {
			const reason = signal.reason;
			throw new Error(typeof reason?.message === "string" && reason.message !== "" ? reason.message : "aborted");
		}
		if (exitCode !== 0) throw new Error(`qoderclicn exited ${exitCode}: ${stderr.slice(0, 300)}`);
	} finally {
		if (signal !== void 0) signal.removeEventListener("abort", onAbort);
		if (timer !== null) clearTimeout(timer);
		killCli(child, resolved.viaCmd);
		try {
			options.onRunComplete?.(runResult ?? {
				credits: 0,
				ms: 0,
				turns: 0,
				isError: true
			}, model);
		} catch {}
	}
	yield {
		id,
		object: "chat.completion.chunk",
		created,
		model,
		choices: [{
			index: 0,
			delta: {},
			finish_reason: "stop"
		}]
	};
}
/** Aggregate streamed chunks into one chat.completion (usage estimated: chars/4). */
function aggregateQoderChunks(chunks, requestBody) {
	let content = "";
	let id = `chatcmpl-qoder-${Date.now()}`;
	let created = Math.floor(Date.now() / 1e3);
	let model = QODER_DEFAULT_MODEL;
	for (const chunk of chunks) {
		if (typeof chunk?.id === "string") id = chunk.id;
		if (typeof chunk?.created === "number") created = chunk.created;
		if (typeof chunk?.model === "string" && chunk.model !== "") model = chunk.model;
		const delta = chunk?.choices?.[0]?.delta;
		if (typeof delta?.content === "string") content += delta.content;
	}
	const { prompt } = buildCliPrompt(requestBody?.messages);
	const promptTokens = Math.ceil(prompt.length / 4);
	const completionTokens = Math.ceil(content.length / 4);
	return {
		id,
		object: "chat.completion",
		created,
		model,
		choices: [{
			index: 0,
			message: {
				role: "assistant",
				content
			},
			finish_reason: "stop"
		}],
		usage: {
			prompt_tokens: promptTokens,
			completion_tokens: completionTokens,
			total_tokens: promptTokens + completionTokens
		}
	};
}
//#endregion
//#region src/version.ts
/** The plugin's own version, as published in package.json. */
const QODER_CONNECT_VERSION = "0.2.1";
//#endregion
export { qoderStatus as C, qoderOauthUserPath as S, parseListModelsOutput as _, QODER_REASONING_EFFORTS as a, qoderModelListEntry as b, aggregateQoderChunks as c, clearQoderCliCache as d, cliModelFor as f, parseCliResult as g, parseCliDelta as h, QODER_MODELS as i, buildCliPrompt as l, flattenContent as m, QODER_DEFAULT_MODEL as n, QODER_THINKING_MODES as o, fetchQoderModels as p, QODER_MAX_THINKING_BUDGET as r, QODER_TIMEOUT_MS as s, QODER_CONNECT_VERSION as t, buildReasoningArgs as u, qoderChatStream as v, qoderOauthUserCandidates as x, qoderExternalId as y };
