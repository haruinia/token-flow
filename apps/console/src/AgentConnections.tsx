import { modelLabel } from './model-label';
import { copyText } from './clipboard';
import { useState } from 'react';
import type { LocalAgentSnapshot } from '../../../packages/core/src/cliproxy';
import { useGatewayOverview } from './GatewayHome';
import { agentCatalog,agentConfig,type AgentKind } from './agent-config';
import { Icon } from './Icons';
export function AgentConnections({local,preferredModel,onKeys,onAccounts}:{local:LocalAgentSnapshot;preferredModel?:string;onKeys:()=>void;onAccounts:()=>void}){
 const {keys,activity,error}=useGatewayOverview();const [kind,setKind]=useState<AgentKind>('codex');const [keyId,setKeyId]=useState('');const [selectedModel,setSelectedModel]=useState(preferredModel??'');
 const [platform,setPlatform]=useState('shell');const [credential,setCredential]=useState('');const [status,setStatus]=useState('');const [busy,setBusy]=useState(false);const [copied,setCopied]=useState(false);
 const key=keys.find(k=>k.id===keyId)??keys.find(k=>k.enabled&&preferredModel&&k.models.includes(preferredModel))??keys.find(k=>k.enabled);
 const models=local.models.filter(m=>key?.models.includes(m.id));const model=models.some(m=>m.id===selectedModel)?selectedModel:models[0]?.id??'';
 const agent=agentCatalog.find(a=>a.id===kind)!;const permitted=!!key?.agents.includes(kind==='qoder'?'openai':kind);
 let config='',configError='';if(model&&permitted){try{config=agentConfig(kind,location.origin,model,platform==='powershell');}catch{configError='无法生成配置，请检查本机网关地址。';}}
 const changed=()=>{setStatus('');setCopied(false);};
 const copy=async()=>{try{await copyText(config);setCopied(true);}catch{setStatus('复制失败，请手动选中配置复制。');}};
 const verify=async(invoke:boolean)=>{
  setBusy(true);setStatus('');
  try{
   const headers={'Authorization':`Bearer ${credential.trim()}`,'Content-Type':'application/json','anthropic-version':'2023-06-01'};
   const catalog=await fetch('/v1/models',{headers});
   if(!catalog.ok)throw new Error(`Key 认证失败（HTTP ${catalog.status}）`);
   const data=await catalog.json();if(!data.data.some((m:{id:string})=>m.id===model))throw new Error('此 Key 未授权选中的模型，或模型当前离线。');
   if(invoke){
    const body=kind==='codex'?{model,input:'Reply OK only.',max_output_tokens:64,stream:false}:kind==='claude'?{model,messages:[{role:'user',content:'Reply OK only.'}],max_tokens:64,stream:false}:{model,messages:[{role:'user',content:'Reply OK only.'}],max_tokens:64,stream:false};
    const response=await fetch(agent.path,{method:'POST',headers,body:JSON.stringify(model.startsWith('cursor/')?Object.fromEntries(Object.entries(body).filter(([key])=>!['max_tokens','max_output_tokens'].includes(key))):body),signal:AbortSignal.timeout(120000)});
    if(!response.ok){await response.body?.cancel();throw new Error(`模型调用失败（HTTP ${response.status}），请检查对应账号和模型状态。`);}
    const result=await response.json();
    const valid=kind==='codex'?result.status==='completed'&&Array.isArray(result.output):kind==='claude'?result.type==='message'&&Array.isArray(result.content):Array.isArray(result.choices);
    if(!valid)throw new Error('响应格式不符合所选协议，请检查网关转换。');
    setStatus(`${agent.name} 接入测试通过：Key、模型权限和 ${agent.protocol} 响应已验证。`);
   }else setStatus('Key 认证通过，所选模型已授权。未发起模型调用。');
  }catch(e){setStatus(e instanceof Error?e.message:'连接测试失败');}finally{setBusy(false);}
 };
 return <div className="agentConnections"><div className="gatewayHero"><div><span className="eyebrow">CONNECT YOUR AGENTS</span><h1>一个网关，各自熟悉的接口。</h1><p>为每个 Agent 分配独立 Key，选择模型，复制配置后接入。</p></div><button onClick={onKeys}><Icon name="shield" size={16}/>管理 Agent Key</button></div>
  {error&&<p className="notice" role="alert">{error}</p>}
  <div className="agentChoices">{agentCatalog.map(item=><button key={item.id} aria-pressed={kind===item.id} onClick={()=>{setKind(item.id);changed();}}><span className="agentLetter">{item.id==='codex'?'C':item.id==='claude'?'✳':'{}'}</span><span><strong>{item.name}</strong><small>{item.protocol}</small></span><Icon name="arrow" size={17}/></button>)}</div>
  <div className="agentSetup"><section className="agentSetupForm"><div className="sectionTitle"><h2>{agent.name} 接入配置</h2><span>{agent.protocol}</span></div><p className="hint">{agent.description}</p>
   <label>Agent 访问 Key<select aria-label="Agent 访问 Key" value={key?.id??''} disabled={busy} onChange={e=>{setKeyId(e.target.value);setSelectedModel('');setCredential('');changed();}}><option value="" disabled>选择已创建的 Key</option>{keys.map(k=><option key={k.id} value={k.id}>{k.name} · {k.enabled?`${k.models.length} 个授权模型`:'已停用'}</option>)}</select></label>
   {!keys.length&&<p className="hint">尚无访问凭据。<button className="textButton" onClick={onKeys}>创建第一把 Key →</button></p>}
   <label>调用模型<select aria-label="调用模型" value={model} disabled={busy||!models.length} onChange={e=>{setSelectedModel(e.target.value);changed();}}><option value="" disabled>选择此 Key 已授权的模型</option>{models.map(m=><option key={m.id} value={m.id}>{modelLabel(local.models,m.id)}</option>)}</select></label>
   {!models.length&&<p className="hint">模型需同时满足账号可用和 Key 授权。<button className="textButton" onClick={onAccounts}>查看厂商账号 →</button></p>}
   {key&&!permitted&&<p className="notice">该 Key 未授权此 Agent 类型，请在 Key 管理中调整协议范围。</p>}
   {key&&key.tokenLimit!==null&&<p className="hint">额度：已用 {key.usedTokens.toLocaleString()} / {key.tokenLimit.toLocaleString()} tokens{key.unmeteredRequests?' · 用量待核对，已暂停消费':''}</p>}
   {key&&!key.enabled&&<p className="notice">该 Key 已停用，请先在 Key 管理中启用。</p>}
   {model.startsWith('cursor/')&&<p className="hint">Cursor 来源目前支持文本调用，不支持工具、图片和生成长度参数。账户剩余额度请到官方用量页查看。</p>}
   {(kind==='claude'||kind==='codex')&&<label>终端环境<select aria-label="终端环境" value={platform} onChange={e=>{setPlatform(e.target.value);setCopied(false);}}><option value="shell">macOS / Linux · Bash / Zsh</option><option value="powershell">Windows · PowerShell</option></select></label>}
   <div className="agentAuthCheck"><h3>验证连接</h3><label>粘贴该 Key 的完整值<input type="password" autoComplete="off" disabled={busy} value={credential} onChange={e=>{setCredential(e.target.value);setStatus('');}} placeholder="仅用于本次验证，不保存到页面配置"/></label><div className="buttons"><button disabled={busy||!credential.trim()||!model||!key?.enabled||!permitted} onClick={()=>void verify(false)}>验证 Key</button><button disabled={busy||!credential.trim()||!model||!key?.enabled||!permitted||local.state!=='running'} onClick={()=>void verify(true)}>{busy?'验证中…':'发送测试请求'}</button></div><p className="hint">验证 Key 只查询模型目录；测试请求会进行一次真实模型调用并消耗少量额度。</p>{status&&<p className="connectionStatus" role="status">{status}</p>}</div>
  </section><section className="agentConfigPanel"><div className="sectionTitle"><h2>{kind==='openai'||kind==='qoder'?'连接参数':'启动配置'}</h2><button disabled={!config} onClick={()=>void copy()}>{copied?'已复制':'复制配置'}</button></div>{configError&&<p className="hint">{configError}</p>}{config?<pre tabIndex={0} aria-label="Agent 接入配置">{config}</pre>:<div className="empty"><Icon name="plug" size={30}/><p>选择已授权的 Agent 类型和可用模型后生成配置。</p></div>}<p className="hint">{kind==='qoder'?'按参数添加自定义模型，原账号与内置模型不变。CLI 请使用 /model → Custom 向导，不要手改 settings.json。':kind==='openai'?'将参数填入 Agent 的自定义 OpenAI 接口设置；使用 Responses 的客户端选择 /v1/responses。':'先将占位文字替换为实际客户端 Key，再在终端执行。环境变量作用于当前终端会话，不覆盖现有配置文件。'}</p>{kind==='claude'&&<p className="hint">默认主模型和子模型使用同一授权模型。不同模型的工具、图片和推理能力可能不同，以接入测试和实际任务为准。</p>}{agent.docs&&<p className="hint">配置依据：<a href={agent.docs} target="_blank" rel="noreferrer">{agent.name} 官方网关配置文档 ↗</a></p>}<div className="agentRoute"><small>此次调用链路</small><span>{agent.name}</span><Icon name="arrow" size={14}/><span>Key 鉴权与协议适配</span><Icon name="arrow" size={14}/><code>{model||'待选择模型'}</code></div></section></div>
  <section className="agentAccessList"><div className="sectionTitle"><h2>已分配的访问凭据</h2><span>每把 Key 对应一个 Agent 或应用</span></div>{keys.length?keys.map(item=>{const latest=activity?.recent.find(call=>call.keyId===item.id);return <div key={item.id}><span><strong>{item.name}</strong><small>{item.prefix}••••</small></span><span>{item.models.length} 个授权模型</span><span>{latest?`最近调用 ${new Date(latest.startedAt).toLocaleTimeString()}`:'本次运行尚无调用'}</span><b className={item.enabled?'good':'muted'}>{item.enabled?'已启用':'已停用'}</b></div>}):<p className="hint">创建 Key 后会在这里显示。真实调用发生后显示最近访问时间。</p>}</section>
 </div>;
}
