import { expect, it } from 'vitest';
import { zcode } from '../packages/core/src/login/zcode.js';
import { trae } from '../packages/core/src/login/trae.js';
import { validateCallbackURL } from '../packages/core/src/login/callback-flow.js';

it('uses ZCode server-side polling instead of an unregistered localhost redirect', () => {
  const url = 'https://chat.z.ai/api/oauth/authorize?state=session&redirect_uri=https%3A%2F%2Fzcode.z.ai%2Fapi%2Fv1%2Foauth%2Fcli%2Fcallback%2Fzai';
  expect(zcode.flow).toBe('device');
  expect(zcode.callback).toBeUndefined();
  expect(zcode.parseStart({ status: 'ok', flow: 'device', state: 'session', url, expires_in: 300 }).url).toBe(url);
  expect(() => zcode.parseStart({ status: 'ok', flow: 'device', state: 'session', url: url.replace('https%3A%2F%2Fzcode.z.ai', 'http%3A%2F%2Flocalhost') })).toThrow();
});

it('correlates the official Trae callback using loginTraceID and preserves its credentials', () => {
  const callback = 'http://127.0.0.1:1455/authorize?' + new URLSearchParams({ loginTraceID: 'session', userJwt: 'fixture-jwt', refreshToken: 'fixture-refresh', host: 'https://api-us-east.trae.ai', userInfo: JSON.stringify({ UserID: 'fixture-user' }) });
  const parsed = validateCallbackURL(trae, callback, 'session');
  expect(parsed.searchParams.get('state')).toBe('session');
  expect(parsed.searchParams.get('userJwt')).toBe('fixture-jwt');
  expect(() => validateCallbackURL(trae, callback, 'stale')).toThrow();
  expect(() => validateCallbackURL(trae, callback.replace('api-us-east.trae.ai', 'evil.test'), 'session')).toThrow();
  expect(() => validateCallbackURL(trae, callback + '&state=other', 'session')).toThrow();
});
