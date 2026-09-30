# A2A 实际验收 · 2026-09-26

箭头表示“模型来源 → 本地执行工具的客户端”。本轮使用当前保存的账号和指定模型，不代表同厂商所有账号、模型都可用。没有把配置写入、HTTP 200 或模拟上游当作真实链路通过。

## 七条链路

| 来源 → 目标 | 正常对话 | 工具调用及回传 | 对话压缩、继续 | 权限审批 | 客户端及结论 |
| --- | --- | --- | --- | --- | --- |
| Antigravity → Qoder | 失败：403 | 未到达 | 未到达 | 未到达 | Qoder 独立应用实机；gemini-3-flash 首轮请求被上游拒绝，后续重试 503，已停止 |
| Antigravity → WorkBuddy | 失败：403 | 未到达 | 未到达 | 未到达 | WorkBuddy 原生内置 CLI；gemini-3-flash、gemini-3.8-flash-high 均未完成首轮任务 |
| WorkBuddy → Claude Code | 通过 | Read/Edit/Bash 通过 | 原生 /compact、网关重启、恢复任务通过 | 真实 Auto Mode 分类器、允许执行、回传通过；本轮未单独验证手动拒绝 | HY4-preview → Claude Code 2.1.280 |
| WorkBuddy → Codex | 来源策略拒绝 | 未到达 | 未到达 | 未到达 | HY4-preview → Codex 0.154.0；a2a_source_policy_blocked，willRetry=false |
| Qoder → WorkBuddy | 通过 | 读取、编辑、运行测试及续聊通过 | **未通过验收**：产生摘要，但未验证摘要被后续请求沿用；原生历史检查也未找到压缩边界 | 真实 SDK 权限回调：拒绝不写文件；允许才写入；结果均回传 | kmodel_latest → WorkBuddy 原生内置 CLI；不是桌面 GUI 全流程通过 |
| WorkBuddy → Qoder | 通过 | Read、Bash 通过 | 独立应用原生“压缩上下文”后，记忆和 Read 续聊通过 | 实机拒绝、允许一次均通过 | HY4-preview → Qoder 独立应用；修复 Responses 流后复测通过 |
| Qoder → Codex | 通过 | 修改代码、运行测试、回传通过 | 原生 contextCompaction、网关重启、恢复任务通过 | 真实 on-request/read-only：拒绝不写文件，允许才写入 | kmodel_latest → Codex 0.154.0 隔离 app-server；未改开发中 Codex 配置 |

## 本轮修复

1. **Qoder 账号提示不应以 IDE 的企业登录作判断。** 目标配置为 Qoder 独立应用的 `~/.qoder/settings.json`。实机已确认个人账号能看到、选择和使用自定义模型；未操作 Qoder IDE。移除了“企业账号不支持，请切个人账号”的笼统提示，明确以独立应用当前账号和模型入口为准。[独立应用官方说明](https://docs.qoder.com/qoder/custom-models)
2. **交错推理段重复 ID 导致 Qoder 严格解析失败。** 实机报 `Invalid OpenAI Responses stream: inconsistent_reasoning`。上游 Chat → Responses 转换器在同一 choice 出现“推理 → 正文 → 推理”时重复使用 reasoning item ID。通过现有 sidecar overlay 给每段分配唯一 ID；没有改写 upstream checkout。新增回归检查 item ID 唯一、推理增量与 done/最终 summary 一致。修复前失败、修复后通过，实机读取文件及压缩后续聊通过。
3. **验收脚本按客户端实际行为断言。** Codex 0.154.0 的本轮原生压缩走 Responses 摘要请求并产生 `contextCompaction` 完成事件，不能要求一定请求 `/responses/compact`。WorkBuddy CLI 即使报告模型错误也可能退出 0，脚本另外检查 result.is_error。测试不再只凭退出码判定成功。

## WorkBuddy 压缩仍待确认

`/compact` 能生成 `<conversation_history_summary>`。但网关重启、`--resume` 后的请求没有检测到该摘要的实际内容；没有把“写出摘要”当成“压缩完成”。进一步调用客户端列出的 `/_compact` 产生简短任务回顾，但在隔离客户端目录中未发现 `isCompacted`、`isSummary` 或 compact_boundary 标志。以上不足以确认原生会话压缩生效，也不足以认定是网关转换错误，仍需 WorkBuddy 桌面会话的进一步验证。读取文件、修改代码和继续任务是通过的。

一次重复测试还遇到 Qoder 来源 500；随后同模型重新测试工具任务成功。该现象保留为来源稳定性限制，不把它归为压缩问题。

## 验证与证据

- 类型检查、应用构建、sidecar 构建、差异格式检查通过。
- Go Qoder / WorkBuddy / AgentContract 协议回归通过，包括新增交错推理测试。
- Vitest 首轮 209/210 通过，浏览器扩展集成测试 15 秒超时；单独重跑该文件 2/2 通过。没有隐藏首次失败。
- WorkBuddy → Qoder：真实任务 `4da85ac4-d104-4010-a721-3efe21a32725`。修复后读取返回测试标记，批准后文件内容为 `approved`；原生压缩后能回忆此前标记，并读取新文件。记录在 Qoder 本地测试任务中。
- Qoder → Codex：14 次真实请求、12 次带工具结果请求；压缩前修复 add，压缩及网关重启后实现 multiply，两阶段独立运行测试通过。
- Qoder → Codex、Qoder → WorkBuddy 审批分别额外进行允许/拒绝双分支真实测试。测试控制端只允许已核对的临时目录命令，不由模型或网关替代本地审批。
- 单独运行过真实 Codex + 合成 Responses 上游的本地审批回归；它只补充本地权限保持证据，没有用它冒充真实来源测试。

隔离证据目录均位于系统临时目录（只保留测试项目、日志和脱敏请求元数据）：

| 内容 | 目录名 |
| --- | --- |
| WorkBuddy → Claude 任务、压缩、续聊；WorkBuddy → Codex 策略阻断 | token-flow-agent-task-A5ndU0 |
| Qoder → Codex 工具、压缩、重启续聊 | token-flow-agent-task-7SzBvF |
| Qoder → Codex 真实允许/拒绝 | token-flow-agent-task-GEZx2b |
| Qoder → WorkBuddy 真实允许/拒绝 | token-flow-agent-task-CHW8D8 |
| Qoder → WorkBuddy 工具、摘要沿用检查 | token-flow-agent-task-CNllwG |
| WorkBuddy 原生 /_compact 及历史边界检查 | token-flow-agent-task-lutSMK |
| Qoder 实机修复前、修复后 | token-flow-desktop-acceptance-smIowh、token-flow-desktop-acceptance-4cafAm |
| Antigravity → WorkBuddy 两模型请求 | token-flow-agent-task-36jQjI、token-flow-agent-task-v6dCY2 |

本轮 sidecar SHA-256：`443e6bf7a447ae3a0466c741bcae3c10d34c9c8e2f7f79ae31385a51fe9cffec`。

## 清理与当前应用

测试使用访问令牌副本，未复制共享 refresh token，也未轮换用户登录。Qoder 临时添加的两个验收 provider 已移除，原模型选择已恢复；测试复制的凭据、生成的网关 Key、隔离客户端配置均已清理。测试任务及临时文件保留供核对，没有删除用户原会话。

token-flow 已用当前构建重新启动，实机确认新的 Qoder 账号说明已显示；当前开发用 Codex 配置未被测试切换。此次没有生成新的分发安装包。

## 网络调整后复测 · 13:16–13:20

用户说明已调整网络后，重新启动隔离网关并读取新鲜的已保存授权（到期时间为 14:06，未使用此前的副本）。WorkBuddy 内置 CLI 分别请求 gemini-3-flash、gemini-3.8-flash-high，仍在首轮返回 403；Qoder 独立应用真实请求 gemini-3-flash 同样返回 403。

进一步读取隔离 sidecar 的脱敏错误，确认本次具体原因为 Google `PERMISSION_DENIED` / `VALIDATION_REQUIRED`，消息 `Verify your account to continue.`。后续本地 503 携带 auth_unavailable，保留的最后一次上游错误仍为上述账号验证要求。因此本次不能把失败仅归因于网络，也不能标记反重力两条链路通过。需要核对当前可用客户端与网关保存的是否同一账号，以及验证后的授权状态。

证据目录：`token-flow-agent-task-LpriLp`（gemini-3-flash）、`token-flow-agent-task-tSYMvD`（gemini-3.8-flash-high）、`token-flow-desktop-acceptance-XwE1yw`（Qoder 实机）。临时接入和复制的授权已清理，未改动用户登录或尝试绕过验证。
