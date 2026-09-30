import { deviceProvider } from './device-flow.js';

/** 使用官方 CLI 轮询授权，回调由 ZCode 服务器接收。 */
const provider = deviceProvider({
  id: 'zcode',
  label: 'ZCode',
  hint: '智谱 ZCode / Z.AI 账号授权',
  route: '/zcode-auth-url',
  accountProvider: 'zcode',
  modelTypes: ['zcode'],
  verification: { host: 'chat.z.ai', path: '/api/oauth/authorize' },
  requireUserCode: false,
});

export const zcode = {
  ...provider,
  validateAuthorizationURL(raw: string) {
    const url = provider.validateAuthorizationURL(raw);
    if (url.searchParams.get('redirect_uri') !== 'https://zcode.z.ai/api/v1/oauth/cli/callback/zai') {
      throw new Error('ZCode 授权回调配置已过期，请更新 Local Agent 后重新连接。');
    }
    return url;
  },
  parseStart(result: unknown) {
    const started = provider.parseStart(result);
    this.validateAuthorizationURL(started.url);
    return started;
  },
};
