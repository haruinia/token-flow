import type { QuotaResponse } from './types.js';

export class QuotaHTTPError extends Error {
  constructor(readonly status: number, message: string) {super(message);}
}
export type Record_ = Record<string, unknown>;

export const record = (value: unknown): Record_ | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record_ : undefined;
export const num = (value: unknown): number | undefined => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string' && value.trim()) {const n = Number(value.trim()); return Number.isFinite(n) ? n : undefined;}
  const inner = record(value)?.val; // xAI 金额对象 {val: cents}
  return inner === undefined ? undefined : num(inner);
};
export const str = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value.trim() : undefined;
/** 上游用 camelCase / snake_case 混用；按顺序取第一个存在的字段。 */
export const pick = (source: Record_ | undefined, ...keys: string[]) => {
  for (const key of keys) if (source && source[key] !== undefined && source[key] !== null) return source[key];
  return undefined;
};
/** ISO 字符串、epoch 秒或毫秒 → ISO。 */
export const isoFromAny = (value: unknown): string | undefined => {
  const n = num(value);
  if (n !== undefined) {const ms = n > 1e12 ? n : n * 1000; return ms > 0 ? new Date(ms).toISOString() : undefined;}
  const s = str(value); if (!s) return undefined;
  const ms = Date.parse(s); return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
};
export const isoAfterSeconds = (seconds: unknown, now = Date.now()) => {
  const n = num(seconds); return n === undefined ? undefined : new Date(now + n * 1000).toISOString();
};
export const percent = (used: number | undefined, limit: number | undefined) =>
  used === undefined || !limit || limit <= 0 ? null : Math.max(0, Math.min(100, (used / limit) * 100));
export const clampPercent = (value: unknown) => {const n = num(value); return n === undefined ? null : Math.max(0, Math.min(100, n));};

/** 秒数 → “5 小时 / 7 天”。 */
export const windowLabel = (seconds: number | undefined) => {
  if (!seconds) return undefined;
  if (seconds % 86400 === 0) return `${seconds / 86400} 天`;
  if (seconds % 3600 === 0) return `${seconds / 3600} 小时`;
  return `${Math.round(seconds / 60)} 分钟`;
};

/** 只接受 2xx 且 JSON 可解析；错误信息不带上游响应正文。 */
export function parseJSON(response: QuotaResponse, what: string): unknown {
  if (response.statusCode < 200 || response.statusCode >= 300) throw new QuotaHTTPError(response.statusCode, `${what}请求失败（HTTP ${response.statusCode}）。`);
  try {return JSON.parse(response.body);} catch {throw new Error(`${what}返回了无法解析的内容。`);}
}
