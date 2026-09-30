import { useEffect, useState } from 'react';
import type { LocalAgentSnapshot } from '../../../packages/core/src/cliproxy';
import type { NativeAccountStatus, NativeProvider } from '../../../packages/core/src/native-accounts';
import { CodexAccountsPane } from './CodexAccountsPane';
import { sourceOptions } from './source-options';
import { modelLabel } from './model-label';
import { QuotaRing } from './QuotaRing';
const names={codex:'Codex',antigravity:'反重力 · Antigravity',claude:'Claude Code'};
type Props={local:LocalAgentSnapshot;onAccounts:()=>void;onGateway:()=>void};
type Status=NativeAccountStatus&{gatewayConnected:boolean;accounts:{id:string;email:string|null;switchable:boolean;reason:string}[]};
export function AccountsPane(props:Props){
 const [provider,setProvider]=useState<keyof typeof names>('codex');
 return <><div className="modelCenterTabs" role="tablist" aria-label="多账号客户端">{(Object.keys(names) as (keyof typeof names)[]).map(id=><button key={id} role="tab" aria-selected={provider===id} aria-controls="native-account-panel" onClick={()=>setProvider(id)}>{names[id]}</button>)}</div><div id="native-account-panel" role="tabpanel" aria-label={names[provider]}>{provider==='codex'?<CodexAccountsPane {...props}/>:<NativeAccountsPane key={provider} {...props} provider={provider}/>}</div></>;
}
function NativeAccountsPane({local,onAccounts,onGateway,provider}:Props&{provider:NativeProvider}){
 const [status,setStatus]=useState<Status>();const [selected,setSelected]=useState('');const [model,setModel]=useState('');
 const [busy,setBusy]=useState(false);const [error,setError]=useState('');const [message,setMessage]=useState('');
 const accounts=sourceOptions(local).filter(a=>a.provider===provider),name=names[provider];
 const request=async(path='',body?:unknown):Promise<Status>=>{const response=await fetch(`/api/native-accounts/${provider}${path}`,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:undefined);const data=await response.json();if(!response.ok)throw new Error(data.error??data.message??'操作失败');return data;};
 const refresh=async()=>{try{setStatus(await request());setError('');}catch(e){setStatus(undefined);setError(e instanceof Error?e.message:'读取失败');}};
 const accountVersion=accounts.map(a=>a.id).join(',');
 useEffect(()=>{let active=true;void request().then(s=>{if(active){setStatus(s);setError('');}}).catch(e=>{if(active){setStatus(undefined);setError(e instanceof Error?e.message:'读取失败');}});return()=>{active=false;};},[accountVersion]);
 const act=async(restore=false)=>{
  if(!status||busy)return;setBusy(true);setError('');setMessage('');
  try{setStatus(await request(restore?'/restore':'/switch',{revision:status.revision,...(restore?{}:{sourceId:selected,...(provider==='claude'?{model}:{})})}));setSelected('');setMessage(`${restore?'原登录已还原':'账号已切换'}。重新打开 ${name} 生效。`);}
  catch(e){setError(e instanceof Error?e.message:'操作失败');try{setStatus(await request());}catch{setStatus(undefined);}}
  finally{setBusy(false);}
 };
 const blocked=busy||!status||status.gatewayConnected||status.pids.length>0;
 return <section className="accountSwitch">
  <div className="sectionHeading"><div><span className="eyebrow">{name} · 本机登录</span><h2>多个账号，随时切换。</h2><p className="muted">切换前自动备份原登录。请先完全退出 {name}，切换后重新打开。</p></div><button onClick={onAccounts}>添加账号 ↗</button></div>
  <div className="nativeAccountStatus"><div><span className="muted">本机当前登录</span><strong>{status?(status.email??'尚未读取到登录账号'):error?'暂不可读取':'正在读取…'}</strong><span className="muted">{status?.storage??'本地登录'}{provider==='claude'?` · ${status?.model??'默认模型'}`:' · 模型在反重力客户端中选择'}</span></div><div className="actions"><button disabled={busy} onClick={()=>void refresh()}>刷新</button>{status?.backup&&<button disabled={blocked} onClick={()=>void act(true)}>还原原登录</button>}</div></div>
  {status?.gatewayConnected&&<p className="hint">Claude Code 当前使用 A2A 网关。<button onClick={onGateway}>先还原接口</button>，再切换本机登录。</p>}
  {!!status?.pids.length&&<p className="hint">检测到 {name} 仍在运行，请退出客户端后点击刷新。</p>}
  {status?.backup?.state==='prepared'&&<p role="alert">上次切换未完成，请先还原原登录。</p>}
  {provider==='claude'&&<p className="hint">终端环境变量和项目设置可能覆盖本机登录；重新打开后可用 /status 确认当前账号。</p>}
  {error&&<p className="error" role="alert">{error}</p>}{message&&<p className="hint" role="status">{message}</p>}
  <div className="nativeAccountGrid">{accounts.map(a=>{const credential=status?.accounts.find(item=>item.id===a.id);return <article className={`nativeAccountCard ${selected===a.id?'chosen':''}`} key={a.id}>
   <div className="nativeAccountIdentity"><QuotaRing remaining={a.remaining} label={a.label}/><div><h3>{a.label}{status?.email&&credential?.email===status.email&&<small className="nativeCurrent">本机当前</small>}</h3><span className="muted">{a.remaining===null?'额度暂未提供':`剩余 ${Math.round(a.remaining)}%`} · {a.models.length} 个模型</span></div></div>
   {!credential?.switchable&&<p className="hint">{credential?.reason??'正在读取登录凭据…'}</p>}
   <button disabled={blocked||!credential?.switchable||status?.backup?.state==='prepared'} onClick={()=>{setSelected(a.id);setModel(a.models.includes(`claude/${status?.model}`)?`claude/${status?.model}`:a.models[0]);setMessage('');}}>切换到此账号</button>
   {selected===a.id&&<form onSubmit={e=>{e.preventDefault();void act();}}>{provider==='claude'?<><label htmlFor="native-model">默认模型</label><select id="native-model" value={model} disabled={busy} onChange={e=>setModel(e.target.value)}>{a.models.map(m=><option key={m} value={m}>{modelLabel(local.models,m)}</option>)}</select></>:<p>将反重力的本机登录切换到 {a.label}。</p>}<div className="actions"><button type="button" disabled={busy} onClick={()=>setSelected('')}>取消</button><button className="primary" disabled={blocked||provider==='claude'&&!a.models.includes(model)}>{busy?'正在切换…':'确认切换'}</button></div></form>}
  </article>;})}</div>
  {!accounts.length&&<div className="empty"><p>{local.state==='running'?`还没有可切换的 ${name} 授权。`:'正在等待网关加载已保存的授权…'}</p><button onClick={onAccounts}>前往模型中心</button></div>}
 </section>;
}
