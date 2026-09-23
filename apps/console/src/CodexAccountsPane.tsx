import { useEffect,useState } from 'react';
import type { LocalAgentSnapshot } from '../../../packages/core/src/cliproxy';
import type { CodexAccountStatus } from '../../../packages/core/src/codex-accounts';
import { sourceOptions } from './source-options';
import { modelLabel } from './model-label';
import { QuotaRing } from './QuotaRing';

type Status=CodexAccountStatus&{gatewayConnected:boolean;accounts:{id:string;accountId:string|null;switchable:boolean;reason:string}[]};
async function request(path='',body?:unknown):Promise<Status>{
 const response=await fetch(`/api/codex-accounts${path}`,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:undefined);
 const data=await response.json();if(!response.ok)throw new Error(data.error??data.message??'操作失败');return data;
}
export function CodexAccountsPane({local,onAccounts,onGateway}:{local:LocalAgentSnapshot;onAccounts:()=>void;onGateway:()=>void}){
 const [status,setStatus]=useState<Status>();const [selected,setSelected]=useState('');const [model,setModel]=useState('');
 const [busy,setBusy]=useState(false);const [error,setError]=useState('');const [message,setMessage]=useState('');
 const accounts=sourceOptions(local).filter(a=>a.provider==='codex').map(a=>({...a,models:a.models.filter(m=>!/(?:gpt-image-|codex-auto-review)/.test(m))}));const account=accounts.find(a=>a.id===selected);
 const refresh=async()=>{try{setStatus(await request());setError('');}catch(e){setError(e instanceof Error?e.message:'读取失败');}};
 const accountVersion=accounts.map(a=>a.id).join(',');
 useEffect(()=>{void refresh();},[accountVersion]);
 const act=async(restore=false)=>{
  if(!status)return;
  if(status.pids.length&&!window.confirm(`检测到 Codex 仍在运行。确认${restore?'还原':'切换'}设置？完成后请重启 Codex，正在运行的会话不会立即更新。`))return;
  setBusy(true);setError('');setMessage('');
  try{setStatus(await request(restore?'/restore':'/switch',{revision:status.revision,allowRunning:status.pids.length>0,...(restore?{}:{sourceId:selected,model})}));setMessage(`${restore?'原登录与配置已还原':'账号与默认模型已切换'}。请重启 Codex 生效。`);setSelected('');}
  catch(e){setError(e instanceof Error?e.message:'操作失败');try{setStatus(await request());}catch{/* Keep the original error. */}}
  finally{setBusy(false);}
 };
 return <section className="accountSwitch">
  <div className="sectionHeading"><div><span className="eyebrow">CODEX · 本机登录</span><h2>多个账号，随时切换。</h2><p className="muted">选择账号与默认模型。授权继续保存在本地池，切换前自动备份原登录。</p></div><button onClick={onAccounts}>添加账号 ↗</button></div>
  <div className="nativeAccountStatus"><div><span className="muted">本机当前登录</span><strong>{status?(status.storage==='file'?(status.email??(status.accountId?'已读取账号':'尚未登录')):'由系统凭据存储管理'):'正在读取…'}</strong><span className="muted">{status?.model??'默认模型'} · {status?.storage==='file'?'文件认证':'切换后使用文件认证，保留原存储以便还原'}</span></div><div className="actions"><button disabled={busy} onClick={()=>void refresh()}>刷新</button>{status?.backup&&<button disabled={busy||status.gatewayConnected} onClick={()=>void act(true)}>还原原登录</button>}</div></div>
  {status?.gatewayConnected&&<p className="hint">Codex 当前使用 A2A 网关。<button onClick={onGateway}>先还原接口</button>，再切换本机登录。</p>}
  {status?.backup?.state==='prepared'&&<p role="alert">上次切换未完成，请先还原原登录。</p>}
  {error&&<p className="error" role="alert">{error}</p>}{message&&<p className="hint" role="status">{message}</p>}
  <div className="nativeAccountGrid">{accounts.map(a=><article className={`nativeAccountCard ${selected===a.id?'chosen':''}`} key={a.id}>
   <div className="nativeAccountIdentity"><QuotaRing remaining={a.remaining} label={a.label}/><div><h3>{a.label}{status?.accountId&&status.accounts.find(item=>item.id===a.id)?.accountId===status.accountId&&<small className="nativeCurrent">本机当前</small>}</h3><span className="muted">{a.remaining===null?'额度暂未提供':`剩余 ${Math.round(a.remaining)}%`} · {a.models.length} 个模型</span></div></div>
   {!status?.accounts.find(item=>item.id===a.id)?.switchable&&<p className="hint">{status?.accounts.find(item=>item.id===a.id)?.reason??'正在读取登录凭据…'}</p>}
   <button disabled={busy||!status?.accounts.find(item=>item.id===a.id)?.switchable||status.gatewayConnected||!a.models.length||status.backup?.state==='prepared'} onClick={()=>{setSelected(a.id);setModel(a.models.includes(`codex/${status?.model}`)?`codex/${status?.model}`:a.models[0]);setMessage('');}}>切换到此账号</button>
   {account?.id===a.id&&<form onSubmit={e=>{e.preventDefault();void act();}}><label htmlFor="native-model">默认模型</label><select id="native-model" value={model} onChange={e=>setModel(e.target.value)}>{a.models.map(m=><option key={m} value={m}>{modelLabel(local.models,m)}</option>)}</select><div className="actions"><button type="button" disabled={busy} onClick={()=>setSelected('')}>取消</button><button className="primary" disabled={busy||!a.models.includes(model)}>{busy?'正在切换…':'确认切换'}</button></div></form>}
  </article>)}</div>
  {!accounts.length&&<div className="empty"><p>{local.state==='running'?'还没有可切换的 Codex 授权。':'正在等待网关加载已保存的授权…'}</p><button onClick={onAccounts}>前往模型中心</button></div>}
 </section>;
}
