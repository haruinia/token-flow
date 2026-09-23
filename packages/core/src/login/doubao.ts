import { callbackProvider } from './callback-flow.js';

/** 字节跳动豆包 / MarsCode 账号。授权码流程，官方回跳到 127.0.0.1:1455。 */
export const doubao = callbackProvider({
  id: 'doubao',
  label: '豆包',
  hint: '字节跳动豆包 / MarsCode 账号授权',
  route: '/doubao-auth-url',
  accountProvider: 'doubao',
  modelTypes: ['doubao'],
  authorization: { host: 'www.marscode.cn', path: '/authorization' },
  callback: { port: 1455, path: '/doubao/callback', upstream: 'doubao' },
});
