// 字节跳动 Trae 账号状态与额度：
// 当前接入尚未实现 Trae 剩余额度查询。
import type { QuotaProvider } from './types.js';

export const traeQuota: QuotaProvider = {
  id: 'trae',
  async fetch(_call, account) {
    return {
      plan: account.planType ?? 'Trae 账号',
      windows: [],
      note: '此接入尚未读取 Trae 剩余额度，请以 Trae 官方页面显示为准。',
    };
  },
};
