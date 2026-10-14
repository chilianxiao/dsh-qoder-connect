/** Locale copy for the Qoder plugin card (zh / en). */

export interface QoderSettingsCopy {
  title: string
  intro: string
  ready: string
  notReady: string
  cli: string
  login: string
  loginOauth: string
  loginPat: string
  loginNone: string
  oauthFile: string
  models: string
  refresh: string
  refreshing: string
  hintCli: string
  hintLogin: string
  statusResponseInvalid: string
  requestFailed: string
  reasoning: string
  effort: string
  thinking: string
  thinkingBudget: string
  reasoningDefault: string
  reasoningHint: string
  save: string
  saving: string
  saved: string
  reset: string
  rosterCli: string
  rosterSaved: string
  rosterBuiltin: string
  contextWindow: string
  contextWindowMax: string
  contextWindowHint: string
  switchOn: string
  switchOff: string
  modelSwitches: string
  modelSwitchesHint: string
  modelSearch: string
  showAll: string
  hideAll: string
  noModelMatch: string
  refreshModels: string
  refreshingModels: string
}

/** Keys the card may translate. */
export type QoderSettingsKey = keyof QoderSettingsCopy

export const zh: QoderSettingsCopy = {
  title: 'Qoder',
  intro: '把本机 qoderclicn CLI 的登录态接入 DSH：安装并登录 Qoder 后即可在模型选择器里使用。',
  ready: '就绪',
  notReady: '未就绪',
  cli: 'CLI',
  login: '登录方式',
  loginOauth: 'qoderclicn login 落盘登录态',
  loginPat: 'QODERCN_PERSONAL_ACCESS_TOKEN',
  loginNone: '未登录',
  oauthFile: '登录态文件',
  models: '可用模型',
  refresh: '刷新',
  refreshing: '刷新中…',
  hintCli: '未找到 Qoder CLI：请安装 Qoder，或在设置里指定 CLI 路径（QODERCN_CLI）。',
  hintLogin: '尚未登录：请执行 qoderclicn login，或设置环境变量 QODERCN_PERSONAL_ACCESS_TOKEN。',
  statusResponseInvalid: '状态响应格式无法识别',
  requestFailed: '请求失败',
  reasoning: '推理设置',
  effort: '推理等级',
  thinking: '思考模式',
  thinkingBudget: '思考预算 (tokens)',
  reasoningDefault: '跟随 CLI 默认',
  reasoningHint: '这三项会作为 --reasoning-effort / --thinking / --thinking-budget 传给 qoderclicn，对之后的所有对话生效。留空则不下发该参数。',
  save: '保存',
  saving: '保存中…',
  saved: '已保存',
  reset: '恢复默认',
  rosterCli: '来自 qoderclicn --list-models（Qoder 新增模型会自动出现）',
  rosterSaved: '上次成功拉取的列表已保存到本机（本次 CLI 未响应，重启后不会退回内置列表）',
  rosterBuiltin: '内置列表（未能从 CLI 拉取，Qoder 新加的模型可能不在此列）',
  contextWindow: '上下文窗口',
  contextWindowMax: '使用上游声明的最大窗口',
  contextWindowHint: '开启后按各模型声明的最大窗口请求（如 1M），关闭则用官方客户端默认的窗口（通常 200K）。数值取自官方目录，只在其声明的档位间切换。',
  switchOn: '已开启',
  switchOff: '已关闭',
  modelSwitches: '模型开关',
  modelSwitchesHint: '关闭的模型不会出现在模型选择器里。列表来自 CLI 拉取结果，Qoder 新增的模型默认开启。',
  modelSearch: '搜索模型',
  showAll: '全部开启',
  hideAll: '全部关闭',
  noModelMatch: '没有匹配的模型',
  refreshModels: '重新拉取模型',
  refreshingModels: '拉取中…',
}

export const en: QoderSettingsCopy = {
  title: 'Qoder',
  intro: 'Brings your local qoderclicn CLI login into DSH: install and sign in to Qoder, then pick a Qoder model.',
  ready: 'Ready',
  notReady: 'Not ready',
  cli: 'CLI',
  login: 'Sign-in',
  loginOauth: 'qoderclicn login on-disk state',
  loginPat: 'QODERCN_PERSONAL_ACCESS_TOKEN',
  loginNone: 'Not signed in',
  oauthFile: 'Login file',
  models: 'Models',
  refresh: 'Refresh',
  refreshing: 'Refreshing…',
  hintCli: 'Qoder CLI not found: install Qoder, or point the CLI path at it in settings (QODERCN_CLI).',
  hintLogin: 'Not signed in: run qoderclicn login once, or set QODERCN_PERSONAL_ACCESS_TOKEN.',
  statusResponseInvalid: 'status response was not recognized',
  requestFailed: 'request failed',
  reasoning: 'Reasoning',
  effort: 'Reasoning effort',
  thinking: 'Thinking mode',
  thinkingBudget: 'Thinking budget (tokens)',
  reasoningDefault: 'Follow the CLI default',
  reasoningHint: 'Passed to qoderclicn as --reasoning-effort / --thinking / --thinking-budget for every later run. Empty sends no flag.',
  save: 'Save',
  saving: 'Saving…',
  saved: 'Saved',
  reset: 'Reset to default',
  rosterCli: 'From qoderclicn --list-models (models Qoder adds appear automatically)',
  rosterSaved: 'Saved from the last successful fetch on this machine (the CLI did not answer this time, so a restart will not fall back to the built-in list)',
  rosterBuiltin: 'Built-in list (could not read the CLI, so newly added models may be missing)',
  contextWindow: 'Context window',
  contextWindowMax: 'Use the upstream-declared maximum',
  contextWindowHint: 'On requests the largest window each model declares (e.g. 1M); off uses the window the official client picks by default (usually 200K). The number always comes from the official catalog, so only declared tiers are ever sent.',
  switchOn: 'On',
  switchOff: 'Off',
  modelSwitches: 'Model switches',
  modelSwitchesHint: 'A switched-off model never appears in the model picker. The list comes from the CLI, so a model Qoder adds later starts switched on.',
  modelSearch: 'Search models',
  showAll: 'Show all',
  hideAll: 'Hide all',
  noModelMatch: 'No matching models',
  refreshModels: 'Re-fetch models',
  refreshingModels: 'Fetching…',
}
