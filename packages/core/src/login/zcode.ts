import { callbackProvider } from './callback-flow.js';

/** 智谱 ZCode / Z.AI 账号。授权码流程，官方回跳到 127.0.0.1:9999。 */
export const zcode = callbackProvider({
  id: 'zcode',
  label: 'ZCode',
  hint: '智谱 ZCode / Z.AI 账号授权',
  route: '/zcode-auth-url',
  accountProvider: 'zcode',
  modelTypes: ['zcode'],
  authorization: { host: 'chat.z.ai', path: '/api/oauth/authorize' },
  callback: { port: 9999, path: '/zcode/callback', upstream: 'zcode' },
});
