import { deviceProvider } from './device-flow.js';

/**
 * xAI Grok。设备码流程：CLIProxyAPI 通过 auth.x.ai 的 OIDC discovery 申请设备码，
 * 用户在 accounts.x.ai 验证页确认 user_code；凭据由 CLIProxyAPI 轮询获取并保存。
 */
export const xai = deviceProvider({
  id: 'xai', label: 'xAI Grok', hint: 'xAI 账号 · 设备码授权，Grok 系列模型',
  route: '/xai-auth-url', accountProvider: 'xai', modelTypes: ['xai', 'grok'],
  verification: {host: 'accounts.x.ai', path: '/oauth2/device'},
});
