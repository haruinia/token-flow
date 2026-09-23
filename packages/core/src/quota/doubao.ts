// 字节跳动 豆包 / MarsCode 账号状态与额度：
// MarsCode 采用公测与动态流控机制，无独立剩余额度查询端点。
import type { QuotaProvider } from './types.js';

export const doubaoQuota: QuotaProvider = {
  id: 'doubao',
  async fetch(_call, account) {
    return {
      plan: account.planType ?? 'MarsCode / 豆包',
      windows: [],
      note: '字节豆包当前采用动态流控机制，官方未设独立扣费额度上限，账号已就绪。',
    };
  },
};
