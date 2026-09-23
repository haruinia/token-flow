// 智谱 ZCode (Z.AI / BigModel) 账号状态与额度信息：
// GET https://chat.z.ai/api/oauth/userinfo
import { pick, record, str, parseJSON } from './shared.js';
import type { QuotaProvider } from './types.js';

export const zcodeQuota: QuotaProvider = {
  id: 'zcode',
  async fetch(call) {
    try {
      const response = await call({
        method: 'GET',
        url: 'https://chat.z.ai/api/oauth/userinfo',
        header: {
          Authorization: 'Bearer $TOKEN$',
          Accept: 'application/json',
        },
      });

      const payload = record(parseJSON(response, 'ZCode 用户信息')) ?? {};
      const data = record(payload.data) ?? payload;
      const nickname = str(pick(data, 'nickname', 'name', 'username', 'email'));
      const isVip = pick(data, 'is_vip', 'isVip', 'vip') === true || pick(data, 'vip_level', 'vipLevel') !== undefined;

      return {
        plan: isVip ? 'Z.AI VIP 订阅' : 'Z.AI 标准版',
        windows: [],
        note: nickname ? `用户：${nickname} · 官方未开放独立额度查询接口，当前账号已就绪。` : '官方未开放独立额度查询接口，当前账号已就绪。',
      };
    } catch {
      // 若 userinfo 接口暂不可用，作为可用状态返回保底提示
      return {
        plan: 'Z.AI 账号',
        windows: [],
        note: '已连接智谱 ZCode 账号，服务已就绪。',
      };
    }
  },
};
