# DSH Qoder Connect

[中文](./README.md) | English

Wraps your **local `qoderclicn` CLI login** as an OpenAI-compatible provider inside DeepSeek Harness: once Qoder is installed and you have signed in with `qoderclicn login`, Qoder's models appear in the DSH model picker with zero extra configuration.

The reverse-proxy core is ported from [1416277987/proxy-hub](https://github.com/1416277987/proxy-hub)'s `adapters/qoder.js`; the plugin structure follows [corrinehu/dsh-workbuddy-connect](https://github.com/corrinehu/dsh-workbuddy-connect) (MIT).

## Features

- **Zero configuration**: the plugin reuses the on-disk login state written by `qoderclicn login` and starts no OAuth flow of its own. There is no upstream HTTP request anywhere — the local CLI is the upstream.
- **Model group**: Qoder models appear as a "Qoder" group in the model picker. The group hides itself while the CLI is missing or nobody is signed in, and appears (without restarting DSH) once a login lands.
- **Model list**: fetched once at startup from `qoderclicn --list-models` and again only when the card's "Re-fetch models" is pressed, so **a model Qoder adds later appears without a plugin update**. A failed fetch keeps the current roster — the last successful answer is persisted on disk — so the group never disappears. The card says which tier is serving: the CLI's live answer, the saved copy, or the built-in fallback.
- **Login detection**: three layouts are recognized — `~/.qoderworkcn/.auth-cn/user` (the layout proxy-hub documents), `~/.qoder-cn/.auth/user` (Qoder CN CLI, verified), and `~/.qoder/.auth/user` (international qodercli). `QODERCN_PERSONAL_ACCESS_TOKEN` is honored as well.
- **Works off PATH**: the CLI is resolved through PATH first, then the well-known install dirs (`~/.qoder-cn/bin/qoderclicn`, `~/.qoder/bin/qodercli`); Windows `.cmd` shims are started through the shell correctly.
- **Image input**: models the official catalog marks `is_vl` advertise the image capability, and images in a request are handed to the CLI as `--attachment` — **still no upstream HTTP**. Only data URLs are served (which is what DSH's attachment pipeline produces); a remote image URL is skipped rather than fetched.
- **Context window switch**: the card offers "Use the upstream-declared maximum". On requests the largest window each model declares (e.g. 1M); off uses the window the official client picks by default (usually 200K). The number always comes from the catalog's declared tiers — the CLI does not validate `--context-window`, so an invented value would be meaningless.
- **Model switches**: the card's "Model switches" section turns individual models off, and an off model leaves the picker. It carries an instant search box plus "Show all" / "Hide all". The list covers every model, including the ones currently off, so anything switched off can be switched back on.
- **Settings card**: Settings → Plugins → Qoder shows the CLI path, sign-in method, login file, and the served models, with repair hints when not ready.
- **Per-request reasoning levels**: Qoder models carry a reasoning-effort picker (low / medium / high / xhigh / max) in the DSH model picker, applied per model and per request, the way [dsh-workbuddy-connect](https://github.com/corrinehu/dsh-workbuddy-connect) does it — a model declares its usable levels through `thinkingLevelMap`, DSH sends the picked level as `reasoning_effort`, and the plugin translates it to the CLI's `--reasoning-effort`.
- **Official price factors and per-model levels**: the plugin reads the official client's encrypted model catalog (QMC v1) and brings the vendor's `price_factor` (including off-peak promotions) and **the reasoning levels each model actually accepts** into the picker. See "The official catalog" below.
- **Global defaults on the card**: three further overrides — reasoning effort (`--reasoning-effort`), thinking mode (`--thinking`), and thinking budget (`--thinking-budget`). **A per-request level wins over the global setting**; an empty global field sends no flag at all and follows the CLI's own default.
- **Streaming and non-streaming**: `/v1/chat/completions` serves both shapes; a client disconnect or the timeout (default 600s, `QODER_TIMEOUT_MS`) kills the CLI child process.
- **Usage ledger**: each completed turn appends the CLI's own `total_credits` (the stream-json `result` record — Qoder's only real billing source) as one line in `$DSH_HOME/qoder-credits/ledger.jsonl`, which the `dsh-qoder-credits` widget reads for consumption trends, daily averages and forecasts. The write is best-effort bookkeeping: a failure costs one data point, never the conversation.

## Models

Matches `qoderclicn --list-models` (verified against CLI 1.1.59). DSH-facing ids carry a `qoder-` prefix; display names keep the CLI's own spelling:

| DSH model id | CLI `--model` |
|---|---|
| `qoder-auto` | `Auto` |
| `qoder-qwen3.8-max` | `Qwen3.8-Max` |
| `qoder-qwen3.8-flash` | `Qwen3.8-Flash` |
| `qoder-qwen3.7-max` | `Qwen3.7-Max` |
| `qoder-qwen3.7-plus` | `Qwen3.7-Plus` |
| `qoder-qwen3.7-flash` | `Qwen3.7-Flash` |
| `qoder-deepseek-v4-pro` | `DeepSeek-V4-Pro` |
| `qoder-deepseek-flash` | `DeepSeek-Flash` |
| `qoder-glm-5.3` | `GLM-5.3` |
| `qoder-glm-5.3-flash` | `GLM-5.3-Flash` |
| `qoder-glm-5.2` | `GLM-5.2` |
| `qoder-kimi-k3` | `Kimi-K3` |
| `qoder-kimi-k2.8-preview` | `Kimi-K2.8-Preview` |
| `qoder-minimax-m2.7` | `MiniMax-M2.7` |

## Install

Prerequisite: Qoder installed and `qoderclicn login` run at least once (or `QODERCN_PERSONAL_ACCESS_TOKEN` set).

```sh
# Install from GitHub (recommended)
dsh plugin --profile web add github:chilianxiao/dsh-qoder-connect
dsh web
```

Or from a local checkout (a `link:` spec pointing at the plugin directory):

```sh
dsh plugin --profile web add link:D:/dsh_web/plugins/qoder-connect
```

> **Note**: an unrelated package named `dsh-qoder-connect` exists on npm (by `masknull`) — a PAT-based implementation that has nothing to do with this repository. This plugin lives at [chilianxiao/dsh-qoder-connect](https://github.com/chilianxiao/dsh-qoder-connect); do not install it with `npm add dsh-qoder-connect`.

After installing, add `dsh-qoder-connect` to the profile's `dsh.profile.bundles` list in its `package.json` (`dsh plugin add` only runs pnpm; the bundles list is maintained by hand), then start or restart the interface.

Version compatibility: the plugin targets the DSH `0.1.6-alpha.2` API surface (`dsh-llm-pi-ai` profile fields, the `plugins.item` client slot). The settings card additionally needs the DSH 0.1.7 settings API (`configure` plus volatile fields): on 0.1.6 the card still renders but a save fails. Earlier DSH cores are untested.

## Configuration

| Setting | Default | Meaning |
|------|------|------|
| `QODERCN_CLI` | `qoderclicn` | CLI command name or absolute path |
| `QODERCN_PERSONAL_ACCESS_TOKEN` | empty | Used only when no on-disk login state exists |
| `QODER_TIMEOUT_MS` | `600000` | Overall CLI ceiling per request (ms) |
| `DSH_QODER_POLL_MS` | `30000` | Readiness sweep interval (tests/diagnostics) |
| Settings field `cli` | empty | CLI path edited beside the card; overrides the env var |
| Settings field `reasoningEffort` | empty | `--reasoning-effort`; `auto` / `none` / `low` / `medium` / `high` / `xhigh` / `max` / `ultracode` |
| Settings field `thinking` | empty | `--thinking`; `auto` / `adaptive` / `enabled` / `disabled` |
| Settings field `thinkingBudget` | empty | `--thinking-budget`, a fixed thinking token count (implies thinking enabled on the CLI side), 0–1000000 |
| Settings field `contextWindowMax` | `false` | Request the largest context window the official catalog declares (`--context-window`) |
| Settings field `hiddenModels` | `[]` | Model ids to hide from the model picker |

The PAT is read from the environment only and never persisted into settings; when an on-disk login state exists the plugin actively removes it from the child environment so the CLI cannot override the saved login with it.

## CLI

```sh
dsh plugin --profile web exec dsh-qoder-connect status    # readiness
dsh plugin --profile web exec dsh-qoder-connect doctor    # diagnostics (--json)
dsh plugin --profile web exec dsh-qoder-connect models    # model list (--json)
```

`node lib/bin.js doctor` works the same way.

## How it works

```
DSH model picker
   │  openai-completions (pi-ai)
   ▼
loopback shim (127.0.0.1, random port, /v1/models + /v1/chat/completions)
   │  one CLI spawn per request, stream-json parsed
   ▼
qoderclicn --print --output-format stream-json --model <model>
           [--reasoning-effort <level>] [--thinking <mode>] [--thinking-budget <n>]
           [--context-window <window>] [--attachment <image>…]
           -- <prompt>
```

- **The shim binds 127.0.0.1 only** and requires a loopback Host, a loopback Origin, and a per-process random bearer secret (handed to pi-ai through `resolveApiKey`); other local processes cannot forge it.
- **Model list**: one extra `--list-models` spawn at startup (20s ceiling) beyond the readiness sweep, parsing the `MODEL` header plus one name per line, deduplicated, and turned into `qoder-` + lowercased ids. Any failure (no CLI, non-zero exit, empty parse, timeout) answers null and keeps the existing roster — an empty roster would make DSH hide the whole Qoder group, which is worse than a stale one.
- **Three-tier roster degradation**: `cli` (the CLI answered just now) → `saved` (its last successful answer, persisted at `$DSH_HOME/qoder-connect/roster.json`) → `builtin` (the snapshot compiled into the plugin). The saved tier is what keeps a restart from showing the compiled snapshot while the real answer is still in flight; it is written only after a successful answer, so it can never be worse than what the CLI itself reported, and it is written through a temp file plus a rename so a crash cannot leave half a document.
- **Model switches**: `hiddenModels` is a user preference rather than a fact about Qoder, so it lives outside the roster and is not replaced by a refresh — otherwise switching a model off would silently switch it back on the next time the CLI answered. The card writes the whole set, so a batch operation is one request rather than N.
- **Image input**: image parts in the request body are decoded from their data URLs into a private temp directory for that run (`mkdtemp` under `os.tmpdir()`), passed as `--attachment <file>`, and deleted in a `finally` — including on abort and timeout. Anything that is not a data URL is skipped: a remote address is never fetched, a non-base64 payload is never guessed, and neither an oversized body nor more than 16 images is accepted. The host already applies its own per-request image budgets; this is a second, independent gate.
- **Context window**: with `contextWindowMax` on, the largest window the official catalog declares is sent as `--context-window`; off sends no flag and follows the CLI's own default. The value always comes from the catalog's `context_config` and is never computed — the CLI does not validate this flag (verified: `--context-window 999` runs), so a number nobody declared would be meaningless.
- **Streaming** forwards one OpenAI chunk per assistant text delta as the CLI emits it; **non-streaming** aggregates one `chat.completion`.
- **Multi-turn history**: the CLI takes a single one-shot prompt, so the system message becomes `--append-system-prompt` and the remaining messages are concatenated — a known limitation of the CLI surface (compare the WorkBuddy plugin, whose upstream is an HTTP API and passes the messages array through as a JSON body). **Long sessions are truncated automatically**: Windows caps a command line at 32,767 characters, so the assembled prompt is held under 24,000 — the newest messages are kept and older ones dropped, with a note at the top of the prompt saying how many were omitted, so a session dozens of turns deep still works, just without its full history. `QODER_MAX_PROMPT_CHARS` / `QODER_MAX_SYSTEM_CHARS` adjust both (clamped).
- **Usage**: the CLI reports no tokens, so usage is estimated as chars/4 (mirroring proxy-hub).
- **Context window**: the catalog's own `context_config` default tier is preferred (measured at 200000 per model); when the catalog cannot be read the plugin falls back to a conservative 262144. `maxTokens` (32768) remains this plugin's own estimate — the official catalog carries no output ceiling.

## Known limitations

- **Images must be data URLs**: that is exactly what DSH's attachment pipeline produces, so a remote `http(s)` image address is skipped rather than fetched — the plugin makes no upstream HTTP request anywhere. A skipped image degrades the turn to text instead of failing it.
- **Image-to-text pairing is implicit**: the CLI's `--attachment` hangs files off the request in order and does not record which message each belonged to. With several images interleaved in one turn the model sees "all the images plus all the text", so "image 1 goes with text 1" is not guaranteed.
- No tool-call passthrough.
- Both the model list and the official catalog are read at exactly two moments: **at startup**, and when **"Re-fetch models" is pressed on the card** (which refreshes the CLI roster and the catalog's factors/levels/windows together). There is no polling — the roster costs a CLI spawn (seconds) and the catalog file is published by the official client itself, so polling would only ever re-read the same snapshot. The readiness sweep stays a cheap local credential check every 30 seconds and triggers no fetch; the built-in fallback still has to be updated with each release, since it only ever covers a failed fetch.
- The official catalog requires **the official client to be installed and signed in on this machine** (otherwise `catalog-v6` does not exist): models still work, but the picker shows no factors or levels. If the container format changes upstream, decryption fails and falls back to the same degraded behaviour (no crash). The refresh response carries `factsCount`, which tells you whether the factors and levels really came from the official catalog.
- The catalog file is refreshed by the official client and only read here; if you never open the official client, the factors and levels stay at the last cached snapshot.
- The plugin depends on Qoder's client interface (not an official open API); Qoder updates may require adjustments.

## Verify

```sh
npm test        # node --test, 116 cases (stub CLI, no login needed)
npm run build   # tsdown
node scripts/live-chat-check.mjs qoder-qwen3.7-max   # real chat (spends one request)
```

## Disclaimer

- This project is **for personal learning and research only**. It drives your own Qoder account on your own machine; do not use it commercially or beyond reasonable personal use.
- You must comply with Qoder's terms of service; any consequence of using this project (including but not limited to account restriction, quota depletion, or service interruption) is your own responsibility.
- The authors accept no liability for any direct or indirect loss arising from use or misuse of this project.
- This project is unrelated to Qoder and DeepSeek and is not authorized or endorsed by them; names appear only to describe compatibility, and trademark rights belong to their respective owners.

## Acknowledgments

- [1416277987/proxy-hub](https://github.com/1416277987/proxy-hub) — the reference implementation of the qoder reverse proxy.
- [corrinehu/dsh-workbuddy-connect](https://github.com/corrinehu/dsh-workbuddy-connect) (MIT) — the reference for DSH plugin structure and provider registration.

## License

[MIT](./LICENSE)
