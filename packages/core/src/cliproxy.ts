import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { createServer as createHTTPServer, type Server, type RequestListener } from 'node:http';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { safeEnvironment } from './browser/host.js';

const providerSchema = z.enum(['codex', 'claude', 'antigravity']);
type LoginProvider = z.infer<typeof providerSchema>;
const loginProviders = {
  codex: {host:'auth.openai.com',authPath:'/oauth/authorize',route:'/codex-auth-url',port:1455,path:'/auth/callback',upstream:'codex'},
  claude: {host:'claude.ai',authPath:'/oauth/authorize',route:'/anthropic-auth-url',port:54545,path:'/callback',upstream:'anthropic'},
  antigravity: {host:'accounts.google.com',authPath:'/o/oauth2/v2/auth',route:'/antigravity-auth-url',port:51121,path:'/oauth-callback',upstream:'antigravity'},
} as const;
const pendingStates = new Set(['starting', 'waiting_for_browser', 'verifying']);
const accountSchema = z.object({
  name: z.string(), provider: z.string().optional(), type: z.string().optional(),
  email: z.string().optional(), label: z.string().optional(), status: z.string().optional(),
  disabled: z.boolean().optional(), unavailable: z.boolean().optional(),
});
export type LocalAccount = {id: string; provider: string; label: string; status: string; disabled: boolean; unavailable: boolean};
export type LoginSession = {
  id: string; provider: LoginProvider; status: string; message: string;
  url?: string; expiresAt?: string;
};
type InternalLogin = LoginSession & {state?: string; callbackSubmitted?: boolean};
export type CLIProxyOptions = {openExternal?: (url: string) => Promise<void>; pollIntervalMs?: number; loginTimeoutMs?: number};

export function validateAuthorizationURL(raw: string, provider: LoginProvider) {
  const url = new URL(raw);
  const {host, authPath} = loginProviders[provider];
  if (url.protocol !== 'https:' || url.hostname !== host || url.pathname !== authPath ||
      url.port || url.username || url.password || url.hash) throw new Error('上游返回了非预期的授权地址。');
  return url;
}

export class CLIProxyManager {
  private child?: ChildProcess;
  private busy = false;
  private closing = false;
  private recent: string[] = [];
  private configPath: string;
  private state = 'stopped';
  private managementKey = randomBytes(32).toString('hex');
  private loginSession?: InternalLogin;
  private timer?: ReturnType<typeof setTimeout>;
  private callbackServers: Server[] = [];
  private accounts: LocalAccount[] = [];
  private names = new Map<string, string>();
  private models: {id: string}[] = [];
  private accountError?: string;
  constructor(readonly root: string, readonly binary: string, private key: string,
    readonly port = 8317, private options: CLIProxyOptions = {}) {
    this.configPath = join(root, 'cliproxy', 'config.yaml');
  }
  snapshot() {
    const login = this.loginSession;
    return structuredClone({state: this.state, loginState: login?.status ?? 'idle', port: this.port,
      logs: this.recent, accounts: this.accounts, models: this.models, accountError: this.accountError,
      login: login ? {id: login.id, provider: login.provider, status: login.status,
        message: login.message, url: login.url, expiresAt: login.expiresAt} : undefined});
  }
  private log(message: string) {
    this.recent.push(`${new Date().toISOString()} ${message}`);
    this.recent = this.recent.slice(-100);
  }
  async configure() {
    const dir = join(this.root, 'cliproxy');
    await mkdir(join(dir, 'auth'), {recursive: true, mode: 0o700});
    await chmod(dir, 0o700);
    // Upstream management stays on loopback. Neither key is returned to the renderer.
    const yaml = `host: "127.0.0.1"\nport: ${this.port}\nauth-dir: ${JSON.stringify(join(dir, 'auth'))}\napi-keys:\n  - ${JSON.stringify(this.key)}\nremote-management:\n  allow-remote: false\n  secret-key: ${JSON.stringify(this.managementKey)}\n  disable-control-panel: true\ndebug: false\nlogging-to-file: false\nrequest-log: false\nrequest-retry: 0\n`;
    await writeFile(this.configPath, yaml, {mode: 0o600});
    await chmod(this.configPath, 0o600);
  }
  private async request(path: string, method = 'GET', body?: unknown, management = true): Promise<unknown> {
    const response = await fetch(`http://127.0.0.1:${this.port}${management ? '/v0/management' : '/v1'}${path}`, {
      method, headers: {Authorization: `Bearer ${management ? this.managementKey : this.key}`, 'Content-Type': 'application/json'},
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000), redirect: 'error',
    }).catch(() => {throw new Error('无法连接 Local Agent，请检查服务状态后重试。');});
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Local Agent 接口请求失败（HTTP ${response.status}）。请重试；登录启动失败也可能是 1455 / 54545 / 51121 回调端口被占用。`);
    }
    return response.json().catch(() => {throw new Error('Local Agent 返回了无效响应，请重启服务后重试。');});
  }
  async start() {
    if (this.closing) throw new Error('Local Agent 正在退出');
    if (this.busy) throw new Error('Local Agent 正在启动或停止');
    if (this.child) return this.snapshot();
    this.busy = true;
    this.state = 'starting';
    try {
      await this.configure();
      await new Promise<void>((resolve, reject) => {
        const server = createServer();
        server.once('error', () => reject(new Error(`端口 ${this.port} 已被占用，未接管已有服务。`)));
        server.listen(this.port, '127.0.0.1', () => server.close(() => resolve()));
      });
      const child = spawn(this.binary, ['-config', this.configPath], {
        env: safeEnvironment(), stdio: ['ignore', 'pipe', 'pipe'], cwd: join(this.root, 'cliproxy'),
      });
      this.child = child;
      let failure: Error | undefined;
      child.on('error', () => {
        failure = new Error('CLIProxyAPI 二进制无法启动；请先运行 npm run sidecar:build');
        this.state = 'failed'; this.child = undefined;
      });
      child.on('exit', code => {
        if (this.child === child) this.child = undefined;
        this.state = code === 0 ? 'stopped' : 'failed';
        if (this.isPending()) this.finishLogin('failed', 'Local Agent 已退出，请重新启动并连接账号。');
        this.log(`Local Agent 已退出 (${code})`);
      });
      child.stdout?.resume(); child.stderr?.resume();
      for (let i = 0; i < 100; i++) {
        if (failure) throw failure;
        if (child.exitCode !== null) throw new Error('CLIProxyAPI 启动失败');
        let ready = false;
        try {
          const response = await fetch(`http://127.0.0.1:${this.port}/v1/models`, {
            headers: {Authorization: `Bearer ${this.key}`}, signal: AbortSignal.timeout(500),
          });
          ready = response.ok; await response.body?.cancel();
        } catch { /* Readiness may lag process startup. */ }
        if (ready) {
          this.state = 'running'; this.log('Local Agent 已就绪');
          await this.refreshAccounts();
          return this.snapshot();
        }
        await new Promise(r => setTimeout(r, 100));
      }
      throw new Error('CLIProxyAPI 健康检查超时');
    } catch (error) {
      await this.terminate(this.child); this.child = undefined; this.state = 'failed'; throw error;
    } finally { this.busy = false; }
  }
  private async terminate(child?: ChildProcess) {
    if (!child || child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => child.kill('SIGKILL'), 1500);
      child.once('exit', () => {clearTimeout(timer); resolve();});
      child.once('error', () => {clearTimeout(timer); resolve();});
      child.kill('SIGTERM');
    });
  }
  async stop() {
    if (this.busy) throw new Error('Local Agent 正在切换状态');
    this.busy = true;
    try {
      if (this.isPending()) {
        try {await this.cancelLogin(this.loginSession!.id);}
        catch {this.log('无法确认授权取消；停止进程以终止本次授权。');}
      }
      await this.terminate(this.child); this.child = undefined; this.state = 'stopped';
      this.models = []; this.log('Local Agent 已停止'); return this.snapshot();
    } finally {this.busy = false;}
  }
  async refreshAccounts() {
    if (this.state !== 'running') throw new Error('请先启动 Local Agent');
    try {
      const result = z.object({files: z.array(accountSchema)}).parse(await this.request('/auth-files'));
      const names = new Map<string, string>();
      const accounts = result.files.map(file => {
        const id = createHash('sha256').update(file.name).digest('hex').slice(0, 24);
        names.set(id, file.name);
        return {id, provider: file.provider ?? file.type ?? 'unknown', label: (file.email || file.label || '已保存的账号').slice(0, 200),
          status: file.status ?? 'unknown', disabled: file.disabled ?? false, unavailable: file.unavailable ?? false};
      });
      const models = z.object({data: z.array(z.object({id: z.string()}))}).parse(await this.request('/models', 'GET', undefined, false));
      this.accounts = accounts; this.names = names; this.models = models.data; this.accountError = undefined;
    } catch {
      this.accountError = '账号或模型列表读取失败。请刷新，必要时重启 Local Agent。';
      throw new Error(this.accountError);
    }
    return this.snapshot();
  }
  async setAccountEnabled(id: string, enabled: boolean) {
    const name = this.names.get(id);
    if (!name) throw new Error('账号已变更，请刷新账号列表');
    await this.request('/auth-files/status', 'PATCH', {name, disabled: !enabled});
    return this.refreshAccounts();
  }
  private isPending() {return !!this.loginSession && pendingStates.has(this.loginSession.status);}
  private current(id: string) {
    if (!this.isPending() || this.loginSession!.id !== id) throw new Error('授权已结束或已过期，请重新连接账号。');
    return this.loginSession!;
  }
  private finishLogin(status: string, message: string, expected = this.loginSession) {
    if (this.loginSession !== expected) return;
    clearTimeout(this.timer);
    for (const server of this.callbackServers.splice(0)) server.close();
    if (!this.loginSession) return;
    this.loginSession.status = status; this.loginSession.message = message;
    this.loginSession.url = undefined;
    this.log(`${this.loginSession.provider}: ${message}`);
  }
  async login(provider: LoginProvider) {
    providerSchema.parse(provider);
    if (this.isPending()) throw new Error('已有授权正在进行，请完成或取消后重试。');
    const login: InternalLogin = {id: randomUUID(), provider, status: 'starting', message: '正在启动服务并生成官方授权链接。'};
    this.loginSession = login;
    try {
      await this.start();
      const route = loginProviders[provider].route;
      const result = z.object({status: z.literal('ok'), url: z.string(), state: z.string().min(1)}).parse(await this.request(route));
      login.state = result.state;
      const url = validateAuthorizationURL(result.url, provider);
      if (url.searchParams.get('state') !== result.state) throw new Error('授权会话校验失败，请重新连接。');
      if (!this.isPending() || this.loginSession !== login) throw new Error('授权已取消');
      login.url = url.href;
      login.expiresAt = new Date(Date.now() + (this.options.loginTimeoutMs ?? 300000)).toISOString();
      login.status = 'waiting_for_browser'; login.message = '请在官方页面登录并授权，完成后将自动读取账号和模型。';
      await this.listenForCallback(login);
      this.schedulePoll(login);
      await this.openLogin(login.id);
    } catch (error) {
      if (login.state) await this.request(`/oauth-session?state=${encodeURIComponent(login.state)}`, 'DELETE').catch(() => undefined);
      this.finishLogin('failed', error instanceof z.ZodError ? '上游授权响应格式异常，请重试。' : error instanceof Error ? error.message : '授权启动失败，请重试。', login);
    }
    return this.snapshot();
  }
  private async listenForCallback(login: InternalLogin) {
    // Upstream's web-UI forwarder binds 0.0.0.0. Own a loopback-only listener instead.
    const port = loginProviders[login.provider].port;
    const path = loginProviders[login.provider].path;
    const handler: RequestListener = async (request, response) => {
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
      response.setHeader('Content-Type', 'text/plain; charset=utf-8');
      if (request.method !== 'GET' || ![`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`].includes(request.headers.host ?? '') ||
          request.url?.split('?')[0] !== path) {response.writeHead(400); response.end('无效授权回调。'); return;}
      try {
        await this.submitCallback(login.id, `http://localhost:${port}${request.url}`);
        response.end('授权回调已收到。请返回 Browser Agent 查看连接结果，可以关闭此页面。');
      } catch {response.writeHead(400); response.end('回调未被接受，可能已提交或会话已过期。请返回 Browser Agent 查看状态。');}
    };
    const servers: Server[] = [];
    try {
      for (const host of ['127.0.0.1', '::1']) {
        const server = createHTTPServer(handler);
        server.requestTimeout = 10000; server.headersTimeout = 5000;
        try {
          await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen({port, host, ipv6Only: host === '::1'}, resolve);
          });
        } catch (error) {
          if (host === '::1' && ['EAFNOSUPPORT', 'EADDRNOTAVAIL'].includes((error as NodeJS.ErrnoException).code ?? '')) continue;
          throw error;
        }
        servers.push(server); server.unref();
      }
    } catch {
      for (const server of servers) server.close();
      throw new Error(`授权回调端口 ${port} 无法监听。请关闭其他登录流程后重试。`);
    }
    if (this.loginSession !== login || !this.isPending()) {for (const server of servers) server.close(); return;}
    this.callbackServers = servers;
  }
  async openLogin(id: string) {
    const login = this.current(id);
    if (!login.url) throw new Error('授权链接尚未就绪');
    validateAuthorizationURL(login.url, login.provider);
    if (this.options.openExternal) {
      try {await this.options.openExternal(login.url);}
      catch {login.message = '自动打开浏览器失败。请复制下方授权链接到浏览器打开。';}
    }
    return this.snapshot();
  }
  private schedulePoll(login: InternalLogin) {
    if (this.closing || this.loginSession !== login || !this.isPending()) return;
    this.timer = setTimeout(() => {void this.pollLogin(login);}, this.options.pollIntervalMs ?? 1000);
    this.timer.unref();
  }
  private async pollLogin(login: InternalLogin) {
    if (this.loginSession !== login || !this.isPending()) return;
    if (Date.now() >= Date.parse(login.expiresAt!)) {
      try {await this.cancelLogin(login.id); this.finishLogin('expired', '授权已超时，请重新连接。');}
      catch {this.finishLogin('expired', '授权已超时，请重启 Local Agent 后重试。');}
      return;
    }
    try {
      const response = z.object({status: z.enum(['ok', 'wait', 'error']), error: z.string().optional()}).parse(
        await this.request(`/get-auth-status?state=${encodeURIComponent(login.state!)}`));
      if (this.loginSession !== login || !this.isPending()) return;
      if (response.status === 'error') {
        // Do not surface raw token-exchange errors (may contain secrets or callback parameters).
        this.finishLogin('failed', '授权未完成或凭据交换失败。请重新连接，并检查网络或回调端口。'); return;
      }
      if (response.status === 'ok') {
        login.status = 'verifying'; login.message = '授权成功，正在读取已保存账号与模型列表。';
        await this.refreshAccounts();
        if (this.loginSession !== login || !this.isPending()) return;
        if (!this.accounts.some(account => account.provider === login.provider)) throw new Error('账号尚未加载');
        this.finishLogin('completed', this.models.length ? '账号已保存，模型列表已自动刷新。请选择模型并探测能力。' : '账号已保存，但模型列表为空。请刷新列表或检查账号可用权限。');
        return;
      }
    } catch {if (this.loginSession === login && this.isPending()) login.message = '正在等待 Local Agent 确认授权结果，可稍后重试或取消。';}
    this.schedulePoll(login);
  }
  async submitCallback(id: string, value: string) {
    const login = this.current(id);
    if (!login.state || login.callbackSubmitted) throw new Error('回调已经提交或会话尚未就绪');
    const url = new URL(value);
    const expectedPort = String(loginProviders[login.provider].port);
    const expectedPath = loginProviders[login.provider].path;
    if (url.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(url.hostname) || url.port !== expectedPort ||
        url.pathname !== expectedPath || url.username || url.password || url.hash || url.searchParams.get('state') !== login.state ||
        (!url.searchParams.get('code') && !url.searchParams.get('error'))) throw new Error('请粘贴本次授权完成后的完整 localhost 回调地址，不能使用旧会话地址。');
    login.callbackSubmitted = true;
    try {
      await this.request('/oauth-callback', 'POST', {provider: loginProviders[login.provider].upstream, redirect_url: url.href});
      login.status = 'verifying'; login.message = '回调已提交，正在等待凭据交换。';
    } catch (error) {login.callbackSubmitted = false; throw error;}
    return this.snapshot();
  }
  async cancelLogin(id: string) {
    const login = this.current(id);
    if (login.state) {
      const response = z.object({cancelled: z.boolean()}).parse(await this.request(`/oauth-session?state=${encodeURIComponent(login.state)}`, 'DELETE'));
      if (!response.cancelled) {login.message = '授权已结束，正在确认最终状态。'; return this.snapshot();}
    }
    this.finishLogin('cancelled', '本次授权已取消，可重新连接。', login);
    return this.snapshot();
  }
  async shutdown() {this.closing = true; clearTimeout(this.timer); for (const server of this.callbackServers.splice(0)) server.close(); await this.stop();}
}

export type LocalAgentSnapshot = ReturnType<CLIProxyManager['snapshot']>;
