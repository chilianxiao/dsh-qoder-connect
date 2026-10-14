# DSH Qoder Connect

[English](./README.en.md) | 中文

把**本机 `qoderclicn` CLI 的登录态**包装成一个 OpenAI 兼容 Provider 接入 DeepSeek Harness：安装并登录过 Qoder 后，Qoder 的模型直接出现在 DSH 的模型选择器里，零额外配置。

反代核心移植自 [1416277987/proxy-hub](https://github.com/1416277987/proxy-hub) 的 `adapters/qoder.js`；插件结构参照 [corrinehu/dsh-workbuddy-connect](https://github.com/corrinehu/dsh-workbuddy-connect)（MIT）。

## 功能

- **开箱即用**：插件复用 `qoderclicn login` 落盘的登录态，不另起 OAuth 流程；没有上游 HTTP 请求——本机 CLI 就是上游。
- **模型分组**：Qoder 模型以「Qoder」分组出现在模型选择器中；未安装 CLI 或未登录时分组自动隐藏，登录后（无需重启 DSH）自动出现。
- **模型列表**：启动时跑一次 `qoderclicn --list-models`，之后只在设置卡片上点「重新拉取模型」时再拉，所以 **Qoder 新增模型无需更新插件就能出现在选择器里**；拉取失败则保留现有列表（上次成功结果已落盘），不会让整个分组消失，卡片上会标明当前列表来自 CLI、上次保存还是内置兜底。就绪状态由假变真时分组会**显示**出来，此时用的是上次保存的列表，点一下刷新即可换成账号的真实列表。
- **登录态自动探测**：三种布局都认——`~/.qoderworkcn/.auth-cn/user`（proxy-hub 文档布局）、`~/.qoder-cn/.auth/user`（Qoder CN CLI，实测）、`~/.qoder/.auth/user`（国际版 qodercli）；也支持环境变量 `QODERCN_PERSONAL_ACCESS_TOKEN`。
- **CLI 不在 PATH 也能用**：按 PATH → 默认安装目录（`~/.qoder-cn/bin/qoderclicn`、`~/.qoder/bin/qodercli`）顺序解析，Windows `.cmd` shim 走 shell 正确启动。
- **图片输入**：官方目录标了 `is_vl` 的模型，在选择器里声明图片能力；请求里的图片以 `--attachment` 交给 CLI，**不经过任何上游 HTTP**。只支持 data URL（DSH 附件管道给的正是这个形态），远程图片地址会被跳过而不是发起请求。
- **上下文窗口一键切换**：设置卡片提供「使用上游声明的最大窗口」开关。开启后按各模型声明的最大窗口请求（如 1M），关闭则用官方客户端默认的窗口（通常 200K）。数值**只取自官方目录声明的档位**——CLI 对 `--context-window` 不校验，凭空给一个数没有意义。
- **模型开关**：设置卡片的「模型开关」区可逐个关闭不想用的模型，关闭的即从模型选择器隐藏；带即时搜索框与「全部开启 / 全部关闭」。列表覆盖全部模型（含已关闭的），所以关掉的模型随时能开回来。
- **设置卡片**：设置 → 插件 → Qoder 卡片展示 CLI 路径、登录方式、登录态文件与可用模型，未就绪时给出修复提示。
- **模型选择器里选推理档位**：Qoder 模型在 DSH 模型选择器中带「推理等级」选项（low / medium / high / xhigh / max），按模型生效、逐次请求下发，做法与 [dsh-workbuddy-connect](https://github.com/corrinehu/dsh-workbuddy-connect) 一致——模型用 `thinkingLevelMap` 声明可用档位，DSH 把选中的档位作为 `reasoning_effort` 放进请求体，插件再翻成 CLI 的 `--reasoning-effort`。
- **模型选择器里显示官方系数与逐模型档位**：读取官方客户端缓存的加密模型目录（QMC v1），把官方 `price_factor`（含错峰促销）与**该模型真正接受的推理档位**带进选择器。详见下文「官方目录」。
- **设置卡片里可改全局默认**：设置卡片另有三项全局覆盖——推理等级（`--reasoning-effort`）、思考模式（`--thinking`）和思考预算（`--thinking-budget`）。**逐次请求的档位优先于全局设置**；全局项留空则不下发该参数、完全跟随 CLI 默认。
- **流式 / 非流式**：`/v1/chat/completions` 两种形态都支持；客户端断开或超时（默认 600s，`QODER_TIMEOUT_MS` 可调）会终止 CLI 子进程。
- **用量账本**：每次对话结束后，把 CLI 自报的 `total_credits`（stream-json `result` 记录——Qoder 唯一的真实计费来源）落盘成 `$DSH_HOME/qoder-credits/ledger.jsonl` 的一行；配合 `dsh-qoder-credits` 悬浮窗查看消耗趋势、日均与预估。账本写入是尽力而为的簿记，失败只丢一个数据点，不影响对话本身。

## 推理档位

档位值即 `--reasoning-effort` 的值，逐次请求下发——换档位不需要重启，也不影响其他会话。

| 选择器操作 | 下发 |
|---|---|
| 不选（默认） | 不下发该参数，跟随 CLI 自身默认 |
| 任一档位 | `--reasoning-effort <同名值>` |

**每个模型只显示它真正接受的档位**，取自官方目录（详见「官方目录」一节）：同名字段映射，但集合逐模型不同，且有些模型（Qwen3.7 系列、Auto、MiniMax）只有开/关、不显示档位控件。

CLI 另外还接受 `auto`、`none`、`ultracode`，但它们在 DSH 的档位刻度上没有对应位置：`auto` 就是「让 CLI 自己决定」，而不下发参数已经表达了这一点；`none`（关闭思考）会被 pi-ai 当作「每个未显式选档位的请求都发一次」的 `off` 值，写进档位表就会**默认关闭思考**。需要时用设置卡片里的全局项指定。

**⚠️ 全局设置会绕过逐模型校验**：设置卡片的「推理等级」是全局兜底，它能填 `auto` / `ultracode` 等选择器没有的值，且**会原样下发、不经该模型的档位表校验**。填了模型不支持的档位时，上游会**静默忽略并回落默认档**（不报错）。要精确控制请用模型选择器。

**档位生效的验证方式**：同一个模型同一句提示，`none` 档无 thinking 块、`max` 档产生 thinking 块且耗时更长（实测 1553ms → 2422ms）。这一点特意验过——WorkBuddy 那边实测发现「有些模型接受 `reasoning_effort` 却忽略未知值并回退到默认」，所以「请求成功」不等于「档位生效」。**这也正是逐模型档位必须来自官方目录的原因**：无法从"请求成功"反推某个档位有效。

## 模型

模型列表**运行时来自 `qoderclicn --list-models`**，所以 Qoder 新增的模型会自动出现。下面是 CLI 1.1.59 的内置兜底快照（拉取不到时使用）；DSH 里的模型 id 为 `qoder-` + 小写化的 CLI 名，显示名用 CLI 自己的拼写：

| DSH 模型 id | CLI `--model` |
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

id 的生成规则是 `qoder-` + CLI 名小写化，内置表 14 个全部符合，且实测 `--list-models` 拉到的 id 与内置表**逐字一致**——所以列表来源切换（CLI ↔ 兜底）不会让已有账本里的模型 id 失效。

**关于「短暂出现的模型」**：实测见过 CLI 把 `Fast` 列进 `--list-models`、随后又撤下（此时 `--model Fast` 会回退到 `auto`）。因此内置兜底只固化**稳定**的模型，短命条目不会被冻结在代码里、活得比 CLI 自己的提供期还长——它该由运行时拉取决定。

## 官方目录：系数、逐模型档位、上下文窗口

模型选择器里显示成 `Qwen3.8-Max · x0.2 · 错峰 4 折`、`Kimi-K3 · x1.4`、`Qwen3.8-Flash · x0 · 限时免费`。这些**全部来自 Qoder 官方目录**，插件不猜、不实测。

### 数据从哪来

官方桌面端/CLI 会把完整模型目录缓存在 `<home>/.models/<uid>/catalog-v6`，但它是 **QMC v1 加密容器**（不是 JSON），所以早期版本以为"没有可读的价目数据"。实际有公开的确定性解封装：

```
envelope = base64("QMC\x01" + nonce[12] + ciphertext || tag)
key      = HKDF-SHA256(ikm = uid, salt = "qoder-model-cache-enc", info = "model-cache-v1", 32)
cipher   = AES-256-GCM
```

`uid` 就在同目录的 `default` 文件里（明文 JSON）。**Node 内置 `crypto` 全覆盖**，零第三方依赖、零网络请求。AES-GCM 的 tag 让"uid 不对"变成可检测的失败，而不是解出乱码。

解密后取 `chat` 场景的模型，逐字段读出：

| 字段 | 用途 |
|---|---|
| `price_factor` | **抵扣系数**（官方声明值，非实测） |
| `promotion` | 错峰折扣与时段（如 `0.4` + `22:00-08:00`） |
| `is_free` / `original_price_factor` | 「限时免费」标注 |
| `thinking_config.enabled.efforts` | **该模型真正接受的推理档位** |
| `context_config` / `max_input_tokens` | 上下文窗口 |

### 为什么逐模型档位是必须的

这是修掉的一个**静默 bug**。上游对不在该模型档位表内的 `reasoning_effort` **不报错、直接忽略、回落到默认档**——实测：`DeepSeek-Flash` 传官方表外的 `medium` 返回 HTTP 200 无错误；传完全非法的 `bogus` 才致命拒绝。

所以早期"给所有模型声明 low/medium/high/xhigh/max"会让选择器接受一个**实际不生效**的档位。现在按官方目录逐模型声明：

| 模型 | 官方档位 |
|---|---|
| Qwen3.8-Max / Qwen3.8-Flash | `low` / `medium` / `xhigh` |
| DeepSeek-Flash / GLM-5.3 / Kimi-K3 / Kimi-K2.8-Preview | `low` / `high` / `max` |
| DeepSeek-V4-Pro / GLM-5.3-Flash / GLM-5.2 | `high` / `max` |
| Qwen3.7-Max / Qwen3.7-Plus / Qwen3.7-Flash / Auto / MiniMax-M2.7 | 无档位（仅开/关），**不显示档位控件** |

档位与 `--reasoning-effort` 同名，所以声明的值就是上线值。

### 曾经走过的弯路（保留作为记录）

在发现这个容器之前，插件曾用**本机账本实测**反推系数（`credits` 均值之比，基准取调用最多的模型）。那套东西**已删除**，因为它不只是覆盖率低，**数值本身就是错的**：

- 覆盖：14 个模型只有 2 个能出数字（其余没调用过、样本不足、或计 0 积分无法做除数）
- 精度：同样 31 字符的两次 `Qwen3.7-Max` 调用计 7.43 与 0.61 积分（**差 12 倍**）——真实消耗主要由输出长度和思考深度决定，而 CLI 的 usage 里这两个字段恒为 0

对照官方值更能看出偏差有多大：`DeepSeek-Flash ÷ Qwen3.7-Max` 官方是 `0.1/0.5 = 0.20`，实测反推得到 **0.0082**，**偏了约 24 倍**。

**教训**：拿不到声明值时的"实测替代"如果混入了未受控变量，得到的不是近似值而是错值；宁可先不显示。

### 读不到时会怎样

`catalog-v6` 不存在、格式变化、解密失败、`chat` 场景为空——全部返回 `null`，此时：

- 模型**照常服务**，名称退回纯 CLI 拼写
- **不声明任何推理档位**（而不是声明一套可能无效的）
- 上下文窗口退回保守默认 `262144`

即"少显示"而不是"显示错的"。目录文件由官方客户端自己刷新，插件只在**启动时**和**设置卡片点「重新拉取模型」**时读一次，没有定时轮询——轮询也只会重复读到客户端已经决定发布的同一个快照。

## 安装

前置：已安装 Qoder 并至少执行过一次 `qoderclicn login`（或设置 `QODERCN_PERSONAL_ACCESS_TOKEN`）。

```sh
# 从 GitHub 安装（推荐）
dsh plugin --profile web add github:chilianxiao/dsh-qoder-connect
dsh web
```

或从本地源码安装（link: 指向插件目录）：

```sh
dsh plugin --profile web add link:D:/dsh_web/plugins/qoder-connect
```

> **注意**：npm 上另有一个同名的 `dsh-qoder-connect` 包（作者 masknull），那是基于 PAT 的另一套实现，与本仓库无关。本插件的仓库是 [chilianxiao/dsh-qoder-connect](https://github.com/chilianxiao/dsh-qoder-connect)，请勿用 `npm add dsh-qoder-connect` 安装本插件。

安装后把 `dsh-qoder-connect` 加入 profile `package.json` 的 `dsh.profile.bundles` 列表（`dsh plugin add` 只负责 pnpm 装包，bundles 列表需手动维护），然后启动/重启对应界面。

版本对应：插件按 DSH `0.1.6-alpha.2` 的接口编写（`dsh-llm-pi-ai` 的 profile 字段、`plugins.item` 客户端插槽）；更早的 DSH 核心未经验证。

## 配置

| 配置 | 默认 | 说明 |
|------|------|------|
| `QODERCN_CLI` | `qoderclicn` | CLI 命令名或完整路径 |
| `QODERCN_PERSONAL_ACCESS_TOKEN` | 空 | 仅在没有落盘登录态时使用 |
| `QODER_TIMEOUT_MS` | `600000` | 单次请求的 CLI 总超时（ms） |
| `DSH_QODER_POLL_MS` | `30000` | 就绪状态轮询间隔（测试/排查用） |
| 设置项 `cli` | 空 | 在设置卡片同页编辑 CLI 路径，覆盖环境变量 |
| 设置项 `reasoningEffort` | 空 | `--reasoning-effort`，可选 `auto` / `none` / `low` / `medium` / `high` / `xhigh` / `max` / `ultracode` |
| 设置项 `thinking` | 空 | `--thinking`，可选 `auto` / `adaptive` / `enabled` / `disabled` |
| 设置项 `thinkingBudget` | 空 | `--thinking-budget` 固定思考 token 数（CLI 侧隐含开启 thinking），0–1000000 |
| 设置项 `contextWindowMax` | `false` | 按官方目录声明的最大上下文窗口请求（`--context-window`） |
| 设置项 `hiddenModels` | `[]` | 要从模型选择器隐藏的模型 id 列表 |

推理三项都在设置卡片的「推理设置」区编辑，写入插件自己的 `qoder` 设置命名空间因而持久化；留空表示不下发该参数，跟随 CLI 自身默认。它们是**全局兜底**：模型选择器里选的档位优先于 `reasoningEffort`。取值按 CLI 1.1.59 实测的可选列表校验——**非法值会被 CLI 直接判为致命错误并终止本次请求**（`Invalid reasoning effort: ...`），所以写入前在插件侧就拒掉。

PAT 只从环境变量读取、不落盘到 settings——有落盘登录态时插件还会主动把它从子进程环境里移除，避免 CLI 用它覆盖已保存登录。

## 命令行

```sh
dsh plugin --profile web exec dsh-qoder-connect status    # 就绪状态
dsh plugin --profile web exec dsh-qoder-connect doctor    # 环境诊断（--json）
dsh plugin --profile web exec dsh-qoder-connect models    # 模型清单（--json）
```

也可以直接 `node lib/bin.js doctor`。

## 工作原理

```
DSH 模型选择器
   │  openai-completions（pi-ai）
   ▼
loopback shim（127.0.0.1 随机端口，/v1/models + /v1/chat/completions）
   │  每请求 spawn 一次 CLI，解析 stream-json
   ▼
qoderclicn --print --output-format stream-json --model <模型>
           [--reasoning-effort <级别>] [--thinking <模式>] [--thinking-budget <n>]
           [--context-window <窗口>] [--attachment <图片>…]
           -- <prompt>
```

- **shim 只绑 127.0.0.1**，且要求请求带 loopback Host、loopback Origin 和每进程随机的 Bearer 密钥（pi-ai 通过 `resolveApiKey` 拿到它）；本地其他进程无法冒用。
- **模型列表**：启动时就绪轮询之外**单独**跑一次 `--list-models`（超时 20s），解析「`MODEL` 表头 + 每行一个名字」，去重后按 `qoder-` + 小写名生成 id 替换目录；就绪状态由假变真时（例如刚 login）再跑一次。任何失败（无 CLI、非零退出、解析为空、超时）都返回 null 并保留现有列表——目录为空会让 DSH 把整个 Qoder 分组从选择器里隐藏，比列表过期更糟。
- **模型名带官方系数**：`Model.name` = CLI 拼写 + 官方 `price_factor`（+ 促销徽标），`Model.id` 保持小写化 id 不变——id 是上线请求与账本的主键，装饰它会同时破坏两者。读不到官方目录时名称退回纯 CLI 拼写。
- **官方目录**：启动时读一次 `<home>/.models/<uid>/catalog-v6`，用 HKDF-SHA256 + AES-256-GCM（Node 内置 `crypto`）解出 `chat` 场景，得到逐模型的 `price_factor`、`thinking_config` 档位表与上下文窗口。之后只在设置卡片点「重新拉取模型」时随模型列表一起重读，**无定时轮询**；内容有变才重建模型目录。
- **模型列表三级降级**：`cli`（本次 CLI 实答）→ `saved`（上次成功实答，落盘在 `$DSH_HOME/qoder-connect/roster.json`）→ `builtin`（编译进插件的快照）。落盘的那一层是重启后不再退回内置表的原因：写只在实答成功后发生，所以它永远不会比 CLI 自己报过的更差；写走临时文件 + rename，崩溃不会留下半截文档。
- **模型开关**：`hiddenModels` 是用户偏好而不是 Qoder 事实，所以它**不在**名单里、也不随刷新被替换——否则关掉一个模型后 CLI 一应答就自动开回来了。卡片写的是整个集合，一次请求搞定批量操作。
- **图片输入**：请求体里的图片 part 解出 data URL，落成本次运行私有的临时文件（`os.tmpdir()` 下 mkdtemp），以 `--attachment <文件>` 传给 CLI，运行结束（含中断/超时）即在 `finally` 里删掉。data URL 之外一律跳过：远程地址不发起请求，非 base64 不猜，超过 8MB 或超过 16 张不要——宿主本身已有每请求图片预算，这里是第二道独立闸门。
- **上下文窗口**：`contextWindowMax` 开启时按官方目录声明的最大窗口下发 `--context-window`，关闭则不下发该参数、跟随 CLI 自己的默认档。数值永远来自目录的 `context_config`，绝不计算——CLI 对这个参数不校验（实测 `--context-window 999` 也照跑），给一个没人声明过的数没有意义。
- **流式**：CLI 每输出一个 `assistant` 文本增量，shim 立即转发一个 OpenAI chunk；**非流式**：聚合成一个 `chat.completion`。
- **多轮历史**：CLI 只有一次性 prompt，插件把 system 提为 `--append-system-prompt`、其余消息拼接成一段——这是 CLI 表面的已知限制（对比：WorkBuddy 插件的上游是 HTTP API，messages 数组作为 JSON body 原生透传，没有这个问题）。**长会话自动截断**：Windows 命令行上限 32,767 字符，插件把拼出的 prompt 限制在 24,000 字符内——保留最新的消息、丢弃更早的，并在 prompt 开头注明"较早的 N 条消息已省略"，所以几十轮后的老会话也能用，只是模型看不到全部历史。`QODER_MAX_PROMPT_CHARS` / `QODER_MAX_SYSTEM_CHARS` 可调（均有钳制）。
- **用量**：CLI 不上报 token，按 chars/4 估算（与 proxy-hub 一致）。
- **上下文窗口**：优先用官方目录的 `context_config` 默认档（实测各模型为 200000）；读不到目录时退回保守默认 262144。`maxTokens`（32768）仍是本插件自己的估计——官方目录没有输出上限字段。

## 已知限制

- **图片只能来自 data URL**：DSH 附件管道给的正是这个形态，所以远程 `http(s)` 图片地址会被跳过而不发起请求——插件全程没有上游 HTTP。跳过的图片不会让整轮失败，只会退化成纯文本。
- **多图与文本的对应关系是隐式的**：CLI 的 `--attachment` 只按顺序挂文件，不记录它属于哪条消息。同一轮里穿插多张图时，模型看到的是「全部图片 + 全部文本」，无法保证「图1 配 文1」。
- 无工具调用透传。
- 模型列表与官方目录都只在两个时机读取：**启动时**、以及**设置卡片上点「重新拉取模型」**（一次同时刷新 CLI 模型列表和官方目录的系数/档位/窗口）。没有定时轮询——模型列表要 spawn 一次 CLI（数秒），而官方目录文件由官方客户端自己发布，轮询只会重复读到同一个快照。就绪轮询仍是 30 秒一次的轻量本地凭证检查，但不触发任何拉取；内置兜底表仍需在发版时随 CLI 更新，它只在拉取失败时兜底。
- 官方目录依赖**本机装了官方客户端并登录过**（否则 `catalog-v6` 不存在）：此时模型照常可用，但选择器里没有系数与档位。容器格式若被官方修改，解密会失败并回退到上述降级行为（不会崩）。刷新响应里带回 `factsCount`，可以据此判断系数与档位是否真的来自官方目录。
- 目录文件由官方客户端刷新，插件只读；若你长期不开官方客户端，系数与档位会停留在上次缓存的快照。
- 依赖 Qoder 客户端接口（非官方开放 API），Qoder 更新后插件可能需要随之调整。

## 验证

```sh
npm test        # node --test，116 个用例（stub CLI，无需登录）
npm run build   # tsdown
node scripts/live-chat-check.mjs qoder-qwen3.7-max   # 真实对话（消耗一次请求）
```

## 免责声明

- 本项目**仅供个人学习和研究使用**，仅驱动使用者自己的 Qoder 账号在本机调用，请勿用于商业用途或超出个人合理使用的场景。
- 使用者需遵守 Qoder 的服务条款；因使用本项目产生的任何后果（包括但不限于账号被限制、额度被清空、服务中断），由使用者自行承担。
- 本项目作者不对任何因使用或滥用本项目产生的直接或间接损失负责。
- 本项目与 Qoder、DeepSeek 均无关联，未获其授权或认可；文中出现的名称仅用于描述兼容关系，其商标权利归各自所有。

## 致谢

- [1416277987/proxy-hub](https://github.com/1416277987/proxy-hub) — qoder 反代的参照实现。
- [corrinehu/dsh-workbuddy-connect](https://github.com/corrinehu/dsh-workbuddy-connect)（MIT）— DSH 插件结构与 provider 注册的参照。

## 许可证

[MIT](./LICENSE)
