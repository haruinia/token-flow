// 登录会话状态机：一次只允许一个授权会话；负责启动、打开官方页面、轮询结果、回调提交、取消与超时。
// 具体 Provider 差异（授权地址校验、回调或设备码）由各 Provider 模块承担。
import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { loginProviders, loginProviderSchema } from './registry.js';
import { listenForCallback, validateCallbackURL } from './callback-flow.js';
import type { InternalLogin, LoginHost, LoginProviderId, LoginSession } from './types.js';

const pendingStates = new Set(['starting', 'waiting_for_browser', 'verifying']);
const statusSchema = z.object({status: z.enum(['ok', 'wait', 'error']), error: z.string().optional()});

export class LoginController {
  private session?: InternalLogin;
  private timer?: ReturnType<typeof setTimeout>;
  private callbackServers: Server[] = [];
  constructor(private host: LoginHost) {}

  snapshot(): LoginSession | undefined {
    const login = this.session;
    return login ? {id: login.id, provider: login.provider, flow: login.flow, status: login.status, message: login.message,
      url: login.url, userCode: login.userCode, expiresAt: login.expiresAt} : undefined;
  }
  get state() {return this.session?.status ?? 'idle';}
  isPending() {return !!this.session && pendingStates.has(this.session.status);}
  private current(id: string) {
    if (!this.isPending() || this.session!.id !== id) throw new Error('授权已结束或已过期，请重新连接账号。');
    return this.session!;
  }
  private finish(status: string, message: string, expected = this.session) {
    if (this.session !== expected) return;
    clearTimeout(this.timer);
    for (const server of this.callbackServers.splice(0)) server.close();
    if (!this.session) return;
    this.session.status = status; this.session.message = message;
    this.session.url = undefined; this.session.userCode = undefined;
    this.host.log(`${this.session.provider}: ${message}`);
  }
  /** Local Agent 进程退出等外部原因导致的失败。 */
  fail(message: string) {if (this.isPending()) this.finish('failed', message);}
  /** 关闭定时器与回调监听；不改变会话状态。 */
  close() {clearTimeout(this.timer); for (const server of this.callbackServers.splice(0)) server.close();}

  private timeout(expiresInMs?: number) {
    const limit = this.host.options.loginTimeoutMs;
    if (expiresInMs && limit) return Math.min(expiresInMs, limit);
    return expiresInMs ?? limit ?? 300000;
  }
  async login(providerId: LoginProviderId) {
    const provider = loginProviders[loginProviderSchema.parse(providerId)];
    if (this.isPending()) throw new Error('已有授权正在进行，请完成或取消后重试。');
    const login: InternalLogin = {id: randomUUID(), provider: provider.id, flow: provider.flow, status: 'starting', message: '正在启动服务并生成官方授权链接。'};
    this.session = login;
    try {
      await this.host.start();
      const raw = await this.host.request(provider.route);
      // 先记下 state：即使后续校验拒绝了授权地址，也要能取消上游会话。
      login.state = z.object({state: z.string().min(1)}).safeParse(raw).data?.state;
      const started = provider.parseStart(raw);
      if (!this.isPending() || this.session !== login) throw new Error('授权已取消');
      login.url = started.url; login.userCode = started.userCode;
      login.expiresAt = new Date(Date.now() + this.timeout(started.expiresInMs)).toISOString();
      login.status = 'waiting_for_browser';
      login.message = provider.flow === 'device'
        ? (started.userCode
            ? `请在官方页面登录，并确认设备码 ${started.userCode} 与此处一致。授权后 Local Agent 自动保存账号并刷新模型。`
            : '请在官方页面登录并确认授权。授权后 Local Agent 自动保存账号并刷新模型。')
        : '请在官方页面登录并授权，完成后将自动读取账号和模型。';
      const servers = await listenForCallback(provider, url => this.submitCallback(login.id, url));
      if (this.session !== login || !this.isPending()) {for (const server of servers) server.close(); return this.snapshot();}
      this.callbackServers = servers;
      this.schedulePoll(login);
      await this.open(login.id);
    } catch (error) {
      if (login.state) await this.host.request(`/oauth-session?state=${encodeURIComponent(login.state)}`, 'DELETE').catch(() => undefined);
      this.finish('failed', error instanceof z.ZodError ? '上游授权响应格式异常，请重试。' : error instanceof Error ? error.message : '授权启动失败，请重试。', login);
    }
    return this.snapshot();
  }
  async open(id: string) {
    const login = this.current(id);
    if (!login.url) throw new Error('授权链接尚未就绪');
    loginProviders[login.provider].validateAuthorizationURL(login.url);
    if (this.host.options.openExternal) {
      try {await this.host.options.openExternal(login.url);}
      catch {login.message = '自动打开浏览器失败。请复制下方授权链接到浏览器打开。';}
    }
    return this.snapshot();
  }
  private schedulePoll(login: InternalLogin) {
    if (this.host.closing() || this.session !== login || !this.isPending()) return;
    this.timer = setTimeout(() => {void this.poll(login);}, this.host.options.pollIntervalMs ?? 1000);
    this.timer.unref();
  }
  private async poll(login: InternalLogin) {
    if (this.session !== login || !this.isPending()) return;
    if (Date.now() >= Date.parse(login.expiresAt!)) {
      try {await this.cancel(login.id); this.finish('expired', '授权已超时，请重新连接。');}
      catch {this.finish('expired', '授权已超时，请重启 Local Agent 后重试。');}
      return;
    }
    try {
      const response = statusSchema.parse(await this.host.request(`/get-auth-status?state=${encodeURIComponent(login.state!)}`));
      if (this.session !== login || !this.isPending()) return;
      if (response.status === 'error') {
        // 不透出原始 token 交换错误（可能含密钥或回调参数）。
        this.finish('failed', '授权未完成或凭据交换失败。请重新连接，并检查网络或回调端口。'); return;
      }
      if (response.status === 'ok') {
        login.status = 'verifying'; login.message = '授权成功，正在读取已保存账号与模型列表。';
        await this.host.refreshAccounts();
        if (this.session !== login || !this.isPending()) return;
        const expected = loginProviders[login.provider].accountProvider;
        if (!this.host.accounts().some(account => account.provider === expected)) throw new Error('账号尚未加载');
        this.finish('completed', this.host.modelCount() ? '账号已保存，模型列表已自动刷新。请选择模型并探测能力。' : '账号已保存，但模型列表为空。请刷新列表或检查账号可用权限。');
        return;
      }
    } catch {if (this.session === login && this.isPending()) login.message = '正在等待 Local Agent 确认授权结果，可稍后重试或取消。';}
    this.schedulePoll(login);
  }
  async submitCallback(id: string, value: string) {
    const login = this.current(id);
    const provider = loginProviders[login.provider];
    if (!login.state || login.callbackSubmitted) throw new Error('回调已经提交或会话尚未就绪');
    const url = validateCallbackURL(provider, value, login.state);
    login.callbackSubmitted = true;
    try {
      await this.host.request('/oauth-callback', 'POST', {provider: provider.callback!.upstream, redirect_url: url.href});
      login.status = 'verifying'; login.message = '回调已提交，正在等待凭据交换。';
    } catch (error) {login.callbackSubmitted = false; throw error;}
    return this.snapshot();
  }
  async cancel(id: string) {
    const login = this.current(id);
    if (login.state) {
      const response = z.object({cancelled: z.boolean()}).parse(await this.host.request(`/oauth-session?state=${encodeURIComponent(login.state)}`, 'DELETE'));
      if (!response.cancelled) {login.message = '授权已结束，正在确认最终状态。'; return this.snapshot();}
    }
    this.finish('cancelled', '本次授权已取消，可重新连接。', login);
    return this.snapshot();
  }
}
