import { modelLabel } from './model-label';
import { copyText } from './clipboard';
import { useEffect, useRef, useState } from 'react';
import type { LocalAgentSnapshot } from '../../../packages/core/src/cliproxy';
import type { GatewayKey } from '../../../packages/core/src/gateway-keys';
import { agentCatalog } from './agent-config';
import { Icon } from './Icons';

async function request<T>(path:string,method='GET',body?:unknown):Promise<T> {
  const response=await fetch(path,{method,headers:body===undefined?undefined:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  const data=await response.json();if(!response.ok)throw new Error(data.error?.message??data.error??data.message??'请求失败');return data;
}
function Check({checked,partial,label,disabled,onChange}:{checked:boolean;partial?:boolean;label:string;disabled?:boolean;onChange:()=>void}) {
  const input=useRef<HTMLInputElement>(null);
  useEffect(()=>{if(input.current)input.current.indeterminate=!!partial;},[partial]);
  return <label className="scopeCheck"><input ref={input} type="checkbox" checked={checked} disabled={disabled} onChange={onChange}/><span>{label}</span></label>;
}
export function GatewayKeysPane({local}:{local:LocalAgentSnapshot}) {
  const [keys,setKeys]=useState<GatewayKey[]>([]);
  const [editing,setEditing]=useState<GatewayKey|null|undefined>();
  const [name,setName]=useState('');const [selected,setSelected]=useState<string[]>([]);
  const [busy,setBusy]=useState(false);const [error,setError]=useState('');const [created,setCreated]=useState('');const [copied,setCopied]=useState('');
  const [agents,setAgents]=useState<GatewayKey['agents']>(['codex','claude','openai']);
  const [limit,setLimit]=useState('');
  const [query,setQuery]=useState('');
  const baseURL=`${window.location.origin}/v1`;
  const refresh=async()=>setKeys((await request<{keys:GatewayKey[]}>('/api/gateway-keys')).keys);
  useEffect(()=>{let live=true;const load=()=>request<{keys:GatewayKey[]}>('/api/gateway-keys').then(data=>{if(live)setKeys(data.keys);}).catch(e=>{if(live)setError(e.message);});void load();const timer=setInterval(()=>void load(),3000);return()=>{live=false;clearInterval(timer);};},[]);
  const act=async(fn:()=>Promise<void>)=>{setBusy(true);setError('');try{await fn();await refresh();}catch(e){setError(e instanceof Error?e.message:'请求失败');}finally{setBusy(false);}};
  const copy=async(value:string,label:string)=>{try{await copyText(value);setCopied(label);setError('');}catch{setError('复制失败，请选中内容手动复制。');}};
  const open=(key:GatewayKey|null)=>{setEditing(key);setName(key?.name??'');setSelected(key?.models??[]);setAgents(key?.agents??['codex','claude','openai']);setLimit(key?.tokenLimit==null?'':String(key.tokenLimit));setQuery('');setError('');};
  const currentModels=local.models.map(m=>m.id);
  const allIds=[...new Set([...currentModels,...(editing?.models??[])])];
  const toggle=(ids:string[])=>setSelected(current=>ids.every(id=>current.includes(id))?current.filter(id=>!ids.includes(id)):[...new Set([...current,...ids])]);
  const groups=local.providers.map(provider=>({...provider,models:allIds.filter(id=>id.startsWith(`${provider.id}/`))})).filter(provider=>provider.models.length);
  const visible=groups.filter(group=>`${group.id} ${group.label}`.toLowerCase().includes(query.toLowerCase())||group.models.some(id=>`${id} ${modelLabel(local.models,id)}`.toLowerCase().includes(query.toLowerCase())));
  const save=()=>act(async()=>{
    const input={name,enabled:editing?.enabled??true,models:selected,agents,tokenLimit:limit.trim()===''?null:Number(limit)};
    if(editing) await request(`/api/gateway-keys/${editing.id}`,'PUT',input);
    else {const result=await request<{apiKey:string}>('/api/gateway-keys','POST',input);setCreated(result.apiKey);setCopied('');}
    setEditing(undefined);
  });
  return <div className="keyCenter">
    <div className="keyIntro"><div><h2>为每个应用分配一把 Key</h2><p>按提供商、模型两级选择调用范围。权限保存后立即生效。</p></div><button className="primary" disabled={busy||editing!==undefined} onClick={()=>open(null)}><Icon name="plus" size={15}/>创建 Key</button></div>
    <div className="scopedEndpoint"><span>客户端 Base URL</span><code>{baseURL}</code><button onClick={()=>void copy(baseURL,'地址')}>{copied==='地址'?'已复制':'复制地址'}</button></div>
    {error&&<p className="error" role="alert">{error}</p>}
    {created&&<div className="createdKey" role="status"><div><strong>Key 已创建，请现在保存</strong><p>完整 Key 只显示这一次。关闭后可以删除并重新创建。</p></div><div className="inputAction"><input aria-label="新建 API Key" readOnly value={created} onFocus={e=>e.target.select()}/><button onClick={()=>void copy(created,'Key')}>{copied==='Key'?'已复制':'复制 Key'}</button></div><button className="textButton" onClick={()=>setCreated('')}>我已保存，关闭</button></div>}
    {editing!==undefined&&<form className="keyEditor" onSubmit={e=>{e.preventDefault();void save();}}>
      <div className="sectionTitle"><h2>{editing?'编辑 Key 权限':'创建客户端 Key'}</h2><button type="button" disabled={busy} className="iconButton" aria-label="关闭 Key 编辑" onClick={()=>setEditing(undefined)}><Icon name="close" size={16}/></button></div>
      <label>Key 名称<input required maxLength={80} disabled={busy} placeholder="例如：Qoder · 日常开发" value={name} onChange={e=>setName(e.target.value)}/></label>
      <fieldset className="keyAgentScopes"><legend>支持的 Agent</legend><div>{agentCatalog.filter(agent=>agent.id!=='qoder'&&agent.id!=='cursor').map(agent=><Check key={agent.id} label={agent.name} checked={agents.includes(agent.id)} disabled={busy} onChange={()=>setAgents(current=>current.includes(agent.id)?current.filter(id=>id!==agent.id):[...current,agent.id])}/>)}</div><p className="hint">按接入协议限制：Codex → Responses，Claude Code → Messages，兼容 Agent（含 Cursor）→ Chat / Responses。无法据此验证应用进程身份；不勾选则禁止生成调用。</p></fieldset>
      <div className="keyBudgetEditor"><label>Token 总额度<input aria-label="Token 总额度" type="number" min="0" max="1000000000000" step="1" disabled={busy} value={limit} onChange={e=>setLimit(e.target.value)} placeholder="留空不限额，0 表示禁止消费"/></label><div className="budgetPresets">{[10000,100000,1000000].map(value=><button type="button" key={value} disabled={busy} onClick={()=>setLimit(String(value))}>{value.toLocaleString()} tokens</button>)}<button type="button" disabled={busy} onClick={()=>setLimit('')}>不限额</button></div><p className="hint">累计额度，按上游报告的输入（含缓存）+ 输出结算，编辑上限不重置已用量。额度耗尽后拒绝新请求；最后一次请求可能使实际用量超过上限。有限额 Key 同时只允许一个生成请求。</p>{editing&&<p className="hint">当前已用 {editing.usedTokens.toLocaleString()} tokens{editing.unmeteredRequests?` · ${editing.unmeteredRequests} 次请求用量待核对`:''}</p>}</div>
      <div className="scopeToolbar"><Check label="全选所有提供商与模型" disabled={busy||!allIds.length} checked={!!allIds.length&&allIds.every(id=>selected.includes(id))} partial={selected.length>0&&!allIds.every(id=>selected.includes(id))} onChange={()=>toggle(allIds)}/><span>已选 {selected.length} / {allIds.length} 个模型</span></div>
      <p className="hint">全选包含当前已加载的模型；后续新增模型不会自动授权。取消全部勾选会禁止该 Key 调用任何模型。</p>
      <input className="scopeSearch" type="search" aria-label="搜索授权模型" placeholder="搜索提供商或模型…" value={query} onChange={e=>setQuery(e.target.value)}/>
      <div className="scopeTree">{visible.map(group=>{
        const ids=group.models;const checked=ids.every(id=>selected.includes(id));const count=ids.filter(id=>selected.includes(id)).length;
        const filtered=ids.filter(id=>`${group.id} ${group.label}`.toLowerCase().includes(query.toLowerCase())||`${id} ${modelLabel(local.models,id)}`.toLowerCase().includes(query.toLowerCase()));
        return <div className="scopeProvider" key={group.id}><div className="scopeProviderTitle"><Check label={`全选 ${group.label}`} disabled={busy} checked={checked} partial={count>0&&!checked} onChange={()=>toggle(ids)}/><span>{count} / {ids.length}</span></div><div className="scopeModels">{filtered.map(id=><div key={id}><Check label={modelLabel(local.models,id)} disabled={busy} checked={selected.includes(id)} onChange={()=>toggle([id])}/>{!currentModels.includes(id)&&<small>当前离线</small>}</div>)}</div></div>;
      })}</div>
      {!visible.length&&<p className="hint">{allIds.length?'没有匹配的模型。':'先在「账号与模型」连接提供商，加载可用模型。也可以先创建无调用权限的 Key。'}</p>}
      <div className="keyEditorFoot"><span>搜索仅过滤显示；全选仍作用于整个分组。</span><div className="buttons"><button type="button" disabled={busy} onClick={()=>setEditing(undefined)}>取消</button><button className="primary" disabled={busy||!name.trim()}>{busy?'正在保存…':editing?'保存权限':'生成 Key'}</button></div></div>
    </form>}
    <div className="keyList">{keys.map(key=><section className="keyCard" key={key.id}>
      <div className="keyCardTitle"><span className="keyGlyph"><Icon name="shield" size={20}/></span><div><h3>{key.name}</h3><code>{key.prefix}••••••••</code></div><span className={key.enabled?'keyEnabled':'muted'}>{key.enabled?'已启用':'已停用'}</span></div>
      <div className="keyBudgetStatus"><div><small>已用 tokens</small><strong>{key.usedTokens.toLocaleString()}</strong></div><div><small>总额度</small><strong>{key.tokenLimit===null?'不限额':key.tokenLimit.toLocaleString()}</strong></div><div><small>剩余额度</small><strong>{key.tokenLimit===null?'—':Math.max(0,key.tokenLimit-key.usedTokens).toLocaleString()}</strong></div><span className={key.unmeteredRequests?'quotaBlocked':key.tokenLimit!==null&&key.usedTokens>=key.tokenLimit?'quotaBlocked':'muted'}>{!key.enabled?'已停用':!key.agents.length||!key.models.length?'未授权调用':key.unmeteredRequests?`${key.unmeteredRequests} 次用量待核对`:key.pendingRequests?`${key.pendingRequests} 个在途请求`:key.tokenLimit!==null&&key.usedTokens>=key.tokenLimit?'额度已耗尽':'可继续调用'}</span></div>
      {key.unmeteredRequests>0&&<p className="hint">上游未返回完整用量，或上次运行存在未结算请求。有限额 Key 已暂停消费；请核对厂商账单后重置用量。</p>}
      <div className="keyAgentSummary">{key.agents.length?key.agents.map(id=><span key={id}>{agentCatalog.find(agent=>agent.id===id)?.name}</span>):<span>未授权任何 Agent 协议</span>}</div>
      <div className="keyScopeSummary">{[...new Set(key.models.map(id=>id.split('/')[0]))].map(provider=><span key={provider}>{local.providers.find(p=>p.id===provider)?.label??provider}<b>{key.models.filter(id=>id.startsWith(`${provider}/`)).length}</b></span>)}{!key.models.length&&<span>无模型权限</span>}</div>
      <div className="keyCardFoot"><small>{key.models.length} 个授权模型 · {new Date(key.createdAt).toLocaleDateString()}</small><div className="buttons"><button disabled={busy||editing!==undefined} onClick={()=>open(key)}>编辑权限</button><button disabled={busy} onClick={()=>void act(async()=>{await request(`/api/gateway-keys/${key.id}`,'PUT',{name:key.name,enabled:!key.enabled,models:key.models,agents:key.agents,tokenLimit:key.tokenLimit});})}>{key.enabled?'停用':'启用'}</button><button disabled={busy||!!key.pendingRequests} onClick={()=>{if(window.confirm(`重置「${key.name}」的已用 tokens 和待核对计数？这会恢复可消费额度。`))void act(async()=>{await request(`/api/gateway-keys/${key.id}/reset-usage`,'POST',{});});}}>重置用量</button><button className="danger" disabled={busy} onClick={()=>{if(window.confirm(`删除「${key.name}」后，使用它的客户端将无法继续调用。确定删除？`))void act(async()=>{await request(`/api/gateway-keys/${key.id}`,'DELETE');if(editing?.id===key.id)setEditing(undefined);});}}>删除</button></div></div>
    </section>)}</div>
    {!keys.length&&editing===undefined&&<div className="empty"><Icon name="shield" size={32}/><h2>尚未创建客户端 Key</h2><p>给每个应用独立授权，随时调整可用模型或停用访问。</p></div>}
    <p className="directoryNote"><Icon name="shield" size={14}/>客户端 Key 仅能调用授权模型，不能管理账号或操作工作台。停用、删除和修改权限对后续请求生效。</p>
  </div>;
}
