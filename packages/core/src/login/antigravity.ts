import { callbackProvider } from './callback-flow.js';

/** Antigravity（Google 账号）。授权码流程，官方回跳到 127.0.0.1:51121。可用模型由账号权限决定。 */
export const antigravity = callbackProvider({
  id: 'antigravity', label: 'Antigravity', hint: 'Google 账号授权 · Gemini 等可用模型以账号返回为准',
  route: '/antigravity-auth-url', accountProvider: 'antigravity', modelTypes: ['antigravity', 'google'],
  authorization: {host: 'accounts.google.com', path: '/o/oauth2/v2/auth'},
  callback: {port: 51121, path: '/oauth-callback', upstream: 'antigravity'},
});
