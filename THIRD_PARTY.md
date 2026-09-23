# 开源复用与修改记录

| 项目 | 固定提交 | 复用方式 |
| --- | --- | --- |
| [OpenAI CUA Sample](https://github.com/openai/openai-cua-sample-app) | `f2a3dc523ae406f9b704f9a420a05402a63b4522` | 复制 JavaScript Responses Loop、Worker/protocol/session/process、RunnerManager、Fastify run/SSE/artifact API、contracts 和 Console ScreenshotPane/helpers/types，保留其许可 |
| [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) | `d198db54d4c4886c99b21488d54fc576933019a3` | 保留上游检出，通过构建 overlay 增加指定凭据路由，编译独立 sidecar；复用 API 转换、模型路由和 OAuth 登录能力 |

许可证位于 `LICENSES/`。OpenAI 核心改造位于 `packages/core/src/`，协议位于 `packages/contracts/`，复用的截图组件位于 `apps/console/src/ScreenshotPane.tsx`。原始源码通过 `node scripts/fetch-upstream.mjs` 获取到被忽略的 `upstream/` 目录，可按固定提交比较；不把上游完整 Lab/Python 工程引入产品依赖。

本地改造包括：Provider 注入与无状态历史、human takeover tool、代码执行确认、独立持久 BrowserHost/CDP attach、环境白名单、Free-form task、localhost 鉴权、CLIProxy 管理和 Electron Shell。RunnerManager 的事件与 Replay v3 格式沿用上游；`browser` 是新增场景类型。

CLIProxyAPI 的配置文件与命令均根据该提交的 `config.example.yaml`、`cmd/server/main.go` 和 `internal/api/server_routes.go` 核对。升级时应重新跑真实 sidecar 与浏览器集成测试，不假设不同 Provider 的 Responses 能力一致。

账号连接复用该提交的 `/v0/management/codex-auth-url`、`anthropic-auth-url`、`get-auth-status`、`oauth-session`、`oauth-callback`、`auth-files`、`auth-files/status`。桌面端自建 loopback-only 回调接收器，不启用上游 `is_webui` 转发器，因为该版本转发器绑定 `0.0.0.0`。`scripts/sidecar-overlay.mjs` 在编译时将内部 `X-Token-Flow-Auth` 请求头映射到上游已有的 pinned credential 元数据。桌面网关从持久授权生成此头，不透传客户端的同名头。

Qoder / WorkBuddy 修复基于当前已扩展这些来源的 CLIProxyAPI 工作树（其中包含额外的认证、模型注册等本地改造，不等同于上述原始提交）。`patches/cliproxy/` 保留相关执行器、Qoder 协议和共用 `agent_responses.go`，构建 overlay 优先使用它们。两种来源的请求和原生事件通过共用层归一为 Responses，再适配 Messages / Chat Completions；保留系统提示的权限层级、工具定义、调用及结果、输出上限与用量，拒绝空流和异常断流，取消时关闭上游。复用名为 Codex 的 Responses 编解码器不会选择 Codex 账号或产生额外 HTTP 推理请求。其他来源仍使用原有执行器，尚未全部迁移或实测。单独恢复原始提交不足以构建这些扩展，仍需保留当前扩展工作树。`tests/sidecar/` 的回归测试运行真实执行器和翻译器，只模拟上游网络。

## Microsoft Playwright extension relay reference

The single-tab bridge in `packages/core/src/browser/extension-relay.ts` adapts the CDP session mapping approach from Playwright 1.63.0 (`packages/playwright-core/src/tools/mcp/browserModel.ts`, `cdpRelay.ts`, `cdpRelayV2.ts`, inspected in the installed `lib/coreBundle.js`). Copyright Microsoft Corporation; Apache-2.0. Copies of the license and notice are in `LICENSES/Playwright-LICENSE` and `LICENSES/Playwright-NOTICE`.

Changes: only a user-selected tab is exposed; one-time loopback pairing, authenticated CDP connection, no tab enumeration/creation or browser-wide state mutation, bounded requests and explicit detach lifecycle. The Chrome extension UI and transport are project-specific.

## 本地界面资源

- Geist 字体：从用户提供的 AIHub 项目复用，SIL Open Font License 1.1，许可证见 `LICENSES/Geist-LICENSE.txt`。随应用本地加载，无外部字体请求。
- 导航图标组件：复用用户提供的 youzhao 项目 `apps/console/src/Brand.tsx` 中的图标；工作台按 AIHub 浅色配色与 youzhao 桌面布局改造。
- token-flow 蓝色双路径汇流 Logo 为本项目原创 SVG。

- smol-toml 1.4.2：用于安全解析和重写 Codex TOML 配置，BSD-3-Clause，许可证见 `LICENSES/smol-toml-LICENSE`。原配置的注释和字节保留在备份中。

## Cursor SDK

`@cursor/sdk` 1.0.31 is used for official browser authentication, model discovery and explicitly limited text-only calls. It is subject to Cursor's terms; the original notice is included in `LICENSES/Cursor-SDK-LICENSE.md`. Cursor user SDK keys stay in the app's encrypted credential storage, separate from the IDE login. The SDK is not presented as a raw model API or an account-balance API.

## Pi maintenance engine

- `@earendil-works/pi-agent-core` and `@earendil-works/pi-ai` 0.87.0, MIT, https://github.com/earendil-works/pi. License included at `LICENSES/Pi-LICENSE.txt`.
- TypeBox 1.3.27, MIT, tool parameter schemas; license included at `LICENSES/TypeBox-LICENSE.txt`.
- Pi provides the stateful tool loop and Responses transport. Only the application's bounded gateway tools are installed; no coding-agent filesystem/shell toolset is loaded.
