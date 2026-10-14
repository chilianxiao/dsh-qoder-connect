window.__ModuleLoader__.load({
	id: "dsh-qoder-connect",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
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
		//#region src/client/status-document.ts
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
		function isQoderWebStatus(value) {
			if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
			const wrapped = value;
			const status = wrapped["status"];
			if (status === "ready" || status === "not-ready") return true;
			return status === "error" && typeof wrapped["message"] === "string";
		}
		//#endregion
		//#region src/client/locales.ts
		const zh = {
			title: "Qoder",
			intro: "把本机 qoderclicn CLI 的登录态接入 DSH：安装并登录 Qoder 后即可在模型选择器里使用。",
			ready: "就绪",
			notReady: "未就绪",
			cli: "CLI",
			login: "登录方式",
			loginOauth: "qoderclicn login 落盘登录态",
			loginPat: "QODERCN_PERSONAL_ACCESS_TOKEN",
			loginNone: "未登录",
			oauthFile: "登录态文件",
			models: "可用模型",
			refresh: "刷新",
			refreshing: "刷新中…",
			hintCli: "未找到 Qoder CLI：请安装 Qoder，或在设置里指定 CLI 路径（QODERCN_CLI）。",
			hintLogin: "尚未登录：请执行 qoderclicn login，或设置环境变量 QODERCN_PERSONAL_ACCESS_TOKEN。",
			statusResponseInvalid: "状态响应格式无法识别",
			requestFailed: "请求失败",
			reasoning: "推理设置",
			effort: "推理等级",
			thinking: "思考模式",
			thinkingBudget: "思考预算 (tokens)",
			reasoningDefault: "跟随 CLI 默认",
			reasoningHint: "这三项会作为 --reasoning-effort / --thinking / --thinking-budget 传给 qoderclicn，对之后的所有对话生效。留空则不下发该参数。",
			save: "保存",
			saving: "保存中…",
			saved: "已保存",
			reset: "恢复默认",
			rosterCli: "来自 qoderclicn --list-models（Qoder 新增模型会自动出现）",
			rosterBuiltin: "内置列表（未能从 CLI 拉取，Qoder 新加的模型可能不在此列）",
			refreshModels: "重新拉取模型",
			refreshingModels: "拉取中…"
		};
		const en = {
			title: "Qoder",
			intro: "Brings your local qoderclicn CLI login into DSH: install and sign in to Qoder, then pick a Qoder model.",
			ready: "Ready",
			notReady: "Not ready",
			cli: "CLI",
			login: "Sign-in",
			loginOauth: "qoderclicn login on-disk state",
			loginPat: "QODERCN_PERSONAL_ACCESS_TOKEN",
			loginNone: "Not signed in",
			oauthFile: "Login file",
			models: "Models",
			refresh: "Refresh",
			refreshing: "Refreshing…",
			hintCli: "Qoder CLI not found: install Qoder, or point the CLI path at it in settings (QODERCN_CLI).",
			hintLogin: "Not signed in: run qoderclicn login once, or set QODERCN_PERSONAL_ACCESS_TOKEN.",
			statusResponseInvalid: "status response was not recognized",
			requestFailed: "request failed",
			reasoning: "Reasoning",
			effort: "Reasoning effort",
			thinking: "Thinking mode",
			thinkingBudget: "Thinking budget (tokens)",
			reasoningDefault: "Follow the CLI default",
			reasoningHint: "Passed to qoderclicn as --reasoning-effort / --thinking / --thinking-budget for every later run. Empty sends no flag.",
			save: "Save",
			saving: "Saving…",
			saved: "Saved",
			reset: "Reset to default",
			rosterCli: "From qoderclicn --list-models (models Qoder adds appear automatically)",
			rosterBuiltin: "Built-in list (could not read the CLI, so newly added models may be missing)",
			refreshModels: "Re-fetch models",
			refreshingModels: "Fetching…"
		};
		//#endregion
		//#region src/client/QoderPluginCard.tsx
		/** Qoder status card contributed to the Plugins page's Official group. */
		/**
		* The vocabularies the CLI accepts, duplicated from the host half because
		* the browser bundle cannot import `qoder.ts` (it reaches for node:child_process).
		* A value outside these lists makes the CLI exit before serving the request,
		* so the selects must never offer one.
		*/
		const EFFORT_LEVELS = [
			"auto",
			"none",
			"low",
			"medium",
			"high",
			"xhigh",
			"max",
			"ultracode"
		];
		const THINKING_MODES = [
			"auto",
			"adaptive",
			"enabled",
			"disabled"
		];
		const MAX_THINKING_BUDGET = 1e6;
		const POLL_INTERVAL_MS = 6e4;
		const bodyStyle = {
			margin: 0,
			fontSize: 14,
			lineHeight: "22px",
			color: "var(--dsw-alias-label-secondary)"
		};
		const errorStyle = {
			...bodyStyle,
			color: "var(--dsw-alias-state-error-primary)"
		};
		const rowStyle = {
			display: "flex",
			alignItems: "center",
			justifyContent: "space-between",
			flexWrap: "wrap",
			gap: 12
		};
		const buttonStyle = {
			boxSizing: "border-box",
			minHeight: 34,
			padding: "6px 14px",
			border: "1px solid var(--dsw-alias-border-l2)",
			borderRadius: 18,
			background: "var(--dsw-alias-bg-layer-1)",
			color: "var(--dsw-alias-label-primary)",
			font: "inherit",
			fontSize: 14,
			cursor: "pointer"
		};
		const monoStyle = {
			fontFamily: "var(--dsw-alias-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)",
			fontSize: 12,
			wordBreak: "break-all"
		};
		/** Fallback translator: English copy, {name} placeholders interpolated. */
		function fallbackT(key, params) {
			const template = en[key] ?? key;
			return params === void 0 ? template : template.replace(/\{(\w+)\}/gu, (_match, name) => String(params[name] ?? ""));
		}
		/** One labeled fact row. */
		function FactRow({ label, children }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: rowStyle,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					style: {
						color: "var(--dsw-alias-label-tertiary)",
						fontSize: 13
					},
					children: label
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					style: { textAlign: "right" },
					children
				})]
			});
		}
		/** The model list, as a wrapped set of chips. */
		function ModelChips({ models }) {
			if (models.length === 0) return null;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				style: {
					display: "flex",
					flexWrap: "wrap",
					gap: 6,
					paddingTop: 4
				},
				children: models.map((model) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					style: {
						padding: "2px 10px",
						borderRadius: 999,
						fontSize: 12,
						lineHeight: "18px",
						background: "var(--dsw-alias-bg-layer-1, rgba(127, 127, 127, 0.12))",
						color: "var(--dsw-alias-label-secondary)"
					},
					children: model.name
				}, model.id))
			});
		}
		/** Read the status document; `mode` decides whether the read repeats. */
		function useQoderStatus(mode) {
			const [status, setStatus] = (0, react.useState)();
			const [readFailure, setReadFailure] = (0, react.useState)();
			const [busy, setBusy] = (0, react.useState)(false);
			const mounted = (0, react.useRef)(true);
			/**
			* Identity of the newest read that may write. Assigned when a read
			* *starts*, so a response is superseded by anything begun after it —
			* "the response whose request started last wins".
			*/
			const readSeq = (0, react.useRef)(0);
			const manualControllers = (0, react.useRef)(/* @__PURE__ */ new Set());
			(0, react.useEffect)(() => {
				mounted.current = true;
				return () => {
					mounted.current = false;
					for (const controller of manualControllers.current) controller.abort();
					manualControllers.current.clear();
				};
			}, []);
			/**
			* Read the status document and apply it under the two policies the card's
			* correctness rests on:
			*
			* - a non-document body (empty, `null`, a non-JSON page) is a failed read,
			*   not something to store and then dereference in the render;
			* - a failed read never discards a document already on screen.
			*/
			const read = (0, react.useCallback)(async (signal) => {
				const seq = ++readSeq.current;
				const current = () => mounted.current && signal?.aborted !== true && seq === readSeq.current;
				try {
					const response = await fetch(QODER_STATUS_PATH, {
						headers: { accept: "application/json" },
						credentials: "same-origin",
						...signal === void 0 ? {} : { signal }
					});
					const value = await response.json().catch(() => void 0);
					if (!response.ok) throw new Error(`HTTP ${response.status}`);
					if (!isQoderWebStatus(value)) throw new Error("status response was not recognized");
					if (!current()) return;
					setStatus(value);
					setReadFailure(void 0);
				} catch (error) {
					if (!current()) return;
					const message = error instanceof Error ? error.message : "request failed";
					setReadFailure(message);
					setStatus((previous) => previous === void 0 ? {
						status: "error",
						message
					} : previous);
				}
			}, []);
			(0, react.useEffect)(() => {
				if (mode === "off") return;
				const controller = new AbortController();
				read(controller.signal);
				return () => {
					controller.abort();
				};
			}, [mode, read]);
			(0, react.useEffect)(() => {
				if (mode !== "poll") return;
				const controller = new AbortController();
				const timer = window.setInterval(() => {
					read(controller.signal);
				}, POLL_INTERVAL_MS);
				return () => {
					controller.abort();
					window.clearInterval(timer);
				};
			}, [mode, read]);
			return {
				status,
				readFailure,
				refresh: (0, react.useCallback)(async () => {
					const controller = new AbortController();
					manualControllers.current.add(controller);
					setBusy(true);
					try {
						await read(controller.signal);
					} finally {
						manualControllers.current.delete(controller);
						setBusy(false);
					}
				}, [read]),
				busy
			};
		}
		/** The one-liner the card list and the detail header render. */
		function SummaryLine({ status, t }) {
			const translate = t ?? fallbackT;
			if (status === void 0) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: translate("refreshing") });
			if (status.status === "error") return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				style: errorStyle,
				children: status.message
			});
			if (status.status === "not-ready") return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
				style: {
					display: "inline-flex",
					alignItems: "center",
					gap: 8,
					flexWrap: "wrap"
				},
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Dot, { ok: false }),
					translate("notReady"),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						style: { color: "var(--dsw-alias-label-tertiary)" },
						children: status.reason
					})
				]
			});
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
				style: {
					display: "inline-flex",
					alignItems: "center",
					gap: 8,
					flexWrap: "wrap"
				},
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Dot, { ok: true }),
					translate("ready"),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
						style: { color: "var(--dsw-alias-label-tertiary)" },
						children: [
							status.models.length,
							" ",
							translate("models")
						]
					})
				]
			});
		}
		function Dot({ ok }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				"aria-hidden": true,
				style: {
					width: 8,
					height: 8,
					borderRadius: 999,
					background: ok ? "var(--dsw-alias-state-success-primary, #22a06b)" : "var(--dsw-alias-state-error-primary, #d93025)"
				}
			});
		}
		/** The detail body the plugin's own page renders. */
		function DetailBody({ status, readFailure, busy, onRefresh, onSaved, onRefetchModels, fetchingModels, modelNote, t }) {
			const translate = t ?? fallbackT;
			if (status === void 0) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				style: bodyStyle,
				children: translate("refreshing")
			});
			if (status.status === "error") return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				style: errorStyle,
				children: status.message
			});
			const ready = status.status === "ready";
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: {
					display: "flex",
					flexDirection: "column",
					gap: 12
				},
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: rowStyle,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							style: {
								display: "flex",
								alignItems: "center",
								gap: 9,
								fontSize: 15,
								fontWeight: 500,
								color: "var(--dsw-alias-label-primary)"
							},
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Dot, { ok: ready }), ready ? translate("ready") : translate("notReady")]
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							style: buttonStyle,
							disabled: busy,
							onClick: onRefresh,
							children: busy ? translate("refreshing") : translate("refresh")
						})]
					}),
					readFailure !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						style: errorStyle,
						children: readFailure
					}) : null,
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(FactRow, {
						label: translate("cli"),
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: monoStyle,
							children: status.cli ?? "—"
						})
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(FactRow, {
						label: translate("login"),
						children: ready ? status.source === "oauth" ? translate("loginOauth") : translate("loginPat") : status.oauth ? translate("loginOauth") : status.pat ? translate("loginPat") : translate("loginNone")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(FactRow, {
						label: translate("oauthFile"),
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: monoStyle,
							children: status.oauthFile
						})
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ReasoningControls, {
						initial: status.reasoning,
						onSaved,
						t
					}),
					!ready ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
						style: bodyStyle,
						children: [
							status.reason,
							" ",
							status.cli === void 0 ? translate("hintCli") : translate("hintLogin")
						]
					}) : null,
					ready && status.models.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							display: "flex",
							flexDirection: "column",
							gap: 4
						},
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: rowStyle,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: {
										color: "var(--dsw-alias-label-tertiary)",
										fontSize: 13
									},
									children: translate("models")
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									style: buttonStyle,
									disabled: fetchingModels,
									onClick: onRefetchModels,
									children: fetchingModels ? translate("refreshingModels") : translate("refreshModels")
								})]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ModelChips, { models: status.models }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: {
									color: "var(--dsw-alias-label-tertiary)",
									fontSize: 12
								},
								children: status.rosterSource === "cli" ? translate("rosterCli") : translate("rosterBuiltin")
							}),
							modelNote !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								style: errorStyle,
								children: modelNote
							}) : null
						]
					}) : null
				]
			});
		}
		/**
		* The reasoning controls: effort, thinking mode, and an optional token
		* budget. Edits are staged locally and written on Save, so a half-typed
		* budget never becomes a request parameter.
		*/
		function ReasoningControls({ initial, onSaved, t }) {
			const translate = t ?? fallbackT;
			const [effort, setEffort] = (0, react.useState)(initial.effort);
			const [thinking, setThinking] = (0, react.useState)(initial.thinking);
			const [budget, setBudget] = (0, react.useState)(initial.budget === 0 ? "" : String(initial.budget));
			const [busy, setBusy] = (0, react.useState)(false);
			const [note, setNote] = (0, react.useState)();
			const [failure, setFailure] = (0, react.useState)();
			(0, react.useEffect)(() => {
				setEffort(initial.effort);
				setThinking(initial.thinking);
				setBudget(initial.budget === 0 ? "" : String(initial.budget));
			}, [
				initial.effort,
				initial.thinking,
				initial.budget
			]);
			const dirty = effort !== initial.effort || thinking !== initial.thinking || budget !== (initial.budget === 0 ? "" : String(initial.budget));
			const save = (0, react.useCallback)(async (next) => {
				setBusy(true);
				setNote(void 0);
				setFailure(void 0);
				try {
					const parsedBudget = next.budget.trim() === "" ? 0 : Number(next.budget);
					if (!Number.isInteger(parsedBudget) || parsedBudget < 0 || parsedBudget > MAX_THINKING_BUDGET) throw new Error(`${translate("thinkingBudget")}: 0–${MAX_THINKING_BUDGET}`);
					const response = await fetch(QODER_CONFIG_PATH, {
						method: "POST",
						headers: {
							"content-type": "application/json",
							accept: "application/json"
						},
						credentials: "same-origin",
						body: JSON.stringify({
							reasoningEffort: next.effort,
							thinking: next.thinking,
							thinkingBudget: parsedBudget
						})
					});
					const payload = await response.json().catch(() => void 0);
					if (!response.ok) {
						const message = payload?.error;
						throw new Error(typeof message === "string" && message !== "" ? message : `HTTP ${response.status}`);
					}
					setNote(translate("saved"));
					await onSaved();
				} catch (error) {
					setFailure(error instanceof Error ? error.message : translate("requestFailed"));
				} finally {
					setBusy(false);
				}
			}, [onSaved, translate]);
			const controlStyle = {
				...buttonStyle,
				minHeight: 30,
				padding: "4px 9px",
				borderRadius: 8,
				fontSize: 13,
				minWidth: 150
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: {
					display: "flex",
					flexDirection: "column",
					gap: 8,
					paddingTop: 4
				},
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						style: {
							color: "var(--dsw-alias-label-tertiary)",
							fontSize: 13
						},
						children: translate("reasoning")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: rowStyle,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: {
								color: "var(--dsw-alias-label-tertiary)",
								fontSize: 13
							},
							children: translate("effort")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
							style: controlStyle,
							value: effort,
							disabled: busy,
							onChange: (event) => {
								setEffort(event.target.value);
							},
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
								value: "",
								children: translate("reasoningDefault")
							}), EFFORT_LEVELS.map((level) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
								value: level,
								children: level
							}, level))]
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: rowStyle,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: {
								color: "var(--dsw-alias-label-tertiary)",
								fontSize: 13
							},
							children: translate("thinking")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
							style: controlStyle,
							value: thinking,
							disabled: busy,
							onChange: (event) => {
								setThinking(event.target.value);
							},
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
								value: "",
								children: translate("reasoningDefault")
							}), THINKING_MODES.map((mode) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
								value: mode,
								children: mode
							}, mode))]
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: rowStyle,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: {
								color: "var(--dsw-alias-label-tertiary)",
								fontSize: 13
							},
							children: translate("thinkingBudget")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							style: controlStyle,
							inputMode: "numeric",
							placeholder: translate("reasoningDefault"),
							value: budget,
							disabled: busy,
							onChange: (event) => {
								setBudget(event.target.value.replace(/[^\d]/gu, ""));
							}
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: rowStyle,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: {
								color: "var(--dsw-alias-label-tertiary)",
								fontSize: 12,
								maxWidth: 340
							},
							children: translate("reasoningHint")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: {
								display: "inline-flex",
								gap: 8
							},
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								style: buttonStyle,
								disabled: busy || !dirty,
								onClick: () => {
									save({
										effort,
										thinking,
										budget
									});
								},
								children: busy ? translate("saving") : translate("save")
							})
						})]
					}),
					note !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						style: {
							...bodyStyle,
							fontSize: 13
						},
						children: note
					}) : null,
					failure !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						style: errorStyle,
						children: failure
					}) : null
				]
			});
		}
		/**
		* Render Qoder readiness: the one-liner the card list shows (`summary`) and
		* the full document on the plugin's own page (`page`).
		*
		* The two views mount as separate component instances (the page dispatches
		* each occurrence with `only`), so each keeps its own read state.
		*/
		function QoderPluginCard({ view, t }) {
			const { status, readFailure, refresh, busy } = useQoderStatus(view === "page" ? "poll" : "once");
			const translate = t ?? fallbackT;
			const onRefresh = (0, react.useCallback)(() => {
				refresh();
			}, [refresh]);
			const onSaved = (0, react.useCallback)(async () => {
				await refresh();
			}, [refresh]);
			const [fetchingModels, setFetchingModels] = (0, react.useState)(false);
			const [modelNote, setModelNote] = (0, react.useState)();
			const onRefetchModels = (0, react.useCallback)(() => {
				setFetchingModels(true);
				setModelNote(void 0);
				(async () => {
					try {
						const response = await fetch(QODER_CONFIG_PATH, {
							method: "POST",
							headers: {
								"content-type": "application/json",
								accept: "application/json"
							},
							credentials: "same-origin",
							body: JSON.stringify({ action: "refreshModels" })
						});
						const payload = await response.json().catch(() => void 0);
						if (!response.ok) {
							const message = payload?.error;
							throw new Error(typeof message === "string" && message !== "" ? message : `HTTP ${response.status}`);
						}
						await refresh();
					} catch (error) {
						setModelNote(error instanceof Error ? error.message : translate("requestFailed"));
					} finally {
						setFetchingModels(false);
					}
				})();
			}, [refresh, translate]);
			if (view === "summary") return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SummaryLine, {
				status,
				t
			});
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(DetailBody, {
				status,
				readFailure,
				busy,
				onRefresh,
				onSaved,
				onRefetchModels,
				fetchingModels,
				modelNote,
				t
			});
		}
		//#endregion
		//#region src/client/index.tsx
		/** Stable browser-plugin name. */
		const name = "dsh-qoder-connect-client";
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
		const inject = ["slots", "locale"];
		/** The card's entry id inside the `plugins.item` list slot. */
		const CARD_ID = "dsh-qoder-connect";
		/**
		* Register card copy and the Qoder card under Plugin configuration.
		*
		* The entire body is wrapped so that a DSH slot-API breaking change degrades
		* to a `console.error` instead of throwing into the DSH loader and raising
		* the red "Failed to load plugins" banner. The host provider keeps working:
		* the `qoder` model channel is unaffected, and `dsh-qoder-connect status`
		* reports readiness without a browser.
		*/
		function apply(ctx) {
			try {
				const namespace = "settings.qoder";
				ctx.effect(() => ctx.locale.register(namespace, {
					zh,
					en
				}), "dsh-qoder-connect: settings copy");
				ctx.slots.inject("plugins.item", () => ctx.slots.register({
					name: "plugins.item",
					id: CARD_ID,
					order: 30,
					label: "Qoder",
					locale: namespace
				}, QoderPluginCard));
			} catch (error) {
				console.error("[dsh-qoder-connect] client card failed to load (host provider unaffected):", error);
			}
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	}
});
