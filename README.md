# Desktop Browser Agent

基于 OpenAI CUA Sample 的本地桌面浏览器 Agent。Electron + React 工作台、独立持久 Chromium、Responses / `exec_js`、人工接管、Replay，以及 CLIProxyAPI 本机接口转换。

## 本机交付

当前 macOS ARM64 应用目录包：`release/mac-arm64/Browser Agent.app`，可在 Finder 打开。它是未签名的开发版本，不是对外发布安装包。工作台截图见 [desktop-smoke.png](artifacts/desktop-smoke.png)，账号页面见 [local-agent-accounts.png](artifacts/local-agent-accounts.png)（均为测试数据）。

本机验收已通过：类型检查、构建、67 项自动化测试，以及源码启动和打包后 `.app` 两种 Electron 端到端测试。端到端流程使用本机模拟 Provider 发起 10 次 Responses 请求，直接执行代码、真实 Chromium 表单填写、人工接管与继续，生成 4 张截图和 Replay。真实 CLIProxyAPI 的启动、鉴权、授权会话生成/取消和停止另有集成测试；源码和打包应用均通过账号页面端到端测试，覆盖自动回调、手动补交、取消重试、账号启停、模型选择和重启恢复。用户已连接真实账号；Antigravity 真实文本请求曾成功，图片调用仍受上游网络故障影响，详见设计文档第 0 节。

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

1. 在 **Local Agent** 点击连接 Codex 或 Claude，自动启动 CLIProxyAPI 并打开官方授权页面；在浏览器完成登录和授权。完成后自动读取已保存账号和模型。
2. 在 **Local Agent** 选择已加载的模型，点击「使用此模型并前往能力检测」，再保存并探测能力。也可在 **模型与接口** 刷新并选择真实模型 ID。也可以选择 OpenAI 或 Custom 并保存自己的 API Key。已有 CLIProxyAPI 服务用 Custom 接入，受管 sidecar 不会接管占用端口的服务。
3. 打开 **Agent Browser**，登录目标网站。默认使用独立 `default` 身份，登录状态跨任务和重启保留。
4. 在工作台输入任务。模型代码默认直接执行。遇验证码、登录或必要信息缺失时人工接管，点击继续后重新观察页面；已授权的任务操作无需反复确认。
5. 随时暂停或停止。暂停等待当前代码调用结束，只有显示人工接管后才能放心手动操作；停止会终止 Worker，但保留浏览器。任务截图、事件和 Replay 保存到本机。

默认不预置或猜测模型名。能力探测会产生少量实际 Provider 请求；Responses、Function Call、Function Output 必须通过才能启动。无状态完整历史是默认值，只有探测通过才可使用 `previous_response_id` / reasoning。截图仍可本地保存，即便 Provider 不支持图片。

## P0 本机 API

桌面 App 使用随机端口与 HttpOnly 本机会话。供外部 AI 客户端调用的稳定服务使用：

```bash
npm run build
npm run serve
```

默认监听 `127.0.0.1:4317`，数据目录 `.data/`，Bearer Token 文件 `.data/api-token`（0600）。`AGENT_DATA_ROOT`、`AGENT_PORT`、`AGENT_API_TOKEN` 可覆盖这些值；`AGENT_HEADLESS=1` 用于自动化测试。独立服务的外部 Provider Key 从 `OPENAI_API_KEY` / `CUSTOM_API_KEY` 环境变量加载，通过 API 设置的 Key 仅在内存中保存。

所有 `/api/*` 和 `/v1/*` 请求均要求 `Authorization: Bearer <token>`。请求 JSON，不启用任意网页跨域访问。

| 方法 / 路径 | 功能 |
| --- | --- |
| GET `/health` | 健康状态（不需要 Token） |
| GET / PUT `/api/settings` | 读取/保存 Provider；读取只返回 `hasKey` |
| GET `/api/providers/models` | 获取真实模型列表 |
| POST `/api/providers/probe` | 探测 Responses、工具调用/回传、续接、图片、reasoning |
| GET `/api/local-agent` | Sidecar 状态与经过筛选的生命周期日志 |
| POST `/api/local-agent/start` / `stop` / `restart` | 受管 CLIProxyAPI 生命周期 |
| POST `/api/local-agent/codex` / `claude` | 自动启动服务并生成官方 OAuth 会话，桌面端自动打开浏览器 |
| POST `/api/local-agent/refresh` | 重新读取账号摘要和模型列表 |
| POST `/api/local-agent/login/open` | `{id:"当前 login.id"}`，重新打开官方授权页 |
| POST `/api/local-agent/login/cancel` | `{id:"当前 login.id"}`，取消上游授权会话 |
| POST `/api/local-agent/login/callback` | `{id:"当前 login.id",redirectURL:"完整 localhost 回调地址"}`，补交回调 |
| POST `/api/local-agent/accounts/:id` | `{enabled:true/false}`，启用或停用账号，保留本机授权 |
| POST `/api/browser/open` | 打开持久 Agent Browser |
| GET `/api/browser` | 浏览器状态与 Tabs |
| POST `/api/runs` | `{scenarioId:"browser-task", model:"已探测模型", prompt:"任务", maxResponseTurns:24}` |
| GET `/api/runs/active` | 当前任务 |
| GET `/api/runs/:id` / `replay` / `events` | 详情、Replay、SSE |
| POST `/api/runs/:id/stop` | 停止任务与 Worker |
| GET `/api/control` | 控制状态和人工接管请求 |
| POST `/api/control/pause` | 请求在操作边界暂停 |
| POST `/api/control/resume` | `{id:"当前 pending.id"}`，拒绝过期确认 |
| GET `/api/history` | 本机最近 100 个任务 |
| GET `/v1/models` | 统一模型接口 |
| POST `/v1/responses` / `/v1/chat/completions` | 统一模型网关，支持透传 SSE |

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

网关不自行重写模型协议。转换、OAuth、多账号路由复用 CLIProxyAPI；Browser Agent 提供本机鉴权、Provider 选择与浏览器操作的任务 API。不要把 CLIProxyAPI 的管理凭据当作 API Key。

## 账号连接与恢复

- 自动回调：Codex 使用 `127.0.0.1:1455`，Claude 使用 `127.0.0.1:54545` 接收官方回跳；桌面端校验 Host、路径和本次会话 state，再交给 CLIProxyAPI 交换与保存凭据。PKCE 与 Token 交换直接复用上游实现。
- 授权页未打开：点击「重新打开官方授权页」，或展开备用链接并复制到浏览器。只允许对应 Provider 的官方 HTTPS 授权地址。
- 已授权但 localhost 回调页打不开：展开回调补交面板，粘贴**本次**授权后的完整 localhost 地址；不会保存到日志。旧会话、错误 Provider 端口或不匹配 state 会被拒绝。
- 五分钟未完成会显示过期；可取消当前会话或重新连接。取消会调用上游 `/oauth-session`，终止待处理的授权，避免迟到回调保存凭据。
- 授权完成后自动刷新账号摘要和模型；账号列表由上游管理接口读取，页面不接收原始 auth 文件、Token 或 `id_token`。账号保存不等于模型调用可用，仍须通过能力探测。
- 「停用」只停止该账号参与路由，保留凭据；之后可再次启用。重启服务后会重新读取已有账号。
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

`npm test` 会启动本机监听端口、真实 Chromium 和已编译的 CLIProxyAPI，不需要真实模型 Key。模型循环集成测试使用明确标记的本地 fixture Provider；真实账号的首次 OAuth 和付费模型请求需要用户自己的授权。`npm run package` 生成当前平台未签名目录包；sidecar 来自本机编译。Chromium 通过 `npm run browser:install` 安装到用户的 Playwright 缓存，尚未随安装包内置。

## 当前边界

这是开发者 P0/MVP，已实现本机转换底座和默认自动执行的浏览器任务闭环。不是完成全部 P1–P3 的商业发行版：目前只有一个持久 Profile，未实现 Vault/简历管理、多 Profile UI、自动更新、代码签名/公证、系统托盘、浏览器扩展与多 Agent。

`node:vm` 和独立 Worker **不是恶意代码的 OS 安全沙箱**。Worker 只保留环境白名单，有 64 KiB 代码限制、12 MiB 输出限制和 30 秒调用看门狗；执行默认自动进行。当前未实现 OS 级隔离与细粒度权限。模型按用户任务授权范围行动，不能将提示词视为强制安全边界。

Replay、截图和持久浏览器中可能包含页面个人信息，当前未实现加密 Replay 或自动脱敏。退出应用再手动删除对应数据目录可清除本机记录；不要分享含敏感信息的 Replay。Worker 超时后任务失败，可使用仍保留页面状态的浏览器启动新任务；应用崩溃后的运行任务不自动续跑。

### 账号与能力探测说明

- 桌面账号连接：Codex、Claude、Antigravity（Google OAuth），支持回调、取消、状态轮询与账号启停。Antigravity 模型由上游账号实际权限决定。
- 固定版本 CLIProxyAPI 另有 Gemini API Key 管理接口；桌面尚未提供该密钥配置入口。当前源码未找到 ZCode、WorkBuddy、Qoder 原生账号适配，不能将这些客户端的订阅直接视为可用 API。
- Codex 的 HTTP 转换强制 `store: false`。`previous_response_id` 探测失败时选择 `stateless`，以完整历史继续多轮及工具调用；此结果不代表模型没有多轮能力，也不代表 WebSocket 链路的能力。
- 图片探测已替换损坏的 1×1 PNG，使用带有效 CRC 的 64×64 RGB PNG。旧版的 HTTP 400 不能用来判定视觉能力，更新后需重新探测。新版本仍失败时需进一步定位代理与上游请求。
- 推理探测按选择的 low / medium / high 发送；关闭推理时单独探测 low。请求被接受不保证代理或模型实际执行了对应推理强度。

上述适配以 `upstream/CLIProxyAPI` 固定版本为准；本地测试使用模拟账号，不验证真实订阅权限。

Antigravity 排错：Responses、工具和图片请求都通过 CLIProxyAPI 的原生 Responses → Gemini → Antigravity 转换。`EOF`、`TLS handshake timeout` 是上游连接错误，不能判成协议或视觉不支持；`auth_unavailable` 也可能是前一次连接失败后的账号冷却。前置 Responses 失败时历史续接会标为“未执行”。探测不会自动重试或把失败改成通过。
