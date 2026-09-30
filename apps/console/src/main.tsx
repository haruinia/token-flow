import { AccountsPane } from './AccountsPane';
import { A2APane, MaintenancePane } from './A2APane';
import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { RunRecord } from '@cua-sample/contracts';
import './style.css';
import { Icon, type IconName } from './Icons';
import { GatewayHome } from './GatewayHome';
import type { AgentKind } from './agent-config';
import { AgentConnections } from './AgentConnections';
import { GatewayKeysPane } from './GatewayKeysPane';
import { LocalAgentPane } from './LocalAgentPane';
import type { LocalAgentSnapshot } from '../../../packages/core/src/cliproxy';

type Provider={engine?:'legacy'|'pi';kind:'cliproxy'|'openai'|'custom';baseURL:string;model:string;historyMode:'stateless'|'previous_response_id';reasoning:'off'|'low'|'medium'|'high'};
type Local=LocalAgentSnapshot;
type Probe={responses:boolean;functionCall:boolean;functionOutput:boolean;previousResponseId:boolean;imageInput:boolean;reasoning:boolean;errors:Record<string,string>};
async function api<T>(path:string,body?:unknown,method?:string):Promise<T>{
  const response=await fetch(path,{method:method??(body===undefined?'GET':'POST'),headers:body===undefined?undefined:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const data=await response.json();if(!response.ok)throw new Error(data.error??data.message??`HTTP ${response.status}`);return data;
}
const stateNames:Record<string,string>={idle:'空闲',agent_control:'Agent 正在操作',pausing:'等待当前操作结束',human_control:'人工接管',resync:'同步页面状态',running:'运行中',completed:'已完成',failed:'失败',cancelled:'已停止',stopped:'已停止',starting:'启动中'};
function App(){
  const [modelView,setModelView]=useState<'accounts'|'connection'|'gateway'|'keys'>('accounts');
  const [credentialWarnings,setCredentialWarnings]=useState<string[]>([]);
  const [preferredModel,setPreferredModel]=useState('');
  const [preferredKind,setPreferredKind]=useState<AgentKind>('codex');
  const [historyQuery,setHistoryQuery]=useState('');
  const [historyStatus,setHistoryStatus]=useState('all');
  const [tab,setTab]=useState('a2a');
  useEffect(()=>{document.querySelector('main')?.scrollTo(0,0);},[tab]);
  const [returnAfterLogin,setReturnAfterLogin]=useState<string|null>(null);
  const [error,setError]=useState('');const [busy,setBusy]=useState('');
  const [provider,setProvider]=useState<Provider>({kind:'cliproxy',baseURL:'http://127.0.0.1:8317/v1',model:'',historyMode:'stateless',reasoning:'off'});
  const [apiKey,setApiKey]=useState('');const [hasKey,setHasKey]=useState(false); const [probe,setProbe]=useState<Probe>();const [models,setModels]=useState<{id:string}[]>([]);
  const [local,setLocal]=useState<Local>({state:'stopped',loginState:'idle',port:8317,logs:[],accounts:[],models:[],accountError:undefined,lastError:undefined,quotas:{},quotaBusy:false,providers:[],login:undefined});
  const [history,setHistory]=useState<RunRecord[]>([]);
  const [notice,setNotice]=useState('');
  async function refresh(){
    const results=await Promise.allSettled([
      api<Local>('/api/local-agent').then(setLocal),
    ]);
    const failed=results.find(result=>result.status==='rejected');if(failed?.status==='rejected')throw failed.reason;
  }
  const act=async(label:string,fn:()=>Promise<void>)=>{setBusy(label);setError('');setNotice('');try{await fn();await refresh();}catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy('');}};
  useEffect(()=>{void api<{provider:Provider;hasKey:boolean;probe?:Probe;credentialWarnings?:string[]}>('/api/settings').then(s=>{setProvider(s.provider);setHasKey(s.hasKey);setProbe(s.probe);setCredentialWarnings(s.credentialWarnings??[]);}).catch(e=>setError(e.message));void api<RunRecord[]>('/api/history').then(setHistory).catch(e=>setError(e.message));void refresh().catch(e=>setError(e.message));const timer=setInterval(()=>void refresh().catch(()=>{}),1500);return()=>clearInterval(timer);},[]);
  useEffect(()=>{if(returnAfterLogin!==null&&local.login?.status==='completed'&&local.login.id!==returnAfterLogin){setTab('a2a');setReturnAfterLogin(null);}},[local.login?.id,local.login?.status,returnAfterLogin]);
  const save=async()=>{await api('/api/settings',{provider,...(apiKey?{apiKey}:{})},'PUT');setApiKey('');setHasKey(provider.kind==='cliproxy'||!!apiKey||hasKey);setProbe(undefined);};
  const command=(action:string)=>act(action,async()=>{setLocal(await api(`/api/local-agent/${action}`,{}));});
  const visibleHistory=history.filter(item=>(historyStatus==='all'||item.status===historyStatus)&&`${item.prompt} ${item.model}`.toLocaleLowerCase().includes(historyQuery.trim().toLocaleLowerCase()));
  const desktopPlatform = (window as Window & {desktop?:{platform:string}}).desktop?.platform;
  return <div className={`app ${desktopPlatform==='darwin'?'nativeMac':''}`}>
    <aside className="sidebar">
      <div className="brand"><img className="mark" src="/logo.svg" alt="" width="38" height="38"/><div>token-flow<small>你的模型，流向每个 Agent</small></div></div>
      <button className="newTask" onClick={()=>{setTab('models');setModelView('accounts');}}><Icon name="plus"/>连接厂商账号</button>
      <span className="navLabel">模型网关</span>
      <nav aria-label="主导航">{[['a2a','plug','A2A 接入'],['gateway','workspace','API 总览'],['models','model','模型中心'],['agents','plug','Agent 接入'],['keys','shield','API Keys']].map(([id,icon,name])=><button key={id} className={tab===id?'selected':''} aria-current={tab===id?'page':undefined} aria-label={name} onClick={()=>{setTab(id);if(id==='models')setModelView('accounts');}}><Icon name={icon as IconName}/>{name}</button>)}</nav>
      <span className="navLabel secondaryLabel">辅助工具</span><nav aria-label="辅助导航">{[['accounts','model','多账号切换'],['maintenance','sliders','网关维修'],['history','history','执行历史'],['contact','message','联系我们']].map(([id,icon,name])=><button key={id} className={tab===id?'selected':''} aria-current={tab===id?'page':undefined} aria-label={name} onClick={()=>setTab(id)}><Icon name={icon as IconName}/>{name}</button>)}</nav>
      <div className="sideStatus"><small><Icon name="plug" size={14}/>本机网关</small><p><i className={local.state==='running'?'dot ok':'dot'}/>服务状态 <b>{stateNames[local.state]??local.state}</b></p><p><i className={local.accounts.some(a=>!a.disabled)?'dot ok':'dot'}/>启用账号 <b>{local.accounts.filter(a=>!a.disabled).length}</b></p><p><i className={local.models.length?'dot ok':'dot'}/>可用模型 <b>{local.models.length}</b></p><div className="foot"><Icon name="shield" size={14}/>厂商凭据仅保存在本机</div></div>
    </aside>
    <main><header className="top"><div className="pageIdentity"><Icon name={tab==='models'?'model':tab==='agents'?'plug':tab==='keys'?'shield':tab==='contact'?'message':tab==='history'?'history':'workspace'} size={17}/><h1>{{a2a:'A2A 接入',gateway:'API 总览',agents:'Agent 接入',keys:'API Keys',accounts:'多账号切换',maintenance:'网关维修',models:'模型中心',history:'执行历史',contact:'联系我们'}[tab]}</h1><span className="localBadge">token-flow / local</span></div><div className="topActions"><span className="status"><i className={`dot ${local.state==='running'?'ok':''}`}/>网关{stateNames[local.state]??local.state}</span><button onClick={()=>{setTab('models');setModelView('gateway');}}><Icon name="sliders" size={15}/>网关设置</button></div></header>
      {credentialWarnings.length>0&&<div className="notice credentialWarning" role="alert">{credentialWarnings.map(message=><p key={message}>{message}</p>)}<button onClick={()=>{setTab('models');setModelView('connection');}}>查看模型配置</button><button onClick={()=>setCredentialWarnings([])}>知道了</button></div>}
      {error&&<div className="error" role="alert">{error}<button aria-label="关闭错误" onClick={()=>setError('')}>×</button></div>}
      {notice&&<div className="notice" role="status">{notice}</div>}
      {busy&&<div className="busy" role="status">{busy}…</div>}
      {tab==='a2a'&&<A2APane local={local} onManual={(kind,model)=>{setPreferredKind(kind??'codex');if(model)setPreferredModel(model);setTab('agents');}} onAccounts={()=>{setReturnAfterLogin(local.login?.id??'');setTab('models');setModelView('accounts');}} onMaintenance={()=>setTab('maintenance')}/>}
      {tab==='accounts'&&<AccountsPane local={local} onAccounts={()=>{setTab('models');setModelView('accounts');}} onGateway={()=>setTab('a2a')}/>}
      {tab==='maintenance'&&<MaintenancePane local={local}/>}
      {tab==='gateway'&&<GatewayHome local={local} onNavigate={target=>{if(target==='agents'||target==='keys')setTab(target);else{setTab('models');setModelView(target);}}}/>}
      {tab==='agents'&&<AgentConnections local={local} preferredKind={preferredKind} preferredModel={preferredModel} onKeys={()=>setTab('keys')} onAccounts={()=>{setTab('models');setModelView('accounts');}}/>}
      {tab==='keys'&&<GatewayKeysPane local={local}/>}
      {tab==='models'&&<><button className="returnA2A" onClick={()=>setTab('a2a')}>← 返回接入首页</button><div className="modelCenterHeading"><div><span className="eyebrow">YOUR MODELS, ONE PLACE</span><h2>连接一次，模型随时可用。</h2><p>认证厂商账号，查看额度，将可用模型提供给你的 Agent。</p></div><div className="gatewaySummary"><span><i className={`dot ${local.state==='running'?'ok':''}`}/>网关{stateNames[local.state]??local.state}</span><strong>{local.accounts.filter(a=>!a.disabled).length}<small>启用账号</small><b>·</b>{local.models.length}<small>可用模型</small></strong></div></div><div className="modelCenterTabs" role="tablist" aria-label="模型中心">{([['accounts','账号与模型'],['connection','接口与能力'],['keys','API Keys'],['gateway','网关设置']] as const).map(([id,label])=><button key={id} role="tab" aria-selected={modelView===id} onClick={()=>setModelView(id)}>{label}</button>)}<span>{provider.model?`当前模型 · ${provider.model}`:'尚未选择任务模型'}</span></div></>}
      {tab==='models'&&modelView==='connection'&&<div className="settings"><section><div className="sectionTitle"><h2>任务模型</h2><span>选择接口并验证能力</span></div><p className="hint">已连接账号的模型可在「账号与模型」中选择。也可以接入 OpenAI 或其他兼容接口。</p><form onSubmit={e=>{e.preventDefault();void act('保存设置',async()=>{await save();setNotice('设置已保存，请刷新模型并探测能力。');});}}>
        <label>Provider<select value={provider.kind} onChange={e=>{const kind=e.target.value as Provider['kind'];setProvider({...provider,kind,baseURL:kind==='openai'?'https://api.openai.com/v1':`http://127.0.0.1:${local.port}/v1`,model:''});setModels([]);setProbe(undefined);}}><option value="cliproxy">本机网关 · 已连接账号</option><option value="openai">OpenAI</option><option value="custom">Custom · OpenAI-compatible</option></select></label>
        <label>Base URL<input required value={provider.baseURL} disabled={provider.kind==='cliproxy'} onChange={e=>setProvider({...provider,baseURL:e.target.value})}/></label>
        {provider.kind!=='cliproxy'&&<label>API Key <span className="muted">{hasKey?'已保存；留空则保留':''}</span><input type="password" autoComplete="off" value={apiKey} onChange={e=>setApiKey(e.target.value)} placeholder="只写入系统加密存储，不返回明文"/></label>}
        <label>模型 ID<div className="inputAction"><input list="models" required value={provider.model} onChange={e=>setProvider({...provider,model:e.target.value})} placeholder="从当前 Provider 获取或输入准确模型 ID"/><button type="button" disabled={!!busy} onClick={()=>act('读取模型',async()=>{await save();setModels((await api<{data:{id:string}[]}>('/api/providers/models')).data);})}>刷新模型</button></div><datalist id="models">{(provider.kind==='cliproxy'?local.models:models).map(m=><option key={m.id} value={m.id}/>)}</datalist></label>
        <div className="columns"><label>对话历史<select value={provider.historyMode} onChange={e=>setProvider({...provider,historyMode:e.target.value as Provider['historyMode']})}><option value="stateless">无状态 · 发送完整历史</option><option value="previous_response_id">previous_response_id</option></select></label><label>Reasoning<select value={provider.reasoning} onChange={e=>setProvider({...provider,reasoning:e.target.value as Provider['reasoning']})}>{['off','low','medium','high'].map(v=><option key={v}>{v}</option>)}</select></label></div>
        <div className="buttons"><button type="submit" disabled={!!busy}>保存设置</button><button type="button" className="primary" disabled={!!busy||!provider.model} onClick={()=>act('探测模型能力（会请求 Provider）',async()=>{await save();setProbe(await api('/api/providers/probe',{}));})}>保存并探测能力 →</button></div>
      </form></section><section><h2>能力探测</h2><p className="hint">实际请求验证，不由模型名称推断。历史续接和图片为独立能力，失败不等于模型整体不可用。探测会产生少量模型调用。</p>{probe?.responses && !probe.previousResponseId && <p className="hint">此链路未通过 previous_response_id。请将「对话历史」改为 stateless（完整历史回传），保存并重新探测后运行。</p>}<div className="probe">{[['responses','Responses API'],['functionCall','Function Call'],['functionOutput','Function Output'],['previousResponseId','previous_response_id'],['imageInput','Image Input'],['reasoning','Reasoning']].map(([key,label])=><div key={key}><span className="mono">{label}</span><b className={probe?.[key as keyof Probe]===true?'good':''}>{!probe?'未探测':probe.errors[key]?.startsWith('未执行：')?'— 未执行':probe[key as keyof Probe]===true?'✓ 通过':'× 未通过'}</b>{probe?.errors[key]&&<small>{probe.errors[key]}</small>}</div>)}</div><div className="connectionNext"><h2>供其他应用调用</h2><p className="hint">所有已连接账号的可用模型统一由本机网关提供。在「API Keys」创建客户端密钥，勾选允许调用的提供商与模型后即可接入。</p><button onClick={()=>setModelView('keys')}>管理客户端 Key →</button></div></section></div>}
      {tab==='models'&&modelView==='keys'&&<GatewayKeysPane local={local}/>}
      {tab==='models'&&(modelView==='accounts'||modelView==='gateway')&&<LocalAgentPane view={modelView} selectedModel={provider.kind==='cliproxy'?provider.model:''} local={local} disabled={!!busy} onAction={command}
        onGateway={apiKey=>act(apiKey?'保存 API Key':'重新生成 API Key',async()=>{await api('/api/local-agent/gateway',{apiKey:apiKey??''},'PUT');})}
        onLoginAction={(action,data)=>act('处理授权',async()=>{setLocal(await api(`/api/local-agent/login/${action}`,data));})}
        onAccount={(id,enabled)=>act(enabled?'启用账号':'停用账号',async()=>{setLocal(await api(`/api/local-agent/accounts/${id}`,{enabled}));})}
        onDeleteAccount={id=>act('删除账号凭据',async()=>{setLocal(await api(`/api/local-agent/accounts/${id}`,undefined,'DELETE'));setNotice('已成功删除该账号凭据文件。');})}
        onImportLocal={provider=>act('导入本机应用凭据',async()=>{setLocal(await api(`/api/local-agent/import-local/${provider}`,{}));setNotice(`已成功导入本机 ${provider} 账号凭据。`);})}
        onUseModel={async model=>{setPreferredModel(model);setTab('agents');}}/>}
      {tab==='history'&&<section className="history"><div className="sectionTitle"><h2>执行历史</h2><span>{visibleHistory.length} / {history.length} 条记录</span></div><div className="historyFilters"><label><span className="srOnly">搜索历史</span><input type="search" value={historyQuery} onChange={e=>setHistoryQuery(e.target.value)} placeholder="搜索任务内容或模型…"/></label><label><span className="srOnly">任务状态</span><select aria-label="任务状态" value={historyStatus} onChange={e=>setHistoryStatus(e.target.value)}><option value="all">全部状态</option><option value="completed">已完成</option><option value="failed">失败</option><option value="cancelled">已停止</option><option value="running">运行中</option></select></label></div>{!history.length?<div className="empty"><Icon name="history" size={32}/><h2>暂无历史记录</h2></div>:!visibleHistory.length?<div className="empty"><Icon name="history" size={28}/><h2>没有匹配的记录</h2><p>试试其他关键词，或清除筛选条件。</p><button onClick={()=>{setHistoryQuery('');setHistoryStatus('all');}}>清除筛选</button></div>:visibleHistory.map(item=><div className="historyRow" key={item.id}><span className="mono">{new Date(item.startedAt).toLocaleString()}</span><strong>{item.prompt}</strong><span>{item.model}</span><b>{stateNames[item.status]}</b></div>)}</section>}
      {tab==='contact'&&<section className="history"><div className="sectionTitle"><h2>联系邮箱</h2></div><div className="contactList"><p><strong>everything call me：</strong><a className="contactLink" href="mailto:wangwenyang9527@gmail.com">wangwenyang9527@gmail.com</a></p><p><strong>Joint test personnel：</strong><a className="contactLink" href="mailto:doubyrui@gmail.com">doubyrui@gmail.com</a></p></div></section>}
    </main>
  </div>;
}
createRoot(document.getElementById('root')!).render(<App/>);
