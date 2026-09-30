import { callbackProvider } from './callback-flow.js';

/** 字节跳动 Trae 账号。授权码流程，官方回跳到 127.0.0.1:1455。 */
const provider = callbackProvider({
  id: 'trae',
  label: 'Trae',
  hint: '字节跳动 Trae 账号授权',
  route: '/trae-auth-url',
  accountProvider: 'trae',
  modelTypes: ['trae'],
  authorization: { host: 'www.trae.ai', path: '/login' },
  callback: { port: 1455, path: '/authorize', upstream: 'trae' },
});

export const trae = {
  ...provider,
  validateAuthorizationURL(raw: string) {
    const url = provider.validateAuthorizationURL(raw);
    const target = new URL(url.searchParams.get('redirect_url') ?? '');
    if (target.origin !== 'https://www.trae.ai' || target.pathname !== '/authorization' || target.username || target.password || target.hash || target.searchParams.get('auth_callback_url') !== 'http://127.0.0.1:1455/authorize') {
      throw new Error('Trae 授权回调配置已过期，请更新 Local Agent 后重新连接。');
    }
    return url;
  },
  parseStart(result: unknown) {
    const started = provider.parseStart(result);
    this.validateAuthorizationURL(started.url);
    return started;
  },
};
