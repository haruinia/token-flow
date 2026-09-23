// Antigravity 额度：POST v1internal:retrieveUserQuotaSummary {project}，返回 groups[].buckets[]（remainingFraction）。
import { isoFromAny, num, pick, record, str, parseJSON, QuotaHTTPError } from './shared.js';
import type { QuotaProvider, QuotaWindow } from './types.js';

const urls = [
  'https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary',
  'https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:retrieveUserQuotaSummary',
  'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary',
];
const headers = {
  Authorization: 'Bearer $TOKEN$', 'Content-Type': 'application/json',
  'User-Agent': 'antigravity/cli/1.0.13 (aidev_client; os_type=darwin; arch=arm64)',
};

export const antigravityQuota: QuotaProvider = {
  id: 'antigravity',
  async fetch(call, account) {
    if (!account.projectId) throw new Error('账号缺少 project_id，无法查询 Antigravity 额度。');
    let failure: Error | undefined;
    for (const url of urls) {
      try {
        const payload = record(parseJSON(await call({method: 'POST', url, header: headers, data: JSON.stringify({project: account.projectId})}), 'Antigravity 额度')) ?? {};
        const groups = Array.isArray(payload.groups) ? payload.groups : [];
        const windows: QuotaWindow[] = [];
        groups.forEach((group, gi) => {
          const entry = record(group); if (!entry) return;
          const groupLabel = str(pick(entry, 'displayName', 'display_name')) ?? `额度组 ${gi + 1}`;
          const buckets = Array.isArray(entry.buckets) ? entry.buckets : [];
          buckets.forEach((bucket, bi) => {
            const item = record(bucket); if (!item) return;
            const remaining = num(pick(item, 'remainingFraction', 'remaining_fraction')); if (remaining === undefined) return;
            const window = str(item.window);
            windows.push({
              id: str(pick(item, 'bucketId', 'bucket_id')) ?? `${gi}-${bi}`,
              label: `${groupLabel} · ${str(pick(item, 'displayName', 'display_name')) ?? window ?? `窗口 ${bi + 1}`}`,
              usedPercent: Math.max(0, Math.min(100, (1 - remaining) * 100)),
              resetsAt: isoFromAny(pick(item, 'resetTime', 'reset_time')),
            });
          });
        });
        if (windows.length) return {windows};
        failure = new Error('Antigravity 额度接口未返回配额组。');
      } catch (error) {
        failure = error instanceof Error ? error : new Error('Antigravity 额度查询失败。');
        // 403/404 表示该端点不适用于此账号，继续尝试下一个；其他错误也继续，最后统一上报。
        if (error instanceof QuotaHTTPError && ![403, 404].includes(error.status)) break;
      }
    }
    throw failure ?? new Error('Antigravity 额度查询失败。');
  },
};
