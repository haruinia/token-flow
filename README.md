# token-flowb

面向 Codex、Claude Code 和 OpenAI 兼容 Agent 的本地模型网关。认证各厂商账号，统一模型目录与 Responses API，再适配不同 Agent 的调用协议；以独立客户端 Key 管理共享权限。原有浏览器任务作为辅助调试工具保留。

## A2A 点选接入与网关维修

首页只显示有效且有可用模型的授权，按剩余额度降序排列（多个窗口取最低剩余比例，未知额度排最后）。点击源账号直接弹出模型列表；“登录其他 Agent”进入模型中心，新授权完成后自动返回。顶部可直接指定维修师傅。目标正在运行时，确认一次即可备份并写入，完成后提示重启，详细配置与额度收在展开项中。

启动后默认进入 **A2A 接入**：点亮源账号授权 → 选择该账号支持的模型 → 选择 Codex、Claude Code 或 WorkBuddy → 备份并接入。目标 Agent 下次启动时使用所选模型，Responses、Messages 与 Chat Completions 的转换在后台完成。源账号被停用、失效或删除时拒绝调用，不会自动借用另一个账号。

启动网关后自动读取 `CODEX_HOME/auth.json`（默认 `~/.codex/auth.json`）或 `CLAUDE_CONFIG_DIR/.credentials.json`（默认 `~/.claude/.credentials.json`）中的 OAuth 副本（已存在的网关凭据不会被覆盖）；不读取系统钥匙串，钥匙串登录可在模型中心重新授权。同时尝试 WorkBuddy、ZCode、Doubao、Trae 已有的本地导入适配器；提供商已有池内账号时跳过自动导入，避免旧副本覆盖续期凭据。原登录文件不被修改；副本的续期由网关管理。厂商撤销登录或刷新令牌轮换仍可能要求重新授权，不能保证共享会话永久有效。

直接接入修改用户级 `config.toml` / `settings.json` / WorkBuddy `models.json`，保留其他设置、原 Provider 和完整原文件备份。Codex 的当前 profile 暂时取消选择，原 profile 内容保留；完整还原恢复原文件。自动生成仅支持目标协议和所选源账号模型的客户端 Key，可设置 token 额度。此 Key 写入权限为 0600 的目标配置，原厂商 OAuth 凭据不写入目标 Agent。WorkBuddy 只新增自定义模型，保留原模型、账号登录与额度；重启后在模型菜单选择新增项。文件位置遵循 `WORKBUDDY_CONFIG_DIR` / `CODEBUDDY_CONFIG_DIR`，默认 `~/.workbuddy/models.json`。OpenAI 兼容的其他应用仍通过手动接入配置使用。

Cursor 暂不提供本机直连接入。模型中心现通过官方 SDK 独立授权，提供 `cursor/<官方模型 ID>` 的实验性文本 API；并不等同于 IDE 订阅的原始模型接口。其 BYOK 请求经过 Cursor 云端，不能访问本机 loopback；因此当前本机网关产品不展示 Cursor 接入目标。参见 [Cursor 官方说明](https://prod.cursor.com/help/models-and-usage/api-keys) 和 [WorkBuddy 自定义模型](https://www.workbuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Model)。

备份位于数据目录 `agent-backups/`（含完整配置，按敏感文件保管）。先持久化预备记录，再原子替换配置。检查进程、配置指纹、符号链接和并发操作锁；已运行的 Agent 不会被终止；用户确认后可写入接入设置并在完成后重启。外部修改不会被自动覆盖。还原后撤销接入 Key。若异常退出留下锁，需先确认没有配置操作，再人工处理锁文件。进程检查是保守快照，不能阻止外部应用在检查后启动；项目配置、命令行参数、环境变量和组织策略可能覆盖用户级设置。

选择维修模型后自动通过 Pi 的 Responses 适配器发起一次短文本检测；重启应用并加载本地授权后检测一次，不随页面轮询重复调用。只有真实响应通过才显示“已就位”，界面保留检测时间和重新检测入口。此检查消耗少量模型额度，不等于已验证所有维修工具能力。调用失败按授权、额度、网络或响应格式分类，不回显上游凭据；失败后的下一次提问使用新模型上下文，相同工具检查重复超过两次停止本轮。

Qoder IDE 作为目标时使用官方 Settings → Models → Add → OpenAI Compatible → Responses，需在 Qoder 中“验证并添加”后选择模型。本应用提供限定源账号与模型的 Key 和接入参数，尚不自动写入 Qoder 配置。CLI 使用 `/model → Custom` 官方向导，不手写其 `settings.json`。

**任务调试 → 网关维修** 可独立选择源授权与模型。维修模型由 Pi Agent Core 驱动，通过本机 Responses 接口调用，查看网关和接入元数据、刷新账号模型，以及修复未完成写入、还原原接口；每次任务的配置修改由界面显式授权，所有写入仍经过同一套冲突检查。此功能复用本地 Agent 的授权，通过内置工具执行，不启动任意 CLI 或开放通用 shell。网关离线时模型维修不可用，A2A 的本地还原仍可使用。原浏览器任务位于同页的另一标签。

本轮验收：类型检查、构建、A2A 源码及打包版桌面检查通过；全量 Vitest 114/115 通过，原有 Chrome 扩展连接测试超时，独立复测仍超时，未标记全量通过。原浏览器任务桌面回归通过。

验证：`node scripts/a2a-smoke.mjs` 使用隔离目录实际写入与还原配置，进程快照在测试引导中模拟；`node scripts/test-sidecar-pin.mjs` 验证真实 Go 路由元数据；其他测试覆盖凭据固定、权限、配置冲突、维修工具与未授权还原。不会修改用户真实 Agent 配置或发起真实付费请求。

配置字段依据 [Codex 配置参考](https://developers.openai.com/codex/config-reference) 和 [Claude Code 设置](https://code.claude.com/docs/en/settings)。自编译 sidecar 请运行 `npm run sidecar:build`，以包含 A2A 凭据固定和 Qoder 协议转换 overlay，再运行 `npm run package`。替换已运行应用后，需要完全退出并重新打开，以加载新网关进程。

Qoder / WorkBuddy 使用同一 Responses 中间层：目标 Agent 请求 → Responses 请求 → 源协议；源事件 → Responses 事件 → 目标协议。转换在进程内完成，不再向自身接口发起第二次推理；Key 鉴权、固定源账号、用量结算仍只执行一次。`/v1/responses` 直接输出该层，Claude Code 使用 `/v1/messages` 适配输出。其他来源仍沿用原执行器，不能据此宣称全部来源已验证互通。

`npm run test:sidecar-agents`（旧命令 `test:sidecar-qoder` 仍可用）覆盖这两个真实执行器的流式 Messages、非流式回退、工具调用、系统提示和工具结果保留、Responses 格式、取消与异常流。上游网络使用 fixture，不消耗额度。需真实验证时，显式运行 `npx tsx scripts/source-live-smoke.ts --live workbuddy` 或 `--live qoder`，也可继续传入模型 ID、auth 目录、Claude 可执行文件路径。会使用少量额度，验证公开 Responses / Messages 接口，以及真实 Claude Code 两轮流式请求、读取临时文件并回传工具结果。测试只在隔离目录复制访问令牌，不复制或刷新共享 refresh token，不修改原 Agent 配置，并在结束后清理。默认授权目录为 macOS 的 `desktop-browser-agent/cliproxy/auth`。

## 界面与桌面应用（2026-09-22）

A2A 为默认首页，API 总览：显示网关状态、已启用账号、可用模型、客户端 Key，以及本次运行的调用与上游报告 token 用量。主导航为 API 总览、模型中心、Agent 接入、API Keys；任务调试和执行历史位于辅助工具。沿用 AIHub 浅色蓝色视觉与原创汇流 Logo。

macOS 应用使用融合标题栏和原创 Dock 图标，启动时加载完成后显示窗口。最新本机应用为 `release/mac-arm64/token-flowb.app`，需退出旧实例后重新打开此路径。当前为未签名开发包；Windows 名称和图标配置已更新，本轮未重新生成 Windows 包。更名后自动沿用已有的 `Browser Agent` / `desktop-browser-agent` 数据目录（按打包 / 源码运行模式优先选择）；首次使用时创建 `token-flowb` 目录，`AGENT_DATA_ROOT` 仍可覆盖。保留原 bundle ID 以延续应用身份。执行历史支持关键词与状态筛选。

运行 `node scripts/gateway-smoke.mjs` 验证 API 首页、三类 Agent 配置、认证、本地 fixture 请求、用量显示、Key 额度耗尽拦截、编辑与重置；加 `--packaged` 验证打包版本。`npm run test:design` 验证辅助页面在 390、768、1320 像素下的布局、示例草稿、设置 / 回放开关与 renderer 隔离；`node scripts/design-smoke.mjs --packaged` 验证打包应用。新版截图见 [API 总览](artifacts/gateway/overview.png) 和 [Agent 接入](artifacts/gateway/agents.png)（测试数据）。

## 本机交付

当前 macOS ARM64 应用目录包：`release/mac-arm64/token-flowb.app`，可在 Finder 打开。它是未签名的开发版本，不是对外发布安装包。工作台截图见 [desktop-smoke.png](artifacts/desktop-smoke.png)，账号页面见 [local-agent-accounts.png](artifacts/local-agent-accounts.png)（均为测试数据）。

此前版本本机验收已通过：类型检查、构建、108 项自动化测试，以及源码启动和打包后 `.app` 两种 Electron 端到端测试。端到端流程使用本机模拟 Provider 发起 10 次 Responses 请求，直接执行代码、真实 Chromium 表单填写、人工接管与继续，生成 4 张截图和 Replay。真实 CLIProxyAPI 的启动、鉴权、授权会话生成/取消和停止另有集成测试；源码和打包应用均通过账号页面端到端测试，覆盖自动回调、手动补交、取消重试、账号启停、模型选择和重启恢复。用户已连接真实账号；Antigravity 真实文本请求曾成功，图片调用仍受上游网络故障影响，详见设计文档第 0 节。

## 启动

需要 Node.js 22.12+、Go 1.26+（仅编译 CLIProxyAPI 时需要）。

```bash
npm ci
node scripts/fetch-upstream.mjs
npm run sidecar:build
npm run browser:install
npm run dev
```

Electron 下载连接失败时，可使用 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm ci`。已经构建后直接 `npm start`。

1. 桌面应用启动时自动启动本机网关，读取已有账号及模型，后台查询额度。在 **模型中心 → 账号与模型** 按提供商查看登录、额度和模型卡片；连接账号后在官方页面完成授权。支持设备码和回调流程，凭据保存在本机。
2. 在 **API Keys** 为每个 Agent 创建独立 Key，选择允许接入的 Agent 协议，按提供商与模型授权，并设置累计 token 额度。留空不限额，0 禁止生成；编辑额度不会清零已用量。
3. 在 **Agent 接入** 选择 Codex、Claude Code 或 OpenAI 兼容 Agent，再选择 Key 和已授权模型，复制配置。配置使用 Key 占位符，需替换为创建时保存的完整值；不会自动覆写用户的 Agent 配置文件。
4. 「验证 Key」只读取模型目录，不产生模型调用。「发送测试请求」会调用选中协议并消耗少量模型额度。
5. 在 **API 总览** 查看真实调用。统计限于本次运行，保留最近 100 条元数据；不记录提示词、返回文本或密钥。未返回 usage 的调用用量显示未知，不估算余额，也不把不同厂商额度相加。

Codex 使用 `/v1/responses`，提供 HTTP / SSE 和 `/v1/responses/compact`；生成配置关闭 WebSocket。Claude Code 使用 `/v1/messages` 和 `/v1/messages/count_tokens`，接受 Bearer 或 `x-api-key`，两个头同时出现且不同则拒绝。OpenAI 兼容 Agent 使用 `/v1/chat/completions` 或 Responses。工具调用、流式事件与各厂商请求格式转换由内置 CLIProxyAPI 实现，桌面服务提供统一授权、命名空间和流量记录，不额外串联一轮模型请求。

客户端配置参考 [Codex 官方配置](https://developers.openai.com/codex/config-reference) 和 [Claude Code 官方网关文档](https://code.claude.com/docs/en/llm-gateway)。适配协议不意味着所有模型具有相同的工具、图片、推理能力；实际兼容性取决于模型和上游服务。当前提供本机访问，不包含跨设备共享、余额交易或额度结算。

原浏览器任务入口保留在 **辅助工具 → 任务调试**。需要先在模型中心的接口与能力页配置并探测任务模型，再打开任务浏览器和执行任务；人工接管、截图与 Replay 逻辑保持可用。

## P0 本机 API

桌面 App 与独立服务默认监听 `127.0.0.1:9527`，工作台使用 HttpOnly 本机会话。供外部 AI 客户端调用的稳定服务使用：

```bash
npm run build
npm run serve
```

数据目录 `.data/`，工作台 Bearer Token 文件 `.data/api-token`（0600）。`AGENT_DATA_ROOT`、`AGENT_PORT`、`AGENT_API_TOKEN` 可覆盖这些值；`AGENT_HEADLESS=1` 用于自动化测试。独立服务的外部 Provider Key 从 `OPENAI_API_KEY` / `CUSTOM_API_KEY` 环境变量加载，通过 API 设置的 Key 仅在内存中保存。Local Agent 的模型接口密钥写入 `.data/cliproxy-api-key`（可用 `AGENT_CLIPROXY_KEY` 覆盖），与工作台 `api-token` 不是同一把。

所有 `/api/*` 和 `/v1/*` 请求均要求 `Authorization: Bearer <token>`。请求 JSON，不启用任意网页跨域访问。

| 方法 / 路径 | 功能 |
| --- | --- |
| GET `/health` | 健康状态（不需要 Token） |
| GET / PUT `/api/settings` | 读取/保存 Provider；读取只返回 `hasKey` |
| GET `/api/providers/models` | 获取真实模型列表 |
| POST `/api/providers/probe` | 探测 Responses、工具调用/回传、续接、图片、reasoning |
| GET `/api/local-agent` | Sidecar 状态与经过筛选的生命周期日志 |
| GET / PUT `/api/local-agent/gateway` | 本机 OpenAI 兼容接口：`{baseURL, apiKey, running}`；PUT `{apiKey}` 保存或留空重新生成，正在运行时会重启 sidecar |
| POST `/api/local-agent/start` / `stop` / `restart` | 受管 CLIProxyAPI 生命周期 |
| POST `/api/local-agent/codex` / `claude` / `antigravity` / `kimi` / `xai` | 自动启动服务并生成官方 OAuth 会话，桌面端自动打开浏览器；响应 `login.flow` 为 `callback` 或 `device`，设备码流程附带 `login.userCode` |
| POST `/api/local-agent/refresh` | 重新读取账号摘要和模型列表 |
| POST `/api/local-agent/quota` | 刷新账号后，对每个已启用账号查询官方用量接口；结果在 `quotas[accountId]`（`windows[]` 含 `usedPercent` / `resetsAt`） |
| POST `/api/local-agent/login/open` | `{id:"当前 login.id"}`，重新打开官方授权页 |
| POST `/api/local-agent/login/cancel` | `{id:"当前 login.id"}`，取消上游授权会话 |
| POST `/api/local-agent/login/callback` | `{id:"当前 login.id",redirectURL:"完整 localhost 回调地址"}`，补交回调（仅回调流程；设备码流程返回 400） |
| POST `/api/local-agent/accounts/:id` | `{enabled:true/false}`，启用或停用账号，保留本机授权 |
| POST `/api/browser/open` | 打开持久 任务浏览器 |
| GET `/api/browser` | 浏览器状态与 Tabs |
| GET / POST `/api/desktop` | 桌面操作开关 `{enabled}`（内存态，默认关闭）；返回 `supported` / `platform` / `permissions` |
| POST `/api/desktop/permissions` | 查询并申请系统权限（macOS 弹出辅助功能 / 屏幕录制授权） |
| POST `/api/runs` | `{scenarioId:"browser-task", model:"已探测模型", prompt:"任务", maxResponseTurns:24}` |
| GET `/api/runs/active` | 当前任务 |
| GET `/api/runs/:id` / `replay` / `events` | 详情、Replay、SSE |
| POST `/api/runs/:id/stop` | 停止任务与 Worker |
| GET `/api/control` | 控制状态和人工接管请求 |
| POST `/api/control/pause` | 请求在操作边界暂停 |
| POST `/api/control/resume` | `{id:"当前 pending.id"}`，拒绝过期确认 |
| GET `/api/history` | 本机最近 100 个任务 |
| GET `/v1/models` | 统一模型接口 |
| POST `/v1/responses` / `/v1/messages` / `/v1/chat/completions` | 统一模型网关，支持 SSE、Key 范围和 token 额度检查 |

Provider 设置请求：

```json
{
  "provider": {
    "kind": "custom",
    "baseURL": "http://127.0.0.1:8317/v1",
    "model": "your-actual-model-id",
    "historyMode": "stateless",
    "reasoning": "off"
  },
  "apiKey": "your-local-proxy-key"
}
```

网关不自行重写模型协议。转换、OAuth、多账号路由复用 CLIProxyAPI；token-flowb 提供本机鉴权、Provider 选择与浏览器操作的任务 API。不要把 CLIProxyAPI 的管理凭据当作 API Key。

OpenAI 兼容的本机客户端请在 **模型中心 → API Keys** 创建独立 Key，使用该页的 Base URL（默认 `http://127.0.0.1:9527/v1`）。按「全部 → 提供商 → 模型」勾选范围，支持半选；全选只授权当前模型，新增模型需再次勾选。`GET /v1/models` 只列出该 Key 已授权且当前可用的模型；Responses / Chat 请求在转发前检查精确模型 ID，越权返回 403、停用 Key 返回 401、模型离线返回 503。Key 无工作台管理权限，且始终路由到本机网关，不随任务使用的 Custom 接口变化。

每把 Key 还可配置 Agent 协议范围与累计 token 上限（留空不限额，0 禁止消费）。Codex 授权 Responses，Claude Code 授权 Messages，OpenAI 兼容 Agent 授权 Chat / Responses；这是协议权限，不是应用进程身份认证。用量按上游输入（含 Anthropic 缓存读写）+ 输出 token 结算，持久化到 `gateway-keys.json`。修改上限、名称或启停状态不重置已用量。

额度为请求准入上限：耗尽后返回 429，最后一条已放行请求可能超过上限。有限额 Key 同时只放行一个生成请求；在途预留先落盘。流中断、缺少最终 usage 或应用退出时未结算的请求计为「用量待核对」，阻止有限额 Key 继续消费；管理员核对后可显式重置用量。重置在途请求返回 409。模型目录和 Messages token-count 查询不扣生成额度。统计仅用于网关访问控制，不代表厂商真实余额或费用结算。

完整客户端 Key 只在创建时返回一次，`gateway-keys.json` 仅保存 SHA-256 摘要和授权元数据；权限修改、停用和删除对后续请求立即生效。「网关设置 → 高级」保留内部直连地址（默认 8317）及内部密钥，它拥有全部模型权限，不应作为受限客户端 Key 使用。

### 分层

```
对话层  packages/core/src/responses-loop.ts, providers.ts   统一发送 Responses 请求（/v1/responses）
   ↓
Router  packages/core/src/cliproxy.ts + CLIProxyAPI            受管进程、账号摘要、模型→Provider 路由表；
                                                              CLIProxyAPI 按模型把 Responses 转成各家协议并选账号
   ↓
登录层  packages/core/src/login/                              每个 Provider 一个模块，只负责把官方授权变成已保存账号
        codex.ts / claude.ts / antigravity.ts  → callback-flow.ts（授权码 + 本机 loopback 回调）
        kimi.ts / xai.ts                       → device-flow.ts（RFC 8628 设备码，无本机回调）
        registry.ts（注册表、模型 type → Provider 反查） controller.ts（单会话状态机：启动/打开/轮询/回调/取消/超时）
额度层  packages/core/src/quota/                              每个 Provider 一个模块，只读；经 CLIProxyAPI `/api-call`
        codex.ts / claude.ts / antigravity.ts / kimi.ts / xai.ts   用对应账号凭据查询官方用量接口，归一化为额度窗口

执行侧（与 Provider 无关）
桌面层  packages/core/src/desktop/                            exec_js 里的 `desktop` 全局：截图、鼠标键盘、打开/聚焦应用、窗口列表
        macos.ts（osascript JXA + CGEvent / screencapture） windows.ts（PowerShell + user32 / System.Drawing）
        api.ts（坐标换算、参数校验、截图回显） keys.ts（组合键解析与各平台键码）
```

新增 Provider 只需在 `login/` 下增加一个模块并注册到 `registry.ts`（额度查询则在 `quota/` 下对应新增）；API 路由、UI 按钮、模型分组都从注册表生成。通过每个账号的 `/auth-files/models` 读取独立模型目录，并向网关注册 `提供商/模型` OAuth 别名（保留原始 ID 兼容旧配置）。确认别名出现在实时 `/v1/models` 后再供 UI 和客户端 Key 授权使用，同名模型不会因全局列表去重而丢失提供商。

## 操作 Windows / macOS 桌面软件

任务工作台勾选「允许操作桌面应用」后，Agent 除浏览器外还能操作本机桌面（多显示器时截图并操作前台窗口所在的那块屏幕）：`exec_js` 中多出 `desktop` 全局，模型用同一套代码执行方式调用 `await desktop.screenshot()`（截图回显给模型）、`desktop.click / doubleClick / rightClick / move / drag / scroll`、`desktop.type(text)`、`desktop.key('cmd+shift+t')`、`desktop.open('备忘录')`、`desktop.focus(app)`（二者返回 `{frontmostApp}`；应用已运行但没有窗口时会重新开窗）、`desktop.windows()`，等待界面用 `await sleep(ms)`。坐标是最近一次截图的像素坐标；macOS Retina 截图按 points 重采样后与系统坐标一致，Windows 进程声明 DPI 感知后与物理像素一致。模型一旦用过 `desktop`，该任务后续的存档截图改为桌面截图，Replay 中可回看。

- 零依赖实现：macOS 用 `osascript -l JavaScript` 的 ObjC 桥直接投递 `CGEvent`，System Events 发组合键，`screencapture` + `sips` 截图；Windows 用 PowerShell 调 `user32`（`SetCursorPos` / `mouse_event` / `keybd_event`）和 `System.Drawing` 截图。文本输入统一走剪贴板粘贴（Unicode 安全，完成后恢复原剪贴板文本）。
- 权限：macOS 需要为 token-flowb 授予「辅助功能」（鼠标键盘）和「屏幕录制」（截图），首次列举窗口还会弹出「控制 System Events」的自动化授权。开关旁显示权限状态，「申请系统权限」按钮触发系统弹窗；源码运行（`npm run dev`）时权限记在启动它的终端上。未授权时输入会静默失效、截图只有壁纸，模型会被指示停下并请求人工接管。Windows 不需要额外授权，但 UAC 提权窗口无法被操作。
- 边界：开关不落盘，每次启动应用都需重新勾选；任务运行中不能切换。只操作主显示器；不提供文件系统、终端或剪贴板读取接口。`desktop` 与 `exec_js` 一样默认自动执行，人工接管是唯一的确认门。这不是针对恶意模型代码的隔离：开启后模型可以点到屏幕上的任何东西，请只在可见、可随时暂停的情况下使用，并把任务限定在具体应用内。

## 账号连接与恢复

- 自动回调（Codex / Claude / Antigravity）：Codex 使用 `127.0.0.1:1455`，Claude 使用 `127.0.0.1:54545`，Antigravity 使用 `127.0.0.1:51121` 接收官方回跳；桌面端校验 Host、路径和本次会话 state，再交给 CLIProxyAPI 交换与保存凭据。PKCE 与 Token 交换直接复用上游实现。
- 设备码（Kimi / xAI Grok）：CLIProxyAPI 向 `auth.kimi.com` / `auth.x.ai` 申请设备码并自行轮询 token 端点；桌面端只打开官方验证页（`www.kimi.com/code/authorize_device`、`accounts.x.ai/oauth2/device`）、展示 `user_code`，并通过 `/get-auth-status` 观察结果。没有本机回调端口，也不接受回调补交。授权有效期以上游返回的 `expires_in` 为准（当前均为 30 分钟）。
- 授权页未打开：点击「重新打开官方授权页」，或展开备用链接并复制到浏览器。只允许对应 Provider 的官方 HTTPS 授权地址。
- 已授权但 localhost 回调页打不开：展开回调补交面板，粘贴**本次**授权后的完整 localhost 地址；不会保存到日志。旧会话、错误 Provider 端口或不匹配 state 会被拒绝。
- 回调流程五分钟未完成会显示过期；可取消当前会话或重新连接。取消会调用上游 `/oauth-session`，终止待处理的授权，避免迟到回调保存凭据。
- 授权完成后自动刷新账号摘要和模型；账号列表由上游管理接口读取，页面不接收原始 auth 文件、Token 或 `id_token`。账号保存不等于模型调用可用，仍须通过能力探测。
- 「停用」只停止该账号参与路由，保留凭据；之后可再次启用。重启服务后会重新读取已有账号。
- 「刷新额度」对每个已启用账号调用 CLIProxyAPI 管理接口 `/api-call`，由上游把 `$TOKEN$` 替换为该账号凭据后请求官方用量接口；桌面端不接触 token，只得到用量响应，并把它归一化为若干额度窗口（已用百分比、原始计数或金额、重置时间）。各 Provider 的数据源：Codex `chatgpt.com/backend-api/wham/usage`（5 小时 / 7 天窗口、附加限额、重置券数）；Claude `api.anthropic.com/api/oauth/usage` + `profile`（5 小时 / 7 天及各模型窗口、Pro / Max）；Antigravity `v1internal:retrieveUserQuotaSummary`（按配额组 / 桶的剩余比例，需要账号 `project_id`）；Kimi `api.kimi.com/coding/v1/usages`（各限额窗口与周用量）；xAI `cli-chat-proxy.grok.com/v1/billing`（本周 credits、各产品用量、月度金额与按需上限；订阅接口不可用时仅用 `api.x.ai/v1/me` 确认账号，不发起计费请求）。查询失败只显示桌面端文案和 HTTP 状态码，不透出上游响应；额度是查询时刻的快照，不会自动轮询。
- 服务未启动时账号状态为离线；不要把保留的账号摘要当成当前连接成功。

`CLIPROXY_BINARY` 可以指定本机自编译的 sidecar 路径；`AGENT_PROXY_PORT` 可以更改受管代理端口（默认 8317）。已有 settings 中保存的地址不会被悄悄改写，改端口后需在界面重新选择 Local Agent 模型。`AGENT_DATA_ROOT` 同时隔离 Electron 会话和 Agent 数据，便于开发测试。

测试账号连接使用 `tests/fixtures/fake-cliproxy.mjs`，只在显式设置 `CLIPROXY_BINARY` 时运行该测试文件；生产默认使用打包的 Go sidecar。登录界面测试拦截测试进程中的浏览器打开动作，不访问真实账号页面。`npm test` 的真实 CLIProxyAPI 测试只生成授权会话并取消，不实际登录或交换用户凭据。OAuth 固定端口需空闲，账号测试不要并行运行。

## 结构与数据

- `packages/core/src/`：复用的官方 Loop、Runner/Replay、Worker，以及新增服务、Provider、控制状态和 sidecar 管理。
- `packages/contracts/`：复用并扩展的 Zod 合约。
- `apps/desktop/`：Electron 生命周期、安全存储和受限 preload。
- `apps/console/`：中文深色工作台，复用官方截图时间线组件。
- `scripts/`：固定版本源码获取与当前平台 sidecar 编译。
- `tests/`：官方 Loop 回归测试、本地 API、真实 Chromium 和 CLIProxyAPI 集成测试。
- `LICENSES/`、[THIRD_PARTY.md](THIRD_PARTY.md)：许可与来源。

桌面数据保存在 Electron `userData` 目录：`settings.json`、`secrets/*.bin`、`browser/profiles/default`、`cliproxy/config.yaml`、`cliproxy/auth`、`runs/<id>/{events.jsonl,replay.json,screenshots}`。API Key 用 Electron safeStorage 加密；Linux 未配置安全后端时拒绝落盘密钥。CLIProxyAPI 必须读取本地明文 API Key 配置，文件权限为 0600，父目录为 0700，管理接口仅在 loopback 服务上开放并使用独立随机管理密钥，管理控制台关闭；管理密钥不进入 Renderer。其 OAuth auth 文件由 CLIProxyAPI 管理。

## 验证与打包

```bash
npm run typecheck
npm test
npm run build
npm run test:desktop
npm run test:login
npm run package
# macOS ARM64: 验证打包后的应用
node scripts/desktop-smoke.mjs --packaged
node scripts/login-smoke.mjs --packaged
```

`npm test` 会启动本机监听端口、真实 Chromium 和已编译的 CLIProxyAPI，不需要真实模型 Key。模型循环集成测试使用明确标记的本地 fixture Provider；真实账号的首次 OAuth 和付费模型请求需要用户自己的授权。持久浏览器启动时对所有站点预授「本地网络访问」权限（Chromium 138+ 的「访问本地网络中的其他设备」弹框是浏览器级 UI，Playwright 无法关闭，页面会停在加载中导致任务中断）。`npm run package` 生成当前平台未签名目录包；sidecar 来自本机编译。Chromium 通过 `npm run browser:install` 安装到用户的 Playwright 缓存，尚未随安装包内置。

## 当前边界

这是开发者 P0/MVP，已实现本机转换底座和默认自动执行的浏览器任务闭环。不是完成全部 P1–P3 的商业发行版：目前只有一个持久 Profile，未实现 Vault/简历管理、多 Profile UI、自动更新、代码签名/公证、系统托盘、浏览器扩展与多 Agent。

`node:vm` 和独立 Worker **不是恶意代码的 OS 安全沙箱**。Worker 只保留环境白名单，有 64 KiB 代码限制、12 MiB 输出限制和 30 秒调用看门狗（开启桌面操作时 60 秒）；执行默认自动进行。当前未实现 OS 级隔离与细粒度权限。模型按用户任务授权范围行动，不能将提示词视为强制安全边界。桌面操作在真机上的鼠标键盘注入尚未自动化测试（需要系统授权），本地测试覆盖坐标换算、键码翻译、权限上报和 Worker 暴露逻辑；Windows 驱动脚本未在本机验证。

Replay、截图和持久浏览器中可能包含页面个人信息，当前未实现加密 Replay 或自动脱敏。退出应用再手动删除对应数据目录可清除本机记录；不要分享含敏感信息的 Replay。Worker 超时后任务失败，可使用仍保留页面状态的浏览器启动新任务；应用崩溃后的运行任务不自动续跑。

### 账号与能力探测说明

- 桌面账号连接：Codex、Claude、Antigravity（Google OAuth，回调流程），Kimi、xAI Grok（设备码流程），支持取消、状态轮询与账号启停。Antigravity 模型由上游账号实际权限决定；Kimi（kimi-k3 / k2.7-code 等）和 Grok（grok-4.6 / grok-build 等）模型列表来自上游静态目录，是否可调用取决于订阅。
- Kimi 与 xAI 的 Responses 请求由 CLIProxyAPI 转换：Kimi 走 OpenAI Chat 兼容执行器（Responses → Chat），xAI 执行器同时支持 Chat 与 Responses 两种上游格式。真实账号的能力（工具调用、`previous_response_id`、图片）仍需能力探测确认，本地测试只用模拟账号，未验证真实 Kimi / xAI 订阅。
- 额度监控使用与上游 Management Center 相同的官方用量接口；字段以宽松方式解析（camelCase / snake_case、绝对或相对重置时间）。本地测试只覆盖模拟响应，真实接口返回结构变化时会显示为“未返回额度数据”而不是错误数值。CLIProxyAPI 自身只对 Codex / Claude 做响应头级别的被动额度观察，桌面端未使用该数据。
- 固定版本 CLIProxyAPI 另有 Gemini API Key 与 xAI API Key（`xai-api-key`）配置；桌面尚未提供这些密钥配置入口。当前源码未找到 ZCode、WorkBuddy、Qoder 原生账号适配，不能将这些客户端的订阅直接视为可用 API。
- Codex 的 HTTP 转换强制 `store: false`。`previous_response_id` 探测失败时选择 `stateless`，以完整历史继续多轮及工具调用；此结果不代表模型没有多轮能力，也不代表 WebSocket 链路的能力。
- 图片探测已替换损坏的 1×1 PNG，使用带有效 CRC 的 64×64 RGB PNG。旧版的 HTTP 400 不能用来判定视觉能力，更新后需重新探测。新版本仍失败时需进一步定位代理与上游请求。
- 推理探测按选择的 low / medium / high 发送；关闭推理时单独探测 low。请求被接受不保证代理或模型实际执行了对应推理强度。

上述适配以 `upstream/CLIProxyAPI` 固定版本为准；本地测试使用模拟账号，不验证真实订阅权限。

Antigravity 排错：Responses、工具和图片请求都通过 CLIProxyAPI 的原生 Responses → Gemini → Antigravity 转换。`EOF`、`TLS handshake timeout` 是上游连接错误，不能判成协议或视觉不支持；`auth_unavailable` 也可能是前一次连接失败后的账号冷却。前置 Responses 失败时历史续接会标为“未执行”。探测不会自动重试或把失败改成通过。

### 连接日常 Chrome 当前标签页

1. 在 Chrome 打开 `chrome://extensions`，开启「开发者模式」，选择「加载已解压的扩展程序」，加载项目的 `extensions/chrome` 文件夹。打包应用内也有 `Contents/Resources/extensions/chrome`。
2. 在桌面任务工作台选择「Chrome 当前标签页 · 扩展」，点击「生成连接码」并复制。
3. 切到你已登录的网站，点击 token-flowb 扩展图标，粘贴连接码并点击「连接当前标签页」。连接码 5 分钟有效且单次使用。
4. 桌面显示已连接的页面标题后启动任务。页面沿用原 Chrome 的登录状态，不复制 Cookie 或 Profile。
5. 点击扩展或桌面的「断开连接」随时结束控制。任务结束不会关闭 Chrome；仍连接时可以继续下一任务。切换到其他标签页需重新生成连接码并主动选择。

首版支持选定标签页中的 Playwright DOM 操作和截图，不提供创建/关闭标签页、浏览器全局设置或全局 Cookie 操作。Chrome 内部页及部分受限制页面无法连接；DevTools 或用户取消调试可能导致断开。扩展需 Chrome 125+，未上架商店。该范围限制不是针对恶意模型代码的 OS 安全沙箱。

实现：`extension-relay.ts` 在 loopback 上桥接经过鉴权的 Worker CDP WebSocket 和 Chrome `debugger` API。扩展只 attach 用户选定 tab；只向 Playwright 暴露该 tab；支持子会话事件映射。重新连接时重启 Runtime 事件订阅，避免旧的调试会话不重发上下文事件。扩展代码不持久保存连接码。

额度查询失败（包括 HTTP 401 / 403）只记录查询错误，不删除或停用授权，也不以额度接口结果覆盖模型认证状态。模型调用自身的授权状态由上游维护；上游明确不可用的账号不显示在模型中心，凭据保留以便恢复或重新登录。


## Qoder / Kimi 额度与 Cursor（2026-09-22）

Qoder 读取实际响应的 `userQuota`（套餐 Credits）与 `orgResourcePackage`（组织资源包）；比率优先按 used / total 或 cap 计算。未知额度不伪装为有效余额。Kimi 的 HTTP 200 空对象只表示官方未返回额度，不能断言无套餐或余额为零；界面显示未知，兼容 Code 官方 quota.usages 中的 5h / 7d / 月度比例窗口。通用名称“Kimi”不能识别重复账号，不据此建议删除凭据。

Cursor 使用 `@cursor/sdk` 1.0.31 的官方浏览器授权，创建名为 token-flowb 的独立 SDK Key，默认有效期以官方 SDK 为准。桌面版将该账号保存到 safeStorage 加密文件 `secrets/cursor-account.bin`；不读取或改写 Cursor IDE 登录。模型列表按账号调用 `Cursor.models.list()`，不硬编码。官方 SDK 没有账户剩余额度接口，卡片提供官方用量页，调用 token 在本应用 API 总览记账。无返回用量时维持既有未知用量保护，绝不估算成零。

Cursor 文本来源通过主网关 `/v1/responses`、`/v1/chat/completions`、`/v1/messages` 调用，仍校验客户端 Key、模型、协议、源账号和 token 预算；内部 sidecar 的 8317 直连不包含 Cursor。创建临时空目录，显式 `tools: []`、空 MCP/子 Agent、`settingSources: []`，完成后清理会话文件。不提供本机文件或 shell 权限。

能力边界：SDK 接收完整文本转录而非原始推理消息；不支持外部工具调用、图片、previous_response_id、Responses compact、count_tokens、生成长度上限等参数，收到这些请求会明确返回 400；不静默忽略。SSE 当前在完成后转换输出，不是逐 token 实时透传。因此不允许该来源参与需要工具的 A2A 自动配置或网关维修。用于 API 文本消费者，不宣称完整替代编码 Agent 的模型后端。

首页和“Agent 接入”均不提供 Cursor 目标或公网网关配置。Qoder IDE 可作为接入目标，生成本机 Base URL、Key 与模型 ID 后，在 Settings → Models → Add 添加 OpenAI Compatible 模型；账号登录与内置模型保留。

验证：`tests/cursor.test.ts` 覆盖独立登录、取消后迟到结果、重启恢复、停用/移除、三种协议、token（含缓存）记账及工具拒绝。`scripts/cursor-smoke.mjs` 验证实际打包应用、真实 SDK 授权地址准备/取消、Qoder 与 Kimi 界面以及 Qoder 本机目标配置生成、Cursor 目标移除；不完成真实账号授权，不发起真实 Cursor 计费推理。SDK 来源与计费：[官方文档](https://cursor.com/docs/sdk/typescript)；目标限制：[官方 BYOK 说明](https://prod.cursor.com/help/models-and-usage/api-keys)。

模型中心默认显示紧凑的账号与额度概览，点击提供商展开管理。A2A 目标现包含 Qoder IDE 的官方自定义模型接入引导：生成源账号绑定 Key，再在 Qoder Settings → Models 添加 OpenAI Compatible / Chat Completions 模型；原生账号登录保留。Qoder CLI 使用其 `/model → Custom` 向导，能力以版本和账号目录为准。详情与验证边界见 [本轮验证记录](artifacts/model-center/review.md)。

指定维修师傅后，自动接入 Codex / Claude Code / WorkBuddy 会触发一次只读 review，核对配置、辅助模型、Key 授权、源账号和备份。检查失败不撤销已完成的接入；首页“请师傅复查”可重试，任务调试中可继续追问，当前应用会话保留上下文（重启不保存维修聊天）。支持停止检查和新开对话。每次写入授权独立，自动 review 不授予修改权限。配置检查不等于真实模型调用成功；Qoder 的手动添加结果尚不可自动读取。

Qoder 模型名称：保留网关目录返回的 `display_name`，在模型中心、A2A 选择、维修选择、Key 模型权限和手动接入选择中展示 `qoder/具体名称`（例如 `qoder/Kimi-K3`）。名称不是新的 API 别名；配置与授权始终使用原调用 ID（例如 `qoder/kmodel_latest`），模型中心悬停可查看。`/v1/models` 同时返回原 `id` 与 `display_name`。不硬编码名称映射，缺少名称时回退原 ID；Auto/Ultimate 等仍按目录中的档位展示。

启动同步与共享数据目录：开发版与发布版使用相同的目录选择规则，优先复用已有的 token-flowb / desktop-browser-agent / Browser Agent 授权目录；`AGENT_DATA_ROOT` 仍可用于隔离测试。启动时读取授权池并导入受支持的本地 OAuth，已存在的池凭据不被旧副本覆盖。模型目录延迟注册或别名注册失败时自动重试，正常运行每 30 秒同步；停止网关时取消重试。界面分别更新网关授权与辅助工具状态，浏览器接口异常不再阻塞授权显示。额度圆环表示剩余比例，未知额度为灰色虚线，不视作满额或耗尽。
