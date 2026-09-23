import { callbackProvider } from './callback-flow.js';

/** ChatGPT / OpenAI 账号 → Codex。授权码流程，官方回跳到 127.0.0.1:1455。 */
export const codex = callbackProvider({
  id: 'codex', label: 'Codex', hint: '使用 ChatGPT / OpenAI 账号授权',
  route: '/codex-auth-url', accountProvider: 'codex', modelTypes: ['openai', 'codex'],
  authorization: {host: 'auth.openai.com', path: '/oauth/authorize'},
  callback: {port: 1455, path: '/auth/callback', upstream: 'codex'},
});
