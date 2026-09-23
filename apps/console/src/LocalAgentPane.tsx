import { QuotaRing } from './QuotaRing';
import { modelLabel } from './model-label';
import { copyText } from './clipboard';
import { useEffect, useState } from 'react';
import { Icon } from './Icons';
import type { LocalAgentSnapshot } from '../../../packages/core/src/cliproxy';

type Props = {
  local: LocalAgentSnapshot;
  view: 'accounts' | 'gateway';
  selectedModel: string;
  disabled: boolean;
  onAction: (action: string) => Promise<void>;
  onLoginAction: (action: string, data: {id: string; redirectURL?: string}) => Promise<void>;
  onAccount: (id: string, enabled: boolean) => Promise<void>;
  onDeleteAccount?: (id: string) => Promise<void>;
  onUseModel: (model: string) => Promise<void>;
  onGateway: (apiKey?: string) => Promise<void>;
  onImportLocal?: (provider: string) => Promise<void>;
};
const states: Record<string, string> = {
  stopped: '已停止', starting: '正在启动', running: '运行中', failed: '失败',
  waiting_for_browser: '等待官方授权', verifying: '正在验证连接', completed: '授权完成',
  cancelled: '已取消', expired: '已过期', idle: '尚未登录',
};
const formatAmount = (value: number, unit?: string) => unit === 'USD' ? `$${value.toFixed(2)}` : `${Math.round(value).toLocaleString()}${unit ?? ''}`;
const resetLabel = (iso: string) => {
  const ms = Date.parse(iso) - Date.now();
  if (Number.isNaN(ms)) return '';
  if (ms <= 0) return '已重置';
  const minutes = Math.round(ms / 60000);
  const span = minutes < 60 ? `${minutes} 分钟` : minutes < 60 * 48 ? `${Math.round(minutes / 60)} 小时` : `${Math.round(minutes / 1440)} 天`;
  return `${span}后重置（${new Date(iso).toLocaleString()}）`;
};
type Gateway = {baseURL: string; apiKey: string; running: boolean};
function GatewayFields({disabled, port, onSave}: {disabled: boolean; port: number; onSave: (apiKey?: string) => Promise<void>}) {
  const [gateway, setGateway] = useState<Gateway>();
  const [reveal, setReveal] = useState(false);
  const [custom, setCustom] = useState('');
  const [copied, setCopied] = useState('');
  const [copyError, setCopyError] = useState('');
  useEffect(() => {void fetch('/api/local-agent/gateway').then(r => r.ok ? r.json() : Promise.reject()).then(setGateway).catch(() => undefined);}, [port]);
  const copy = async (label: string, value: string) => {try{await copyText(value);setCopied(label);setCopyError('');}catch{setCopyError('复制失败，请选中内容手动复制。');}};
  const save = async (apiKey?: string) => {await onSave(apiKey); setCustom(''); setReveal(false); setGateway(await fetch('/api/local-agent/gateway').then(r => r.json()));};
  const key = gateway?.apiKey ?? '';
  return <div className="gateway">
    {copyError&&<p role="alert" className="hint">{copyError}</p>}
    <label>Base URL<div className="inputAction"><input id="local-base-url" readOnly value={gateway?.baseURL ?? `http://127.0.0.1:${port}/v1`} onFocus={event => event.target.select()} /><button type="button" disabled={!gateway} onClick={() => void copy('url', gateway!.baseURL)}>复制</button></div></label>
    <label>API Key<div className="inputAction"><input id="local-api-key" readOnly type={reveal ? 'text' : 'password'} autoComplete="off" value={key} onFocus={event => event.target.select()} /><button type="button" disabled={!key} onClick={() => setReveal(value => !value)}>{reveal ? '隐藏' : '显示'}</button><button type="button" disabled={!key} onClick={() => void copy('key', key)}>复制 API Key</button></div></label>
    <p className="hint">{copied === 'url' ? '已复制 Base URL。' : copied === 'key' ? '已复制 API Key。' : '在支持本机接口的 OpenAI 兼容客户端填写以上地址和密钥。只监听 127.0.0.1，密钥保存在本机。'}</p>
    <details>
      <summary>使用自己的密钥或重新生成</summary>
      <form onSubmit={event => {event.preventDefault(); void save(custom.trim() || undefined);}}>
        <label htmlFor="custom-api-key">自定义 API Key<span className="muted">留空则重新生成随机密钥；正在运行时会重启网关</span></label>
        <input id="custom-api-key" type="password" autoComplete="off" value={custom} disabled={disabled} onChange={event => setCustom(event.target.value)} placeholder="至少 8 个字符，或留空重新生成" />
        <div className="buttons"><button disabled={disabled}>{custom.trim() ? '保存自定义密钥' : '重新生成密钥'}</button></div>
      </form>
    </details>
  </div>;
}
export function LocalAgentPane({local, view, selectedModel, disabled, onAction, onLoginAction, onAccount, onDeleteAccount, onUseModel, onGateway, onImportLocal}: Props) {
  const [callback, setCallback] = useState('');
  const [query, setQuery] = useState('');
  const [connectedOnly, setConnectedOnly] = useState(false);
  const [expanded, setExpanded] = useState<string[]>([]);
  const login = local.login;
  const pending = !!login && ['starting', 'waiting_for_browser', 'verifying'].includes(login.status);
  const switching = ['starting', 'stopping'].includes(local.state);
  const unavailable = disabled || switching;
  useEffect(() => {setCallback('');}, [login?.id, login?.status]);
  const providerLabel = (id: string) => local.providers.find(item => item.id === id)?.label ?? id;
  const search = query.trim().toLowerCase();
  const providers = local.providers.map(item => ({...item,
    accounts: local.accounts.filter(a => a.provider === item.id && !a.unavailable),
    models: local.models.filter(m => m.provider === item.id),
  })).filter(item => (!connectedOnly || item.accounts.some(a=>!a.disabled)) && (!search || `${item.id} ${item.label} ${item.accounts.map(a=>a.label).join(' ')}`.toLowerCase().includes(search) || item.models.some(m=>`${m.id} ${modelLabel(local.models,m.id)}`.toLowerCase().includes(search))))
    .sort((a,b) => Number(b.accounts.length > 0) - Number(a.accounts.length > 0));
  if (view === 'gateway') return <div className="settings gatewaySettings"><section>
    <div className="sectionTitle"><h2>本机模型网关</h2><span className="status"><i className={`dot ${local.state === 'running' ? 'ok' : ''}`}/>{states[local.state] ?? local.state}</span></div>
    <p className="hint">每次打开 token-flow 自动启动，加载已保存的账号与可用模型。为兼容客户端分配权限，请使用「API Keys」。下方保留内部网关的直连设置。</p>
    <details className="gatewayLogs"><summary>高级：内部网关直连（拥有全部模型权限）</summary><p className="hint">内部密钥不受客户端 Key 权限限制。需要限制模型范围时，使用「API Keys」中的地址与密钥。</p><GatewayFields disabled={unavailable || pending} port={local.port} onSave={onGateway}/></details>
    <div className="buttons"><button disabled={unavailable || local.state === 'running'} onClick={() => void onAction('start')}>启动网关</button><button disabled={unavailable || local.state !== 'running'} onClick={() => void onAction('stop')}>停止网关</button><button disabled={unavailable} onClick={() => void onAction('restart')}>重启网关</button></div>
    {local.lastError && <p className="hint" role="alert">{local.lastError}</p>}
  </section><section><h2>连接方式</h2><p className="hint">模型 ID 包含提供商前缀，例如 <code>codex/gpt-5.6-sol</code>。实际支持列表以「账号与模型」中的已加载模型为准。</p><pre>GET  /v1/models{'\n'}POST /v1/responses{'\n'}POST /v1/chat/completions</pre><p className="hint">已登录且启用的账号会共同提供模型；停用账号保留登录凭据。网关只接受本机连接。</p><details className="gatewayLogs"><summary>网关运行日志</summary><pre className="logs">{local.logs.join('\n') || '等待网关启动。'}</pre></details></section></div>;
  return <div className="providerDirectory">
    <div className="directoryToolbar"><label className="directorySearch"><Icon name="model" size={17}/><span className="srOnly">搜索提供商、账号或模型</span><input type="search" value={query} onChange={e=>setQuery(e.target.value)} placeholder="搜索提供商、账号或模型…"/></label><label className="connectedFilter"><input type="checkbox" checked={connectedOnly} onChange={e=>setConnectedOnly(e.target.checked)}/>只看已连接</label><button disabled={unavailable || local.state !== 'running' || local.quotaBusy} onClick={()=>void onAction('quota')}>{local.quotaBusy ? '额度更新中…' : '刷新账号与额度'}</button></div>
    {local.accountError && <p className="notice" role="alert">{local.accountError}</p>}
    {local.state !== 'running' && <div className="gatewayWarning" role="status"><span>{local.state === 'starting' ? '网关正在启动，账号和模型会自动加载…' : local.lastError || '网关已停止。启动后将恢复已保存的登录信息。'}</span><button disabled={unavailable} onClick={()=>void onAction('start')}>启动网关</button></div>}
    {!providers.length && <div className="empty"><Icon name="model" size={30}/><h2>{connectedOnly && !search ? '还没有连接的账号' : '没有找到匹配结果'}</h2><p>连接提供商后，这里会显示账号、额度和支持的模型。</p><button onClick={()=>{setQuery('');setConnectedOnly(false);}}>查看全部提供商</button></div>}
    <div className="providerGrid">{providers.map(item => {
      const connected = local.state === 'running' && item.accounts.some(a=>!a.disabled);
      const remaining = item.accounts.filter(a=>!a.disabled).flatMap(a=>(local.quotas[a.id]?.status==='ok'?local.quotas[a.id]?.windows??[]:[]).flatMap(w=>w.usedPercent===null?[]:[Math.max(0,100-w.usedPercent)]));
      const quotaFailed=item.accounts.some(a=>!a.disabled&&local.quotas[a.id]?.status==='error');
      const detailsOpen = expanded.includes(item.id) || !!search || (login?.provider===item.id && pending);
      const matchedModels = item.models.filter(m => !search || `${m.id} ${modelLabel(local.models,m.id)}`.toLowerCase().includes(search) || `${item.id} ${item.label}`.toLowerCase().includes(search) || item.accounts.some(a=>a.label.toLowerCase().includes(search)));
      const canImport = ['doubao', 'trae', 'workbuddy', 'zcode'].includes(item.id);
      return <section className={`providerCard ${connected ? 'connected' : ''}`} key={item.id} data-provider={item.id} aria-label={`${item.label} 提供商`}>
        <button className="providerCardHead" aria-expanded={detailsOpen} aria-controls={`provider-details-${item.id}`} onClick={()=>setExpanded(current=>current.includes(item.id)?current.filter(id=>id!==item.id):[...current,item.id])}><span className={`providerMonogram provider-${item.id}`}>{({codex:'C',claude:'✳',antigravity:'A',kimi:'K',xai:'x',qoder:'Q',workbuddy:'W',zcode:'Z',doubao:'豆',trae:'T',cursor:'C'} as Record<string,string>)[item.id]}</span><div><h2>{item.label}</h2><span className="providerNamespace">{item.accounts.length ? `${item.accounts.length} 个账号 · ${item.models.length?`${item.models.length} 个模型`:connected?'模型同步中':'0 个模型'}` : '连接以共享模型'}</span></div><span className={`providerConnection ${connected ? 'isConnected' : ''}`}><i className={`dot ${connected ? 'ok' : ''}`}/>{local.state !== 'running' && item.accounts.length ? '离线' : connected ? '已连接' : item.accounts.length ? '已停用' : '未连接'}</span><Icon name="chevron" size={14}/></button>
        <div className="providerOverview"><span>{connected ? remaining.length ? `剩余 ${Math.round(Math.min(...remaining))}%${quotaFailed?' · 部分账号更新失败':''}` : quotaFailed?'额度更新失败':'额度暂未提供' : '官方账号授权'}</span><button className="textButton" aria-expanded={detailsOpen} aria-controls={`provider-details-${item.id}`} onClick={()=>setExpanded(current=>current.includes(item.id)?current.filter(id=>id!==item.id):[...current,item.id])}>{detailsOpen?'收起':'账号与模型'} <Icon name="chevron" size={12}/></button></div>
        <div id={`provider-details-${item.id}`} hidden={!detailsOpen}>
        <p className="providerHint">{item.id==='antigravity'?'Google 账号授权 · 模型以账号返回为准。':item.hint}</p>
        <div className="providerAccounts">{item.accounts.map(account => {
        const quota = local.quotas[account.id];
        return <div className="accountRow" key={account.id}>
          <div className="account">
            <span className="accountLabel">{account.label}<small>{providerLabel(account.provider)} · {local.state !== 'running' ? '离线' : account.disabled ? '已停用' : account.unavailable ? (account.status && account.status !== 'active' && account.status !== 'unknown' ? account.status : '凭据失效') : account.status === 'active' ? '可用' : account.status}{quota?.plan ? ` · ${quota.plan}` : ''}{account.isDuplicate ? ' · 重复账号' : ''}</small></span>
            <div className="buttons">
              <button disabled={disabled || local.state !== 'running' || pending} onClick={() => void onAccount(account.id, account.disabled)}>{account.disabled ? '启用' : '停用'}</button>
              {onDeleteAccount && <button className="danger" disabled={disabled || local.state !== 'running' || pending} onClick={() => { if (window.confirm(`确定要从本机删除此账号凭据（${account.label}）吗？`)) void onDeleteAccount(account.id); }}>删除</button>}
            </div>
          </div>
          {account.unavailable && <p className="hint accountWarning" role="alert" style={{color: 'var(--danger, #d75466)', margin: '4px 0 8px'}}>⚠️ 此账号凭据已失效或缺少配置，建议点击「删除」清理此凭据，避免影响底层调度。</p>}
          {account.isDuplicate && !account.unavailable && <p className="hint duplicateNotice" role="status" style={{color: '#8490a4', margin: '4px 0 8px'}}>ℹ️ 此账号有多份授权记录；同名不代表失效，已确认失效的授权会自动移出账号池。</p>}
          {!quota && !account.disabled && <p className="hint quotaPending">{local.quotaBusy ? '正在读取账号额度…' : '尚无额度数据，请刷新查询。'}</p>}
          {quota && !account.disabled && <div className={`quota ${quota.status}`} aria-label={`${account.label} 额度`}>
            {quota.status === 'error' && <p className="hint" role="alert">额度查询失败：{quota.error}</p>}
            {quota.status==='error'&&quota.lastSuccessfulAt&&<p className="hint">以下为 {new Date(quota.lastSuccessfulAt).toLocaleString()} 的上次成功结果，仅供参考，不是当前额度。</p>}
            {quota.windows.map(window => <div className="quotaWindow quotaWindowRing" key={window.id}>
              <QuotaRing remaining={window.usedPercent===null?null:100-window.usedPercent} label={window.label}/>
              <div className="quotaWindowDetails"><div className="quotaMeta"><span>{window.label}</span></div>
              <b>{window.usedPercent===null?'额度暂未提供':`剩余 ${Math.round(Math.max(0,100-window.usedPercent))}%`}{window.note ? ` · ${window.note}` : ''}</b>
              <small>{window.used !== undefined && window.limit !== undefined ? `已用 ${formatAmount(window.used, window.unit)} / ${formatAmount(window.limit, window.unit)}` : window.used !== undefined ? `已用 ${formatAmount(window.used, window.unit)}` : ''}{window.resetsAt ? `${window.used !== undefined ? ' · ' : ''}${resetLabel(window.resetsAt)}` : ''}</small></div>
            </div>)}
            {quota.note && <p className="hint">{quota.note}</p>}
            <small className="quotaObserved">查询于 {new Date(quota.observedAt).toLocaleTimeString()}</small>
          </div>}
        </div>;

        })}</div>
      {login?.provider === item.id && login.status !== 'completed' && <section className={`loginPanel ${login.status}`} aria-label="账号授权进度">
        <div className="sectionTitle"><h2>{providerLabel(login.provider)} 授权</h2><span>{states[login.status] ?? login.status}</span></div>
        <p role="status">{login.message}</p>
        {pending && login.flow === 'device' && login.userCode && <div className="deviceCode" aria-label="设备码"><small>在官方页面核对或输入此设备码</small><b className="mono">{login.userCode}</b></div>}
        {pending && login.expiresAt && <p className="hint">本次授权截止：{new Date(login.expiresAt).toLocaleTimeString()}。关闭授权页不会自动取消，请使用下方取消按钮。</p>}
        {pending && login.url && <>
          <div className="buttons"><button disabled={disabled} onClick={() => void onLoginAction('open', {id: login.id})}>重新打开官方授权页 ↗</button><button disabled={disabled} onClick={() => void onLoginAction('cancel', {id: login.id})}>取消本次授权</button></div>
          <details><summary>授权页没有自动打开？</summary><label>官方授权链接（选中后复制）<input readOnly value={login.url} onFocus={event => event.target.select()} /></label></details>
          {login.flow === 'callback' && <details><summary>已授权，但浏览器无法打开 localhost 回调？</summary>
            <p className="hint">粘贴授权完成后地址栏中的完整 localhost 地址。仅接受本次会话；提交后立即清空，不保存到日志。</p>
            <form onSubmit={event => {event.preventDefault(); const value = callback; setCallback(''); void onLoginAction('callback', {id: login.id, redirectURL: value});}}>
              <label htmlFor="oauth-callback">完整回调地址</label>
              <input id="oauth-callback" type="url" value={callback} onChange={event => setCallback(event.target.value)} autoComplete="off" spellCheck={false} required />
              <button disabled={disabled || !callback.trim() || login.status === 'verifying'}>提交回调</button>
            </form>
          </details>}
        </>}
        {!pending && login.status !== 'completed' && <button disabled={disabled} onClick={() => void onAction(login.provider)}>重新连接 {providerLabel(login.provider)}</button>}
      </section>}
        <div className="providerModels"><div className="sectionTitle"><h3>支持的模型</h3><span>{item.models.length?`${item.models.length} 个可用`:connected?'同步中…':'0 个可用'}</span></div>
          {matchedModels.length ? <div className="modelChipList">{matchedModels.map(model=><button key={model.id} aria-label={`选择 ${modelLabel(local.models,model.id)}`} title={model.textOnly?`${model.id} · 文本 API，请在 Agent 接入页面调用`:`调用 ID：${model.id}`} className={`modelChip ${selectedModel === model.id ? 'current' : ''}`} disabled={model.textOnly || unavailable || pending || local.state !== 'running'} onClick={()=>void onUseModel(model.id)}><span>{modelLabel(local.models,model.id)}</span>{selectedModel === model.id ? <small>当前</small> : <Icon name="plus" size={13}/>}</button>)}</div> : <p className="hint modelEmpty">{!item.accounts.length ? '登录后自动加载该账号支持的模型与额度。' : !connected ? '启用账号后显示可用模型。' : !item.models.length ? '授权已读取，正在自动同步模型，无需重新登录。' : '没有匹配的模型。'}</p>}

        </div>
        </div>
        <div className="providerCardFoot">{item.id==='cursor'&&<a href="https://cursor.com/dashboard?tab=usage" target="_blank" rel="noreferrer">官方用量 ↗</a>}<div className="buttons">{canImport && onImportLocal && <button disabled={unavailable || pending} onClick={()=>void onImportLocal(item.id)}>本机导入</button>}<button className={connected ? '' : 'connectButton'} disabled={unavailable || pending} onClick={()=>void onAction(item.id)}>{pending && login?.provider === item.id ? '授权中…' : connected ? '添加账号 ↗' : `连接 ${item.label} ↗`}</button></div></div>
      </section>;
    })}</div>
    <p className="directoryNote"><Icon name="shield" size={14}/>额度由提供商返回；展开卡片查看账号和可用模型。</p>
  </div>;
}
