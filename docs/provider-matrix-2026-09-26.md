# ZCode / Antigravity 接入复测（2026-09-26）

本轮使用已启用的真实账号，临时复制访问凭据到隔离网关，不复制刷新凭据。客户端任务只读写临时测试目录；Qoder 临时模型已清理，原模型已恢复。模型目录出现某模型，不代表该账号能调用。

## 结果

| 来源 | 目标 | 本次验证 | 结果 |
| --- | --- | --- | --- |
| Antigravity · gemini-3-flash | Codex 0.154.0 | 实际 app-server，读取、修改、执行测试；压缩上下文、重启网关和客户端、继续任务 | 通过 |
| Antigravity · gemini-3-flash | Qoder 独立应用 | 实际桌面，Read 工具，一次性审批，回传文件内容 | 通过 |
| Antigravity · gemini-3-flash | WorkBuddy CLI | 读取、修改、执行测试；重启后继续补全乘法，独立复验最终函数与测试 | 工具任务通过；摘要复用断言失败，不能宣称压缩完整兼容 |
| Antigravity · gemini-3-flash / gemini-3.8-flash-high | Claude Code 2.1.280 | 实际 CLI 完整任务和单个 Read 工具；后者将输出预算降至 4096 | 未通过，Google 返回 429 RESOURCE_EXHAUSTED，随后进入冷却并出现 503 |
| Antigravity | Cursor | 官方 API 接入要求核对；当前只有本机网关，没有公网 HTTPS 地址 | 未完成实际客户端调用 |
| ZCode · glm-4.7 / glm-5.1 | 三种网关协议 | Chat Completions、Messages、Responses | 均返回 429，无模型文本；不继续对每个客户端重复无额度请求 |

Antigravity 两个 Gemini 模型的小型文本请求，在 Chat Completions、Messages、Responses 均返回 200。Claude Code 失败期间，相同账号的简单请求仍通过，所以不能把该失败解释为整个账号已失效，也不能把协议探测成功等同于 Claude Code 实际通过。

ZCode 官方原始模型请求明确返回 HTTP 429、错误码 1113：Insufficient balance or no resource package。官方额度接口用同一业务凭据返回 HTTP 200、业务码 500、当前用户不存在 coding plan。登录已经有效，模型调用受到套餐/余额条件限制。

## 修复内容

- ZCode 额度查询改用 `https://api.z.ai/api/monitor/usage/quota/limit`，按官方客户端发送业务 token。此前错误地将业务 token 发给聊天 OAuth 用户资料接口，产生 401。
- 区分“未开通 Coding Plan”、真实认证失败和其他业务失败，不将失败显示成零用量或无限额度。经真实 sidecar `/api-call` 验证，当前账号显示“未开通 Z.AI Coding Plan”，不再显示 401。
- A2A 目标区域增加 Cursor，进入专门的手动配置页；要求已有外网 HTTPS 网关，不能生成声称可直连的 localhost 配置。没有自动发布本机服务或改动 Cursor 私有设置。
- 手动页的测试结果改称“网关协议测试”，明确仍需在实际客户端验证。

Cursor 官方说明所有 API Key 请求经过 Cursor 服务端，因此本机地址不能直接供该服务器访问。自定义 Key 只适用于聊天模型，Tab 仍使用内置模型：[官方说明](https://cursor.com/help/models-and-usage/api-keys)。这与将 Cursor 作为模型来源是不同方向。

## 复现与验证

- `npm run check`：30 个测试文件、224 项测试通过，类型检查和构建通过。
- `PROBE_QUOTA_ONLY=1 npx tsx scripts/provider-matrix-live.ts --live zcode`：真实额度桥接通过。
- `npx tsx scripts/provider-matrix-live.ts --live`：只记录模型 ID、HTTP 状态、响应类型，不输出凭据。
- `npx tsx scripts/agent-task-live.ts --live antigravity antigravity/gemini-3-flash codex,claude,workbuddy`：客户端实际任务；某客户端失败会中止，需要单独选择后续客户端。
- `npx tsx scripts/a2a-desktop-live.ts --live antigravity`：临时 Qoder 模型；结束时输入 `quit` 清理。

产物：`release/provider-matrix-20260926/mac-arm64/token-flow.app`。

Trae：本轮已在 Chrome 打开正确的官方登录入口；等待用户确认登录方式及官方页面的条款，尚未取得新授权，不能宣称通过。

已退出旧版并启动上述修复包，真实账号和原接入记录正常恢复。界面确认 A2A 显示五个目标，Cursor 按钮进入专属手动配置页；ZCode 真实账号卡片显示“未开通 Z.AI Coding Plan”。应用目前停留在 A2A 首页。
