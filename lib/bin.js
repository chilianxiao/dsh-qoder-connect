#!/usr/bin/env node
import { C as qoderStatus, i as QODER_MODELS, s as QODER_TIMEOUT_MS, t as QODER_CONNECT_VERSION } from "./version-BaVYk8E_.js";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
//#region src/bin.ts
/** Standalone status/diagnostics CLI for the dsh-qoder-connect bundle. */
const JSON_SCHEMA_VERSION = 1;
function printHelp() {
	process.stdout.write([
		"Usage: dsh-qoder-connect <doctor|models|status> [--json] [--cli <command>]",
		"",
		"  doctor   secret-free readiness and environment diagnostics",
		"  models   list the models the qoder provider exposes",
		"  status   readiness of the local Qoder CLI login",
		"",
		"  --cli        Qoder CLI command or path (defaults to QODERCN_CLI, then qoderclicn)",
		"  --json       emit one secret-free JSON document (doctor/status only)",
		""
	].join("\n"));
}
function printJson(value) {
	process.stdout.write(`${JSON.stringify(value)}\n`);
}
/** Parse the shared flags; `undefined` action means help was requested. */
function parseArgs(argv) {
	const json = argv.includes("--json");
	const rest = [];
	let cli;
	for (let index = 0; index < argv.length; index += 1) {
		const flag = argv[index];
		if (flag === "--cli") {
			cli = argv[index + 1];
			index += 1;
			continue;
		}
		if (flag.startsWith("--cli=")) {
			cli = flag.slice(6);
			continue;
		}
		rest.push(flag);
	}
	const actions = [
		"doctor",
		"models",
		"status"
	];
	const rawAction = rest[0];
	if (rawAction === void 0 || rawAction === "--help" || rawAction === "-h") return {
		json,
		options: {}
	};
	if (!actions.includes(rawAction)) return {
		json,
		options: {},
		error: `expected doctor, models, or status; got ${JSON.stringify(rawAction)}`
	};
	const unknown = rest.slice(1).filter((flag) => flag !== "--json");
	if (unknown.length > 0) return {
		json,
		options: {},
		error: `invalid options for ${rawAction}: ${unknown.join(" ")}`
	};
	return {
		action: rawAction,
		json,
		options: cli === void 0 || cli === "" ? {} : { command: cli }
	};
}
async function doctor(jsonOutput, options) {
	const status = qoderStatus(options);
	const report = {
		schemaVersion: JSON_SCHEMA_VERSION,
		package: "dsh-qoder-connect",
		version: QODER_CONNECT_VERSION,
		node: process.version,
		platform: process.platform,
		provider: "qoder",
		ready: status.ready,
		cli: status.cli,
		oauth: status.oauth,
		pat: status.pat,
		oauthFile: status.oauthFile,
		timeoutMs: QODER_TIMEOUT_MS,
		models: QODER_MODELS.length,
		reason: status.reason,
		hints: [...status.cli === null ? ["Qoder CLI not found: install Qoder, or set QODERCN_CLI / --cli to its path."] : [], ...status.oauth ? [] : ["No OAuth login state file found; run `qoderclicn login` once, or set QODERCN_PERSONAL_ACCESS_TOKEN."]]
	};
	if (jsonOutput) printJson(report);
	else process.stdout.write([
		`Qoder Connect ${QODER_CONNECT_VERSION} on ${process.version} (${process.platform})`,
		`CLI: ${status.cli ?? "(not found)"}`,
		`Login: ${status.oauth ? `oauth (${status.oauthFile})` : status.pat ? "QODERCN_PERSONAL_ACCESS_TOKEN" : "(none)"}`,
		`Ready: ${status.ready ? "yes" : "no"} — ${status.reason}`,
		`Models: ${QODER_MODELS.length} (default ${QODER_MODELS.find((model) => model.cliModel === "Qwen3.7-Max")?.externalId ?? "qoder-qwen3.7-max"})`,
		...report.hints.map((hint) => `Hint: ${hint}`),
		""
	].join("\n"));
	return status.ready ? 0 : 1;
}
function status(jsonOutput, options) {
	const value = qoderStatus(options);
	if (jsonOutput) printJson({
		schemaVersion: JSON_SCHEMA_VERSION,
		package: "dsh-qoder-connect",
		version: QODER_CONNECT_VERSION,
		provider: "qoder",
		status: value.ready ? "ready" : "not-ready",
		cli: value.cli,
		oauth: value.oauth,
		pat: value.pat,
		oauthFile: value.oauthFile,
		reason: value.reason,
		models: QODER_MODELS.map((model) => model.externalId)
	});
	else process.stdout.write([
		`Qoder Connect: ${value.ready ? "ready" : "not ready"}`,
		`CLI: ${value.cli ?? "(not found)"}`,
		`Login: ${value.oauth ? `oauth (${value.oauthFile})` : value.pat ? "QODERCN_PERSONAL_ACCESS_TOKEN" : "(none)"}`,
		value.reason,
		""
	].join("\n"));
	return value.ready ? 0 : 1;
}
function models(jsonOutput) {
	if (jsonOutput) printJson({
		schemaVersion: JSON_SCHEMA_VERSION,
		package: "dsh-qoder-connect",
		version: QODER_CONNECT_VERSION,
		provider: "qoder",
		models: QODER_MODELS.map((model) => ({
			id: model.externalId,
			cliModel: model.cliModel
		}))
	});
	else process.stdout.write([...QODER_MODELS.map((model) => `${model.externalId}\t${model.cliModel}`), ""].join("\n"));
	return 0;
}
/** Execute one boot-free command. */
async function run(argv) {
	const parsed = parseArgs(argv);
	if (parsed.error !== void 0) {
		process.stderr.write(`dsh-qoder-connect: ${parsed.error}\n`);
		return 1;
	}
	if (parsed.action === void 0) {
		printHelp();
		return 0;
	}
	try {
		switch (parsed.action) {
			case "doctor": return await doctor(parsed.json, parsed.options);
			case "models": return models(parsed.json);
			case "status": return status(parsed.json, parsed.options);
		}
	} catch (error) {
		process.stderr.write(`dsh-qoder-connect: ${parsed.action} failed: ${error instanceof Error ? error.message : String(error)}\n`);
		return 1;
	}
}
if (process.argv[1] !== void 0 && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) process.exitCode = await run(process.argv.slice(2));
//#endregion
export { run };
