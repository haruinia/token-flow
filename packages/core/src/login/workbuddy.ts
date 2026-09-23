import { deviceProvider } from './device-flow.js';

/** 腾讯 WorkBuddy / CodeBuddy 账号。设备码/网页授权流程，在官方页面登录并确认。 */
export const workbuddy = deviceProvider({
  id: 'workbuddy',
  label: 'WorkBuddy',
  hint: '腾讯 WorkBuddy / CodeBuddy 账号授权',
  route: '/workbuddy-auth-url',
  accountProvider: 'workbuddy',
  modelTypes: ['workbuddy', 'tencent'],
  verification: { host: 'copilot.tencent.com', path: '/login' },
  requireUserCode: false,
});
