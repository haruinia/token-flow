// RFC 8628 设备码流程（Kimi / xAI）。上游 CLIProxyAPI 自行向 token 端点轮询并保存凭据；
// 桌面端只打开官方验证页、展示 user_code，并通过 /get-auth-status 观察结果。没有本机回调。
import { z } from 'zod';
import type { LoginProvider, LoginProviderId } from './types.js';

export type DeviceSpec = {
  id: LoginProviderId; label: string; hint: string; route: string; accountProvider: string; modelTypes: readonly string[];
  verification: {host: string; path: string};
  requireUserCode?: boolean;
};
const startSchema = z.object({
  status: z.literal('ok'), url: z.string(), state: z.string().min(1), flow: z.literal('device'),
  user_code: z.string().trim().min(1).max(64).optional(), expires_in: z.number().int().positive().optional(),
});

export function deviceProvider(spec: DeviceSpec): LoginProvider {
  const validateAuthorizationURL = (raw: string) => {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.hostname !== spec.verification.host || url.pathname !== spec.verification.path ||
        url.port || url.username || url.password || url.hash) throw new Error('上游返回了非预期的授权地址。');
    return url;
  };
  return {
    id: spec.id, label: spec.label, hint: spec.hint, flow: 'device', route: spec.route,
    accountProvider: spec.accountProvider, modelTypes: spec.modelTypes,
    validateAuthorizationURL,
    parseStart(result) {
      const parsed = startSchema.parse(result);
      const url = validateAuthorizationURL(parsed.url);
      const userCode = parsed.user_code ?? url.searchParams.get('user_code') ?? undefined;
      if (spec.requireUserCode !== false && !userCode) throw new Error('上游未返回设备码，请重试。');
      return {state: parsed.state, url: url.href, userCode, expiresInMs: parsed.expires_in ? parsed.expires_in * 1000 : undefined};
    },
  };
}
