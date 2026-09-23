import { CursorProvider,cursorCatalog } from './cursor.js';
// Router 层：受管 CLIProxyAPI 进程、管理接口、已保存账号与模型路由表。
// 对话层始终发送 Responses 请求到 127.0.0.1:<port>/v1；CLIProxyAPI 按模型转换为各家协议，
// 并路由到登录层保存的账号。登录流程本身见 ./login。
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, writeFile, chmod, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { safeEnvironment } from './browser/host.js';
import { LoginController, loginProviderCatalog, isLoginProvider, routeModelToProvider, type LoginOptions, type LoginProviderId } from './login/index.js';
import { quotaProviders, QuotaHTTPError, type AccountQuota, type QuotaAccount, type QuotaRequest, type QuotaResponse } from './quota/index.js';

export { validateAuthorizationURL } from './login/index.js';
export type { LoginSession } from './login/index.js';
export type { AccountQuota, QuotaWindow } from './quota/index.js';

const accountSchema = z.object({
  id: z.string().optional(), name: z.string(), provider: z.string().optional(), type: z.string().optional(),
  email: z.string().optional(), label: z.string().optional(), status: z.string().optional(),
  disabled: z.boolean().optional(), unavailable: z.boolean().optional(),
  // 额度查询所需的非敏感字段；auth_index 只留在进程内，不进快照。
  auth_index: z.union([z.string(), z.number()]).optional(), project_id: z.string().optional(), account_type: z.string().optional(),
  id_token: z.object({chatgpt_account_id: z.string().optional(), plan_type: z.string().optional()}).passthrough().optional(),
});
const modelSchema = z.object({id: z.string(), display_name: z.string().optional(), type: z.string().optional(), owned_by: z.string().optional()});
const apiCallSchema = z.object({status_code: z.number().int(), header: z.record(z.array(z.string())).default({}), body: z.string().default('')});
export type LocalAccount = {id: string; provider: string; label: string; status: string; disabled: boolean; unavailable: boolean; isDuplicate?: boolean; models?: string[]};
/** `provider` 为承接该模型的登录 Provider；未知类型（如 Gemini API Key）为空。 */
export type LocalModel = {id: string; displayName?: string; provider?: LoginProviderId | 'cursor';textOnly?:boolean};
export type CLIProxyOptions = LoginOptions & {secrets?:{get:(name:string)=>Promise<string>;set:(name:string,value:string)=>Promise<void>}};

export class CLIProxyManager {
  readonly cursor:CursorProvider;
  private cursorLoginSelected=false;
  private authIDs = new Map<string,string>();
  private child?: ChildProcess;
  private busy = false;
  private closing = false;
  private requests = new AbortController();
  private startTask?: Promise<LocalAgentSnapshot>;
  private refreshTask?: Promise<LocalAgentSnapshot>;
  private refreshTimer?: ReturnType<typeof setTimeout>;
  private emptyRefreshes = 0;
  private quotaTask?: Promise<LocalAgentSnapshot>;
  private aliases: Record<string, {name: string; alias: string; fork: boolean}[]> = {};
  private lastError?: string;
  private recent: string[] = [];
  private configPath: string;
  private state = 'stopped';
  private managementKey = randomBytes(32).toString('hex');
  private accounts: LocalAccount[] = [];
  private names = new Map<string, string>();
  private quotaTargets = new Map<string, {authIndex: string; account: QuotaAccount}>();
  private quotas: Record<string, AccountQuota> = {};
  private quotaBusy = false;
  private models: LocalModel[] = [];
  private accountError?: string;
  private readonly login_: LoginController;
  constructor(readonly root: string, readonly binary: string, private key: string,
    readonly port = 8317, private options: CLIProxyOptions = {}) {
    this.cursor=new CursorProvider(root,options.secrets??{get:async()=>'',set:async()=>{throw new Error('Credential storage unavailable');}},options.openExternal);
    this.configPath = join(root, 'cliproxy', 'config.yaml');
    this.login_ = new LoginController({
      start: () => this.start(), request: (path, method, body) => this.request(path, method, body),
      refreshAccounts: () => this.refreshAccounts(), accounts: () => this.accounts, modelCount: () => this.models.length,
      log: message => this.log(message), closing: () => this.closing, options: this.options,
    });
  }
  snapshot() {
    const cursor=this.cursor.snapshot();
    return structuredClone({state: this.state, loginState: this.login_.state, port: this.port,
      logs: this.recent, accounts: [...this.accounts,...cursor.accounts], models: [...this.models,...(this.state==='running'?cursor.models:[])], accountError: this.accountError, lastError: this.lastError,
      quotas: {...this.quotas,...cursor.quotas}, quotaBusy: this.quotaBusy, providers: [...loginProviderCatalog(),cursorCatalog], login: this.cursorLoginSelected?cursor.login:this.login_.snapshot()});
  }
  /** 内部 sidecar 地址和密钥；不含 Cursor SDK 模型，不进 snapshot / 日志。 */
  gateway() {
    return {baseURL: `http://127.0.0.1:${this.port}/v1`, apiKey: this.key, running: this.state === 'running'};
  }
  async setClientKey(value: string) {
    const key = value.trim();
    if (key.length < 8 || key.length > 256) throw new Error('API Key 长度须为 8–256 个字符。');
    if (!/^[\x21-\x7e]+$/.test(key)) throw new Error('API Key 只能包含可见 ASCII 字符，不能有空格或换行。');
    if (key === this.managementKey) throw new Error('不能使用内部管理密钥作为 API Key。');
    if (key === this.key) return this.gateway();
    if (this.login_.isPending()) throw new Error('请先完成或取消当前账号授权，再更改 API Key。');
    this.key = key;
    await this.configure();
    if (this.child) {await this.stop(); await this.start();}
    this.log('已更新本机 API Key');
    return this.gateway();
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
    const yaml = `host: "127.0.0.1"\nport: ${this.port}\nauth-dir: ${JSON.stringify(join(dir, 'auth'))}\napi-keys:\n  - ${JSON.stringify(this.key)}\nremote-management:\n  allow-remote: false\n  secret-key: ${JSON.stringify(this.managementKey)}\n  disable-control-panel: true\ndebug: false\nlogging-to-file: false\nrequest-log: false\nrequest-retry: 0\noauth-model-alias: ${JSON.stringify(this.aliases)}\n`;
    await writeFile(this.configPath, yaml, {mode: 0o600});
    await chmod(this.configPath, 0o600);
  }
  private async request(path: string, method = 'GET', body?: unknown, management = true, timeoutMs = 10000): Promise<unknown> {
    const response = await fetch(`http://127.0.0.1:${this.port}${management ? '/v0/management' : '/v1'}${path}`, {
      method, headers: {Authorization: `Bearer ${management ? this.managementKey : this.key}`, ...(body === undefined ? {} : {'Content-Type': 'application/json'})},
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), this.requests.signal]), redirect: 'error',
    }).catch(() => {throw new Error('无法连接 Local Agent，请检查服务状态后重试。');});
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Local Agent 接口请求失败（HTTP ${response.status}）。请重试；登录启动失败也可能是 1455 / 54545 / 51121 回调端口被占用。`);
    }
    return response.json().catch(() => {throw new Error('Local Agent 返回了无效响应，请重启服务后重试。');});
  }
  start(): Promise<LocalAgentSnapshot> {
    if (this.startTask) return this.startTask;
    this.startTask = this.startProcess().finally(() => {this.startTask = undefined;});
    return this.startTask;
  }
  private async startProcess() {
    if (this.closing) throw new Error('Local Agent 正在退出');
    if (this.busy) throw new Error('Local Agent 正在启动或停止');
    if (this.child) return this.snapshot();
    void this.cursor.load().catch(()=>this.log('Cursor 授权读取失败，其他来源继续可用。'));
    this.busy = true;
    this.emptyRefreshes = 0;
    this.state = 'starting'; this.lastError = undefined; this.requests = new AbortController();
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
        this.login_.fail('Local Agent 已退出，请重新启动并连接账号。');
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
          await this.refreshAccounts().catch(() => undefined);
          return this.snapshot();
        }
        await new Promise(r => setTimeout(r, 100));
      }
      throw new Error('CLIProxyAPI 健康检查超时');
    } catch (error) {
      await this.terminate(this.child); this.child = undefined; this.state = 'failed';
      this.lastError = error instanceof Error ? error.message : '网关启动失败'; this.log(this.lastError); throw error;
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
    clearTimeout(this.refreshTimer);
    if (this.startTask) await this.startTask.catch(() => undefined);
    if (this.busy) throw new Error('Local Agent 正在切换状态');
    this.busy = true;
    try {
      if (this.login_.isPending()) {
        try {await this.login_.cancel(this.login_.snapshot()!.id);}
        catch {this.log('无法确认授权取消；停止进程以终止本次授权。');}
      }
      clearTimeout(this.refreshTimer);
      this.requests.abort();
      await this.terminate(this.child); this.child = undefined; this.state = 'stopped';
      await this.refreshTask?.catch(() => undefined); await this.quotaTask?.catch(() => undefined);
      this.models = []; this.log('Local Agent 已停止'); return this.snapshot();
    } finally {this.busy = false;}
  }
  /** 从每个账号的模型目录建立独立命名空间，实际注册到网关，而非只改显示文本。 */
  refreshAccounts(): Promise<LocalAgentSnapshot> {
    if (this.refreshTask) return this.refreshTask;
    clearTimeout(this.refreshTimer);
    this.refreshTask = this.loadAccounts().finally(() => {
      this.refreshTask = undefined;
      if(this.state==='running'&&!this.closing&&!this.requests.signal.aborted){
        const pending=!!this.accountError||this.accounts.some(a=>!a.disabled&&!a.unavailable&&!a.models?.length);
        this.emptyRefreshes=pending?this.emptyRefreshes+1:0;
        this.refreshTimer=setTimeout(()=>{void this.refreshAccounts().catch(()=>undefined);},pending&&this.emptyRefreshes<=10?1000:30000);
        this.refreshTimer.unref();
      }
    });
    return this.refreshTask;
  }
  private async loadAccounts() {
    if (this.state !== 'running') throw new Error('请先启动 Local Agent');
    try {
      const result = z.object({files: z.array(accountSchema)}).parse(await this.request('/auth-files'));
      const names = new Map<string, string>();
      const authIDs = new Map<string,string>();
      const quotaTargets = new Map<string, {authIndex: string; account: QuotaAccount}>();
      const accounts: LocalAccount[] = result.files.map(file => {
        const id = createHash('sha256').update(file.name).digest('hex').slice(0, 24);
        names.set(id, file.name);
        if(file.id)authIDs.set(id,file.id);
        const provider = file.provider ?? file.type ?? 'unknown';
        if (file.auth_index !== undefined) quotaTargets.set(id, {authIndex: String(file.auth_index), account: {provider, email: file.email,
          projectId: file.project_id, accountType: file.account_type, chatgptAccountId: file.id_token?.chatgpt_account_id, planType: file.id_token?.plan_type}});
        return {
          id, provider, label: (file.email || file.label || '已保存的账号').slice(0, 200),
          status: file.status ?? 'unknown',
          disabled: file.disabled ?? false,
          unavailable: file.unavailable ?? false,
        };
      });
      // 识别同提供商与同标签的重复账号
      const labelCounts = new Map<string, number>();
      for (const a of accounts) {
        if(!a.label.includes('@'))continue; // Generic labels such as Kimi do not identify an account.
        const key = `${a.provider}:${a.label}`;
        labelCounts.set(key, (labelCounts.get(key) ?? 0) + 1);
      }
      for (const a of accounts) {
        if(!a.label.includes('@'))continue;
        if ((labelCounts.get(`${a.provider}:${a.label}`) ?? 0) > 1) {
          a.isDuplicate = true;
        }
      }
      const aliases: typeof this.aliases = {};
      const catalog = new Map<string, LocalModel>();

      // 1. 从每个已启用账号的凭据文件目录建立模型发现
      await Promise.all(accounts.filter(a => !a.disabled && isLoginProvider(a.provider)).map(async account => {
        const provider = account.provider as LoginProviderId;
        try {
          const res = z.object({models: z.array(modelSchema)}).parse(await this.request(`/auth-files/models?name=${encodeURIComponent(names.get(account.id)!)}`));
          account.models = [...new Set(res.models.map(m=>m.id.startsWith(`${provider}/`)?m.id:`${provider}/${m.id}`))];
          for (const model of res.models) {
            if (!model.id) continue;
            const baseId = model.id.startsWith(`${provider}/`) ? model.id.slice(provider.length + 1) : model.id;
            const id = `${provider}/${baseId}`;
            if (catalog.has(id)) continue;
            catalog.set(id, {id, provider, ...(model.display_name?.trim()?{displayName:model.display_name.trim()}: {})});
            (aliases[provider] ??= []).push({name: baseId, alias: id, fork: true});
          }
        } catch { /* 凭据文件可能暂未注册模型 */ }
      }));

      // 2. 结合网关实时已注册的 /v1/models，为已启用提供商补充可用模型
      try {
        const live = z.object({data: z.array(modelSchema)}).parse(await this.request('/models', 'GET', undefined, false));
        for (const model of live.data) {
          if (!model.id) continue;
          let provider: LoginProviderId | undefined;
          let baseId = model.id;
          if (model.id.includes('/')) {
            const parts = model.id.split('/');
            if (isLoginProvider(parts[0])) {
              provider = parts[0] as LoginProviderId;
              baseId = parts.slice(1).join('/');
            }
          }
          if (!provider) {
            provider = routeModelToProvider(model.type, model.owned_by);
          }
          if (provider && isLoginProvider(provider) && accounts.some(a => !a.disabled && a.provider === provider)) {
            const id = `${provider}/${baseId}`;
            if (!catalog.has(id)) {
              catalog.set(id, {id, provider, ...(model.display_name?.trim()?{displayName:model.display_name.trim()}: {})});
              (aliases[provider] ??= []).push({name: baseId, alias: id, fork: true});
            }
          }
        }
      } catch { /* 网关可能处于启动初始期 */ }

      this.accounts = accounts; this.names = names; this.authIDs = authIDs; this.quotaTargets = quotaTargets;
      this.quotas = Object.fromEntries(Object.entries(this.quotas).filter(([id]) => names.has(id)));

      const normalized = Object.fromEntries(Object.entries(aliases).sort(([a], [b]) => a.localeCompare(b)).map(([id, entries]) => [id, entries.sort((a,b) => a.name.localeCompare(b.name))]));
      if (JSON.stringify(normalized) !== JSON.stringify(this.aliases)) {
        await this.request('/oauth-model-alias', 'PUT', normalized);
        this.aliases = normalized;
      }

      // Only publish routes confirmed under their callable namespaced ID.
      let available = new Set<string>();
      for (let attempt = 0; attempt < 10; attempt++) {
        try {
          const models = z.object({data: z.array(modelSchema)}).parse(await this.request('/models', 'GET', undefined, false));
          available = new Set(models.data.map(m => m.id));
          const allConfirmed = [...catalog.values()].every(m => available.has(m.id));
          if (allConfirmed) break;
        } catch { /* 重试以避免瞬态网络延迟 */ }
        await new Promise(r => setTimeout(r, 100));
      }
      this.models = [...catalog.values()].filter(m => available.has(m.id)).sort((a,b) => a.id.localeCompare(b.id));
      this.accountError = this.models.length < catalog.size ? '模型路由正在同步，网关会自动重试。' : accounts.some(a=>!a.disabled&&!a.unavailable&&!a.models?.length) ? '授权已读取，正在同步可用模型…' : undefined;
      // Load quotas after startup / new login without delaying account discovery or the workspace.
      void (this.quotaTask ?? Promise.resolve()).then(() => {
        if (this.state === 'running' && this.accounts.some(a => !a.disabled && (!this.quotas[a.id] || Date.now() - Date.parse(this.quotas[a.id].observedAt) > 300000))) return this.refreshQuota();
      }).catch(() => undefined);
    } catch {
      this.models = [];
      this.accountError = '账号或模型目录暂未同步完成，网关会自动重试。';
      throw new Error(this.accountError);
    }
    return this.snapshot();
  }
  async setAccountEnabled(id: string, enabled: boolean) {
    if(this.cursor.owns(id)){await this.cursor.setEnabled(enabled);return this.snapshot();}
    const name = this.names.get(id);
    if (!name) throw new Error('账号已变更，请刷新账号列表');
    await this.request('/auth-files/status', 'PATCH', {name, disabled: !enabled});
    return this.refreshAccounts();
  }
  sourceAuth(id:string,model:string) {
    if(this.cursor.owns(id)){if(this.state!=='running')throw Object.assign(new Error('网关未启动'),{statusCode:409});return this.cursor.assertSource(id,model);}
    const account=this.accounts.find(a=>a.id===id);
    const authID=this.authIDs.get(id);
    if(this.state!=='running'||!account||account.disabled||account.unavailable||!account.models?.includes(model)||!this.models.some(m=>m.id===model)||!authID)
      throw Object.assign(new Error('源账号或模型当前不可用，请刷新授权；不会切换到其他账号。'),{statusCode:409});
    return authID;
  }
  async importCredential(provider:'codex'|'claude',credential:Record<string,unknown>,onlyNew=false) {
    await this.start();
    const identity=String(credential.account_id||credential.email||credential.access_token);
    const name=`local-${provider}-${createHash('sha256').update(identity).digest('hex').slice(0,16)}.json`;
    if(onlyNew){
      if([...this.names.values()].includes(name))return this.snapshot();
    }
    await this.request(`/auth-files?name=${encodeURIComponent(name)}`,'POST',{...credential,type:provider});
    return this.refreshAccounts();
  }
  async deleteAccount(id: string) {
    if(this.cursor.owns(id)){await this.cursor.remove();return this.snapshot();}
    const name = this.names.get(id);
    if (!name) throw new Error('账号已变更，请刷新账号列表');
    await this.request(`/auth-files?name=${encodeURIComponent(name)}`, 'DELETE');
    delete this.quotas[id];
    this.log(`已删除账号凭据：${name}`);
    return this.refreshAccounts();
  }
  /**
   * 额度层入口：对每个已启用账号，用 CLIProxyAPI `/api-call` 携带该账号凭据查询官方用量接口。
   * token 由上游替换 `$TOKEN$`，桌面端只拿到用量响应；失败信息只保留桌面端自己的描述。
   */
  refreshQuota(): Promise<LocalAgentSnapshot> {
    if (this.quotaTask) return this.quotaTask;
    this.quotaTask = this.loadQuota().finally(() => {this.quotaTask = undefined;});
    return this.quotaTask;
  }
  private async loadQuota() {
    if (this.state !== 'running') throw new Error('请先启动 Local Agent');
    if (this.quotaBusy) throw new Error('额度查询正在进行');
    this.quotaBusy = true;
    try {
      const targets = this.accounts.filter(account => !account.disabled && isLoginProvider(account.provider) && !!quotaProviders[account.provider as LoginProviderId] && this.quotaTargets.has(account.id));
      await Promise.all(targets.map(async account => {
        const provider = account.provider as LoginProviderId;
        const quotaProvider = quotaProviders[provider];
        if (!quotaProvider) return;
        const {authIndex, account: info} = this.quotaTargets.get(account.id)!;
        const call = async (request: QuotaRequest): Promise<QuotaResponse> => apiCallSchema.transform(r => ({statusCode: r.status_code, header: r.header, body: r.body}))
          .parse(await this.request('/api-call', 'POST', {auth_index: authIndex, method: request.method, url: request.url, header: request.header, data: request.data ?? ''}, true, 45000));
        const observedAt = new Date().toISOString();
        try {
          const report = await quotaProvider.fetch(call, info);
          if (!this.names.has(account.id)) return;
          this.quotas[account.id] = {accountId: account.id, provider, status: 'ok', observedAt, plan: report.plan, windows: report.windows, note: report.note};
        } catch (error) {
          const is401 = error instanceof QuotaHTTPError && error.status === 401;
          const is403 = error instanceof QuotaHTTPError && error.status === 403;
          const isMissingProject = error instanceof Error && error.message.includes('project_id');
          // A quota endpoint rejection does not prove the model credential is revoked.
          // Keep the independent source pool intact; upstream inference owns auth refresh/status.
          const message = is401 ? '额度接口暂未通过认证（HTTP 401），已保留授权；可稍后重查或重新登录。'
            : isMissingProject ? '账号缺少关联项目（project_id），无法调用 Google 模型。请重新连接。'
            : is403 ? '访问受限（HTTP 403），当前凭据权限不足或账号受限。'
            : error instanceof z.ZodError ? '上游 api-call 响应格式异常。'
            : error instanceof Error ? error.message : '额度查询失败。';
          if (!this.names.has(account.id)) return;
          this.quotas[account.id] = {accountId: account.id, provider, status: 'error', observedAt, windows: [], error: message.slice(0, 300)};
        }
      }));
      await this.cursor.refresh();
      this.log(`额度已刷新（${targets.length} 个账号）`);
    } finally {this.quotaBusy = false;}
    return this.snapshot();
  }
  // 登录层入口：所有 Provider 共用同一个会话控制器。
  async login(provider: LoginProviderId | 'cursor') {this.cursorLoginSelected=provider==='cursor';if(provider==='cursor'){if(this.login_.isPending())throw new Error('请先完成当前授权');await this.cursor.beginLogin();}else{if(['starting','waiting_for_browser'].includes(this.cursor.snapshot().login?.status??''))throw new Error('请先完成 Cursor 授权');await this.login_.login(provider);}return this.snapshot();}
  async importLocal(provider: 'doubao' | 'trae' | 'workbuddy' | 'zcode', onlyNew=false) {
    if (this.state !== 'running') await this.start();
    // Startup must never replace a pool credential refreshed independently of the native app.
    if(onlyNew&&this.accounts.some(account=>account.provider===provider))return this.snapshot();
    await this.request(`/${provider}-import-local`, 'POST', {});
    this.log(`已完成 ${provider} 本机凭据导入`);
    await this.refreshAccounts();
    return this.snapshot();
  }
  async openLogin(id: string) {if(this.cursor.snapshot().login?.id===id){await this.cursor.openLogin(id);return this.snapshot();}await this.login_.open(id); return this.snapshot();}
  async submitCallback(id: string, value: string) {await this.login_.submitCallback(id, value); return this.snapshot();}
  async cancelLogin(id: string) {if(this.cursor.snapshot().login?.id===id){this.cursor.cancelLogin(id);return this.snapshot();}await this.login_.cancel(id); return this.snapshot();}
  async shutdown() {this.closing = true;await this.cursor.close(); this.login_.close(); await this.stop(); await this.refreshTask?.catch(() => undefined); await this.quotaTask?.catch(() => undefined);}
}

export type LocalAgentSnapshot = ReturnType<CLIProxyManager['snapshot']>;
