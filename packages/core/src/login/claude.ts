import { callbackProvider } from './callback-flow.js';

/** Claude 账号。授权码流程，官方回跳到 127.0.0.1:54545。 */
export const claude = callbackProvider({
  id: 'claude', label: 'Claude', hint: '使用 Claude 账号授权',
  route: '/anthropic-auth-url', accountProvider: 'claude', modelTypes: ['claude', 'anthropic'],
  authorization: {host: 'claude.ai', path: '/oauth/authorize'},
  callback: {port: 54545, path: '/callback', upstream: 'anthropic'},
});
