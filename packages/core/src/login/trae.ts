import { callbackProvider } from './callback-flow.js';

/** 字节跳动 Trae 账号。授权码流程，官方回跳到 127.0.0.1:1455。 */
export const trae = callbackProvider({
  id: 'trae',
  label: 'Trae',
  hint: '字节跳动 Trae 账号授权',
  route: '/trae-auth-url',
  accountProvider: 'trae',
  modelTypes: ['trae'],
  authorization: { host: 'www.trae.ai', path: '/login' },
  callback: { port: 1455, path: '/trae/callback', upstream: 'trae' },
});
