import { deviceProvider } from './device-flow.js';

/**
 * Kimi Code（Moonshot AI）。设备码流程：CLIProxyAPI 向 auth.kimi.com 申请设备码，
 * 用户在 www.kimi.com 验证页确认 user_code；凭据由 CLIProxyAPI 轮询获取并保存为 kimi-*.json。
 */
export const kimi = deviceProvider({
  id: 'kimi', label: 'Kimi', hint: 'Kimi Code 订阅账号 · 设备码授权，无需本机回调',
  route: '/kimi-auth-url', accountProvider: 'kimi', modelTypes: ['kimi', 'moonshot'],
  verification: {host: 'www.kimi.com', path: '/code/authorize_device'},
});
