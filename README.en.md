# DSH Qoder Connect

[中文](./README.md) | English

Wraps your **local `qoderclicn` CLI login** as an OpenAI-compatible provider inside DeepSeek Harness: once Qoder is installed and you have signed in with `qoderclicn login`, Qoder's models appear in the DSH model picker with zero extra configuration.

The reverse-proxy core is ported from [1416277987/proxy-hub](https://github.com/1416277987/proxy-hub)'s `adapters/qoder.js`; the plugin structure follows [corrinehu/dsh-workbuddy-connect](https://github.com/corrinehu/dsh-workbuddy-connect) (MIT).

## Features

- **Zero configuration**: the plugin reuses the on-disk login state written by `qoderclicn login` and starts no OAuth flow of its own. There is no upstream HTTP request anywhere — the local CLI is the upstream.
- **Model group**: Qoder models appear as a "Qoder" group in the model picker. The group hides itself while the CLI is missing or nobody is signed in, and appears (without restarting DSH) once a login lands.
- **Login detection**: three layouts are recognized — `~/.qoderworkcn/.auth-cn/user` (the layout proxy-hub documents), `~/.qoder-cn/.auth/user` (Qoder CN CLI, verified), and `~/.qoder/.auth/user` (international qodercli). `QODERCN_PERSONAL_ACCESS_TOKEN` is honored as well.
- **Works off PATH**: the CLI is resolved through PATH first, then the well-known install dirs (`~/.qoder-cn/bin/qoderclicn`, `~/.qoder/bin/qodercli`); Windows `.cmd` shims are started through the shell correctly.
- **Settings card**: Settings → Plugins → Qoder shows the CLI path, sign-in method, login file, and the served models, with repair hints when not ready.
- **Streaming and non-streaming**: `/v1/chat/completions` serves both shapes; a client disconnect or the timeout (default 600s, `QODER_TIMEOUT_MS`) kills the CLI child process.

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

Version compatibility: the plugin targets the DSH `0.1.6-alpha.2` API surface (`dsh-llm-pi-ai` profile fields, the `plugins.item` client slot). Earlier DSH cores are untested.

## Configuration

| Setting | Default | Meaning |
|------|------|------|
| `QODERCN_CLI` | `qoderclicn` | CLI command name or absolute path |
| `QODERCN_PERSONAL_ACCESS_TOKEN` | empty | Used only when no on-disk login state exists |
| `QODER_TIMEOUT_MS` | `600000` | Overall CLI ceiling per request (ms) |
| `DSH_QODER_POLL_MS` | `30000` | Readiness sweep interval (tests/diagnostics) |
| Settings field `cli` | empty | CLI path edited beside the card; overrides the env var |

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
qoderclicn --print --output-format stream-json --model <model> -- <prompt>
```

- **The shim binds 127.0.0.1 only** and requires a loopback Host, a loopback Origin, and a per-process random bearer secret (handed to pi-ai through `resolveApiKey`); other local processes cannot forge it.
- **Streaming** forwards one OpenAI chunk per assistant text delta as the CLI emits it; **non-streaming** aggregates one `chat.completion`.
- **Multi-turn history**: the CLI takes a single one-shot prompt, so the system message becomes `--append-system-prompt` and the remaining messages are concatenated — a known limitation of the CLI surface.
- **Usage**: the CLI reports no tokens, so usage is estimated as chars/4 (mirroring proxy-hub).
- **Context window**: the CLI declares none; the plugin uses conservative defaults (262144 / 32768) purely for ordering and compaction, never as request caps.

## Known limitations

- Text only: the CLI prompt is a single argv string, so image input is never sent (models are described as text-only).
- No tool-call passthrough and no reasoning-effort control (the CLI surface offers neither).
- The model list is static, verified against CLI 1.1.59; a CLI upgrade that adds or drops models needs `QODER_MODELS` in `src/qoder.ts` updated.
- The plugin depends on Qoder's client interface (not an official open API); Qoder updates may require adjustments.

## Verify

```sh
npm test        # node --test, 20 cases (stub CLI, no login needed)
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
