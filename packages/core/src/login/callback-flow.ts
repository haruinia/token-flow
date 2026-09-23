// 授权码 + 本机 loopback 回调流程（Codex / Claude / Antigravity）。
import { createServer as createHTTPServer, type Server, type RequestListener } from 'node:http';
import { z } from 'zod';
import type { LoginProvider, LoginProviderId } from './types.js';

export type CallbackSpec = {
  id: LoginProviderId; label: string; hint: string; route: string; accountProvider: string; modelTypes: readonly string[];
  authorization: {host: string; path: string};
  callback: {port: number; path: string; upstream: string};
};
const startSchema = z.object({status: z.literal('ok'), url: z.string(), state: z.string().min(1)});

export function callbackProvider(spec: CallbackSpec): LoginProvider {
  const validateAuthorizationURL = (raw: string) => {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.hostname !== spec.authorization.host || url.pathname !== spec.authorization.path ||
        url.port || url.username || url.password || url.hash) throw new Error('上游返回了非预期的授权地址。');
    return url;
  };
  return {
    id: spec.id, label: spec.label, hint: spec.hint, flow: 'callback', route: spec.route,
    accountProvider: spec.accountProvider, modelTypes: spec.modelTypes, callback: spec.callback,
    validateAuthorizationURL,
    parseStart(result) {
      const parsed = startSchema.parse(result);
      const url = validateAuthorizationURL(parsed.url);
      const stateFromRedirect = (() => {
        const redirect = url.searchParams.get('redirect_url');
        if (!redirect) return null;
        try {
          return new URL(redirect).searchParams.get('state');
        } catch {
          return null;
        }
      })();
      const state = url.searchParams.get('state') ?? stateFromRedirect;
      if (state !== parsed.state) throw new Error('授权会话校验失败，请重新连接。');
      return {state: parsed.state, url: url.href};
    },
  };
}

/** 校验用户粘贴或浏览器回跳的 localhost 回调地址属于本次会话。 */
export function validateCallbackURL(provider: LoginProvider, value: string, state: string) {
  if (!provider.callback) throw new Error(`${provider.label} 使用设备码授权，不需要回调地址。`);
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(url.hostname) || url.port !== String(provider.callback.port) ||
      url.pathname !== provider.callback.path || url.username || url.password || url.hash || url.searchParams.get('state') !== state ||
      (!url.searchParams.get('code') && !url.searchParams.get('error') && !url.searchParams.get('authCodeInfo'))) throw new Error('请粘贴本次授权完成后的完整 localhost 回调地址，不能使用旧会话地址。');
  return url;
}

/** 上游 web-UI 转发器绑定 0.0.0.0；这里改为只监听 loopback 的自有回调。 */
export async function listenForCallback(provider: LoginProvider, submit: (redirectURL: string) => Promise<unknown>): Promise<Server[]> {
  const callback = provider.callback;
  if (!callback) return [];
  const {port, path} = callback;
  const handler: RequestListener = async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    response.setHeader('Content-Type', 'text/plain; charset=utf-8');
    if (request.method !== 'GET' || ![`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`].includes(request.headers.host ?? '') ||
        request.url?.split('?')[0] !== path) {response.writeHead(400); response.end('无效授权回调。'); return;}
    try {
      await submit(`http://localhost:${port}${request.url}`);
      response.end('授权回调已收到。请返回 token-flowb 查看连接结果，可以关闭此页面。');
    } catch {response.writeHead(400); response.end('回调未被接受，可能已提交或会话已过期。请返回 token-flowb 查看状态。');}
  };
  const servers: Server[] = [];
  try {
    for (const host of ['127.0.0.1', '::1']) {
      const server = createHTTPServer(handler);
      server.requestTimeout = 10000; server.headersTimeout = 5000;
      try {
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject);
          server.listen({port, host, ipv6Only: host === '::1'}, resolve);
        });
      } catch (error) {
        if (host === '::1' && ['EAFNOSUPPORT', 'EADDRNOTAVAIL'].includes((error as NodeJS.ErrnoException).code ?? '')) continue;
        throw error;
      }
      servers.push(server); server.unref();
    }
  } catch {
    for (const server of servers) server.close();
    throw new Error(`授权回调端口 ${port} 无法监听。请关闭其他登录流程后重试。`);
  }
  return servers;
}
