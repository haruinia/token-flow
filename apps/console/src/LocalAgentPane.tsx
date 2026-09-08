import { useEffect, useState } from 'react';
import type { LocalAgentSnapshot } from '../../../packages/core/src/cliproxy';

type Props = {
  local: LocalAgentSnapshot;
  disabled: boolean;
  onAction: (action: string) => Promise<void>;
  onLoginAction: (action: string, data: {id: string; redirectURL?: string}) => Promise<void>;
  onAccount: (id: string, enabled: boolean) => Promise<void>;
  onUseModel: (model: string) => Promise<void>;
};
const states: Record<string, string> = {
  stopped: '已停止', starting: '正在启动', running: '运行中', failed: '失败',
  waiting_for_browser: '等待官方授权', verifying: '正在验证连接', completed: '授权完成',
  cancelled: '已取消', expired: '已过期', idle: '尚未登录',
};
export function LocalAgentPane({local, disabled, onAction, onLoginAction, onAccount, onUseModel}: Props) {
  const [callback, setCallback] = useState('');
  const [model, setModel] = useState('');
  const login = local.login;
  const pending = !!login && ['starting', 'waiting_for_browser', 'verifying'].includes(login.status);
  useEffect(() => {setCallback('');}, [login?.id, login?.status]);
  useEffect(() => {if (!local.models.some(item => item.id === model)) setModel(local.models[0]?.id ?? '');}, [local.models, model]);
  return <div className="settings localSettings">
    <section>
      <div className="sectionTitle"><h2>CLIProxyAPI</h2><span className="status">{states[local.state] ?? local.state}</span></div>
      <p className="hint">连接自己的 Codex 或 Claude 账号，将可用模型提供给本机 Agent。登录由官方页面完成，账号凭据保存在本机专属目录。</p>
      <div className="endpoint mono">127.0.0.1:{local.port}</div>
      <div className="buttons">
        <button disabled={disabled || local.state === 'running'} onClick={() => void onAction('start')}>启动服务</button>
        <button disabled={disabled || local.state !== 'running'} onClick={() => void onAction('stop')}>停止</button>
        <button disabled={disabled} onClick={() => void onAction('restart')}>重启</button>
      </div>
      <h2>添加账号</h2>
      <p className="hint">点击连接会自动启动 Local Agent，并打开官方授权页。完成后无需手动导入凭据。</p>
      <div className="account"><span>Codex <small>使用 ChatGPT / OpenAI 账号授权</small></span><button disabled={disabled || pending} onClick={() => void onAction('codex')}>连接 Codex ↗</button></div>
      <div className="account"><span>Claude <small>使用 Claude 账号授权</small></span><button disabled={disabled || pending} onClick={() => void onAction('claude')}>连接 Claude ↗</button></div>
      <div className="account"><span>Antigravity <small>Google 账号授权 · Gemini 等可用模型以账号返回为准</small></span><button disabled={disabled || pending} onClick={() => void onAction('antigravity')}>连接 Antigravity ↗</button></div>
      {login && <section className={`loginPanel ${login.status}`} aria-label="账号授权进度">
        <div className="sectionTitle"><h2>{{codex:'Codex',claude:'Claude',antigravity:'Antigravity'}[login.provider]} 授权</h2><span>{states[login.status] ?? login.status}</span></div>
        <p role="status">{login.message}</p>
        {pending && login.expiresAt && <p className="hint">本次授权截止：{new Date(login.expiresAt).toLocaleTimeString()}。关闭授权页不会自动取消，请使用下方取消按钮。</p>}
        {pending && login.url && <>
          <div className="buttons"><button disabled={disabled} onClick={() => void onLoginAction('open', {id: login.id})}>重新打开官方授权页 ↗</button><button disabled={disabled} onClick={() => void onLoginAction('cancel', {id: login.id})}>取消本次授权</button></div>
          <details><summary>授权页没有自动打开？</summary><label>官方授权链接（选中后复制）<input readOnly value={login.url} onFocus={event => event.target.select()} /></label></details>
          <details><summary>已授权，但浏览器无法打开 localhost 回调？</summary>
            <p className="hint">粘贴授权完成后地址栏中的完整 localhost 地址。仅接受本次会话；提交后立即清空，不保存到日志。</p>
            <form onSubmit={event => {event.preventDefault(); const value = callback; setCallback(''); void onLoginAction('callback', {id: login.id, redirectURL: value});}}>
              <label htmlFor="oauth-callback">完整回调地址</label>
              <input id="oauth-callback" type="url" value={callback} onChange={event => setCallback(event.target.value)} autoComplete="off" spellCheck={false} required />
              <button disabled={disabled || !callback.trim() || login.status === 'verifying'}>提交回调</button>
            </form>
          </details>
        </>}
        {!pending && login.status !== 'completed' && <button disabled={disabled} onClick={() => void onAction(login.provider)}>重新连接 {{codex:'Codex',claude:'Claude',antigravity:'Antigravity'}[login.provider]}</button>}
      </section>}
    </section>
    <section>
      <div className="sectionTitle"><h2>已保存的账号</h2><button disabled={disabled || local.state !== 'running'} onClick={() => void onAction('refresh')}>刷新账号与模型</button></div>
      {local.accountError && <p className="hint" role="alert">{local.accountError}</p>}
      {local.state !== 'running' && <p className="hint">服务启动后会读取已有账号。停止服务不会删除已保存的授权。</p>}
      {!local.accounts.length ? <p className="hint">{local.state === 'running' ? '尚未发现已保存的账号。连接并完成授权后会自动显示。' : '启动服务或点击连接账号以继续。'}</p> : <div className="accountList">{local.accounts.map(account => <div className="account" key={account.id}>
        <span className="accountLabel">{account.label}<small>{account.provider} · {local.state !== 'running' ? '离线' : account.disabled ? '已停用' : account.unavailable ? '暂不可用' : account.status === 'active' ? '可用' : account.status}</small></span>
        <button disabled={disabled || local.state !== 'running' || pending} onClick={() => void onAccount(account.id, account.disabled)}>{account.disabled ? '启用' : '停用'}</button>
      </div>)}</div>}
      <div className="sectionTitle"><h2>可用模型</h2><span>{local.models.length} MODELS</span></div>
      {local.models.length ? <>
        <label htmlFor="local-model">选择用于浏览器任务的模型</label>
        <select id="local-model" size={Math.min(8, local.models.length + 1)} value={model} onChange={event => setModel(event.target.value)}>{local.models.map(item => <option key={item.id}>{item.id}</option>)}</select>
        <button className="primary" disabled={disabled || pending || !model || local.state !== 'running'} onClick={() => void onUseModel(model)}>使用此模型并前往能力检测 →</button>
      </> : <p className="hint">账号授权完成后自动刷新模型。模型列表表示代理提供的模型；是否真正可用，还需在下一步完成能力检测。</p>}
      <h2>生命周期日志</h2><pre className="logs">{local.logs.join('\n') || '尚未启动 Local Agent。'}</pre>
      <p className="hint">不展示原始 Token、回调参数或上游响应。停用账号会保留本地凭据，之后可以再次启用。</p>
    </section>
  </div>;
}
