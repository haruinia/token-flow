# 中国 Agent 模型登录与额度展示独立实现规范

本文档阐述在当前项目（Browser Agent）内**完全独立实现**中国主流大模型 / Agent（Kimi、腾讯 WorkBuddy、阿里 Qoder、智谱 ZCode、字节豆包 MarsCode、字节 Trae）的登录接入与额度展示架构。

---

## 1. 架构原则

- **独立闭环**：不拉取、不依赖外部远程服务。底层复用当前项目内置的受管 `cliproxyapi` 本地 Sidecar（`127.0.0.1:8317`），通过本地管理端口 `/v0/management/api-call` 凭据注入机制请求官方 API。
- **保护隐私**：前端工作台不直接接触敏感 Token，所有 `$TOKEN$` 占位符由本地代理替换；官方 API 响应在桌面端归一化后进入 UI。
- **全量覆盖**：为所有已支持的国内模型提供统一的额度视图（QuotaWindow）或明确的状态反馈，消除空白卡片。
- **双模登录**：支持「官方 OAuth / 设备码网页授权」+「本地已安装 IDE 凭据一键免登录导入」。

---

## 2. 中国 Agent 模型矩阵与接口定义

| Provider | 厂商 | 登录方式 | 本地一键导入接口 | 额度/用量官方 API | 额度展示形态 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Kimi** | Moonshot | 设备码验证 (`/kimi-auth-url`) | 暂无 | `GET https://api.kimi.com/coding/v1/usages` | 5小时/周用量进度条、剩余次数、重置时间 |
| **WorkBuddy** | 腾讯云 / 企微智伴 | 网页授权 (`/workbuddy-auth-url`) | `POST /workbuddy-import-local` | `POST https://copilot.tencent.com/billing/meter/get-user-resource-summary` | 周期套餐容量、算力点已用/剩余、进度条 |
| **Qoder** | 阿里通义灵码 | 设备码验证 (`/qoder-auth-url`) | 暂无 | `GET https://openapi.qoder.sh/api/v2/quota/usage` | 额度使用百分比、已用/上限、周期窗口 |
| **ZCode** | 智谱 Z.AI | 授权码回跳 (`/zcode-auth-url`) | `POST /zcode-import-local` | `GET https://chat.z.ai/api/oauth/userinfo` | 会员/订阅等级 (VIP/标准)、账号正常状态提示 |
| **豆包** | 字节 MarsCode | 授权码回跳 (`/doubao-auth-url`) | `POST /doubao-import-local` | 官方暂无公开 REST 查余额端点 | 官方公测/免额度状态标识、账号就绪提示 |
| **Trae** | 字节跳动 | 授权码回跳 (`/trae-auth-url`) | `POST /trae-import-local` | 官方暂无公开 REST 查余额端点 | 官方公测/免额度状态标识、账号就绪提示 |

---

## 3. 详细设计与实现路线

### 3.1 额度层实现 (`packages/core/src/quota/`)

1. **`workbuddy.ts` (腾讯 WorkBuddy)**：
   - 请求：`POST https://copilot.tencent.com/billing/meter/get-user-resource-summary`，携带 `Authorization: Bearer $TOKEN$`, `X-Product: SaaS`, `Content-Type: application/json`，body: `{}`。
   - 解析：读取 `Packages` 数组中的 `PackageCode`、`CycleTotalCapacity`、`CycleRemainCapacity`、`CycleUsedCapacity`、`CapacityUnit`。
   - 换算：计算总已用/剩余点数与百分比，生成 `QuotaWindow`。
2. **`qoder.ts` (阿里 Qoder)**：
   - 请求：`GET https://openapi.qoder.sh/api/v2/quota/usage`，携带 `Authorization: Bearer $TOKEN$`, `Cosy-ClientType: CLIProxyAPI`。
   - 解析：解析 `used`、`limit`、`remaining` 等字段，换算百分比与周期。
3. **`zcode.ts` (智谱 ZCode)**：
   - 请求：`GET https://chat.z.ai/api/oauth/userinfo`。
   - 解析：获取用户身份与 VIP 状态，提示「账号已授权可用」。
4. **`doubao.ts` & `trae.ts` (字节豆包与 Trae)**：
   - 官方无单独查剩余算力的 REST 接口，返回确定状态报告并注明「官方采用动态流控机制，无固定额度限制，账号处于就绪状态」。
5. **`index.ts` 注册**：
   - 将上述 5 个 Provider 统一注册入 `quotaProviders`，使前端点击「刷新额度」时自动批量拉取。

### 3.2 登录层增强 (`packages/core/src/cliproxy.ts` & `service.ts`)

- 添加 `importLocal(provider)` 逻辑：
  当用户本地安装了 Trae、MarsCode、CodeBuddy 或 ZCode 时，直接调用本地 sidecar 的 `POST /<provider>-import-local` 读取本地 SQLite/文件凭据并生成账号，无需打开浏览器。
- 暴露出 API：`POST /api/local-agent/import-local`。

### 3.3 前端工作台展示 (`apps/console/src/LocalAgentPane.tsx`)

- **额度展示**：已登录国内账号在卡片中直接渲染额度进度条、已用/上限数值及重置倒计时。
- **一键导入**：在「添加账号」区域，为支持本地导入的国内 Provider 增加「从本机应用一键导入」快捷按钮。
