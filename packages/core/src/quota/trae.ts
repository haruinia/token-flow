// 字节跳动 Trae 账号状态与额度：
// Trae 采用公测与并发流控策略，官方未开放独立剩余配额查询端点。
import type { QuotaProvider } from './types.js';

export const traeQuota: QuotaProvider = {
  id: 'trae',
  async fetch(_call, account) {
    return {
      plan: account.planType ?? 'Trae 订阅/公测版',
      windows: [],
      note: 'Trae 账号已就绪，当前采用并发模型流控机制，无固定消耗限额。',
    };
  },
};
