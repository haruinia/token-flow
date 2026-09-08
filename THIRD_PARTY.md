# 开源复用与修改记录

| 项目 | 固定提交 | 复用方式 |
| --- | --- | --- |
| [OpenAI CUA Sample](https://github.com/openai/openai-cua-sample-app) | `f2a3dc523ae406f9b704f9a420a05402a63b4522` | 复制 JavaScript Responses Loop、Worker/protocol/session/process、RunnerManager、Fastify run/SSE/artifact API、contracts 和 Console ScreenshotPane/helpers/types，保留其许可 |
| [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) | `d198db54d4c4886c99b21488d54fc576933019a3` | 不修改 Go 源码，编译独立 sidecar；复用 API 转换、模型路由和 OAuth 登录能力 |

许可证位于 `LICENSES/`。OpenAI 核心改造位于 `packages/core/src/`，协议位于 `packages/contracts/`，复用的截图组件位于 `apps/console/src/ScreenshotPane.tsx`。原始源码通过 `node scripts/fetch-upstream.mjs` 获取到被忽略的 `upstream/` 目录，可按固定提交比较；不把上游完整 Lab/Python 工程引入产品依赖。

本地改造包括：Provider 注入与无状态历史、human takeover tool、代码执行确认、独立持久 BrowserHost/CDP attach、环境白名单、Free-form task、localhost 鉴权、CLIProxy 管理和 Electron Shell。RunnerManager 的事件与 Replay v3 格式沿用上游；`browser` 是新增场景类型。

CLIProxyAPI 的配置文件与命令均根据该提交的 `config.example.yaml`、`cmd/server/main.go` 和 `internal/api/server_routes.go` 核对。升级时应重新跑真实 sidecar 与浏览器集成测试，不假设不同 Provider 的 Responses 能力一致。

账号连接复用该提交的 `/v0/management/codex-auth-url`、`anthropic-auth-url`、`get-auth-status`、`oauth-session`、`oauth-callback`、`auth-files`、`auth-files/status`。桌面端自建 loopback-only 回调接收器，不启用上游 `is_webui` 转发器，因为该版本转发器绑定 `0.0.0.0`。Go 源码保持原样。
