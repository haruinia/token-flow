import { copyText } from './clipboard';
import { useEffect, useState } from 'react';
import type { LocalAgentSnapshot } from '../../../packages/core/src/cliproxy';
import type { GatewayActivitySnapshot } from '../../../packages/core/src/gateway-activity';
import type { GatewayKey } from '../../../packages/core/src/gateway-keys';
import { Icon } from './Icons';
export function useGatewayOverview(){
 const [activity,setActivity]=useState<GatewayActivitySnapshot>();const [keys,setKeys]=useState<GatewayKey[]>([]);const [error,setError]=useState('');
 useEffect(()=>{let live=true;const refresh=async()=>{try{const values=await Promise.all(['/api/gateway/activity','/api/gateway-keys'].map(async path=>{const r=await fetch(path);if(!r.ok)throw new Error('网关状态读取失败');return r.json();}));if(live){setActivity(values[0]);setKeys(values[1].keys);setError('');}}catch{if(live)setError('暂时无法刷新网关数据，请检查本地服务。');}};void refresh();const timer=setInterval(()=>void refresh(),3000);return()=>{live=false;clearInterval(timer);};},[]);
 return {activity,keys,error};
}
const count=(value:number)=>new Intl.NumberFormat('zh-CN').format(value);
export function GatewayHome({local,onNavigate}:{local:LocalAgentSnapshot;onNavigate:(target:'accounts'|'keys'|'agents'|'gateway')=>void}){
 const {activity,keys,error}=useGatewayOverview();const [copied,setCopied]=useState(false);const [copyError,setCopyError]=useState('');
 const enabled=local.accounts.filter(a=>!a.disabled);const providers=local.providers.filter(p=>enabled.some(a=>a.provider===p.id));
 const url=`${location.origin}/v1`;
 const copy=async()=>{try{await copyText(url);setCopied(true);setCopyError('');}catch{setCopyError('复制失败，请手动选中地址复制。');}};
 const tokenTotal=activity&&activity.measured?count(activity.inputTokens+activity.outputTokens):'—';
 return <div className="gatewayHome">
  <div className="gatewayHero"><div><span className="eyebrow">TOKEN-FLOWB / LOCAL GATEWAY</span><h1>让模型能力，流向每一个 Agent。</h1><p>连接厂商账号，统一模型接口，为你的本地 Agent 分配访问权限。</p></div><button className="primary" onClick={()=>onNavigate('agents')}><Icon name="plus" size={16}/>接入 Agent</button></div>
  {(error||local.lastError||copyError)&&<div className="notice" role="alert">{error||local.lastError||copyError}</div>}
  <div className="gatewayMetrics"><div><span><i className={`dot ${local.state==='running'?'ok':''}`}/>模型网关</span><strong>{({running:'运行中',starting:'启动中',stopped:'已停止',failed:'启动失败'} as Record<string,string>)[local.state]??local.state}</strong><button className="textButton" onClick={()=>onNavigate('gateway')}>本机服务 <Icon name="arrow" size={12}/></button></div><div><span>可用模型</span><strong>{local.models.length}<small>个</small></strong><p>{providers.length} 个提供商 · {enabled.length} 个启用账号</p></div><div><span>Agent 访问凭据</span><strong>{keys.filter(k=>k.enabled).length}<small>把 Key</small></strong><p>按提供商和模型独立授权</p></div><div><span>本次运行已报告用量</span><strong>{tokenTotal}<small>tokens</small></strong><p>{activity?.total??0} 次调用 · {activity?.failed??0} 次失败</p></div></div>
  <section className="flowBoard"><div className="sectionTitle"><h2>一条链路，连接模型与工具</h2><span>本地认证 · 独立授权 · 协议适配</span></div><div className="flowPipeline">
    <button className="flowProviders" onClick={()=>onNavigate('accounts')}><small>01 / 厂商认证</small><h3>你的账号与模型</h3><div className="flowProviderTags">{(providers.length?providers:local.providers.slice(0,4)).map(p=><span key={p.id}><i className={`dot ${enabled.some(a=>a.provider===p.id)?'ok':''}`}/>{p.label}</span>)}</div><p>{enabled.length?'已授权模型统一进入模型目录':'连接第一个厂商账号，加载模型与额度'}</p></button>
    <span className="flowArrow"><Icon name="arrow"/></span>
    <div className="flowGateway"><img src="/logo.svg" alt=""/><small>02 / 统一模型网关</small><h3>Responses API</h3><p>模型路由 · Key 鉴权 · 用量记录</p><code>/v1/responses</code><span className="flowReturn">请求与响应双向适配</span></div>
    <span className="flowArrow"><Icon name="arrow"/></span>
    <button className="flowAgents" onClick={()=>onNavigate('agents')}><small>03 / AGENT 接入</small><h3>用你熟悉的工具</h3><div><span><b>Codex</b><em>Responses</em></span><span><b>Claude Code</b><em>Messages</em></span><span><b>OpenAI 兼容 Agent</b><em>Chat / Responses</em></span></div></button>
  </div></section>
  <div className="gatewayHomeColumns"><section className="gatewayEndpoint"><div className="sectionTitle"><h2>统一 API 入口</h2><span>OpenAI 兼容</span></div><label>Base URL<div className="inputAction"><input readOnly value={url} onFocus={e=>e.target.select()}/><button onClick={()=>void copy()}>{copied?'已复制':'复制'}</button></div></label><div className="endpointRows"><span><b>POST</b><code>/v1/responses</code><small>统一 Responses</small></span><span><b>POST</b><code>/v1/messages</code><small>Claude Code 适配</small></span><span><b>POST</b><code>/v1/chat/completions</code><small>Chat 兼容</small></span><span><b>GET</b><code>/v1/models</code><small>当前 Key 的模型目录</small></span></div><div className="endpointFooter"><Icon name="shield" size={15}/><span>使用独立客户端 Key。厂商凭据保留在网关内。</span><button className="textButton" onClick={()=>onNavigate('keys')}>管理 Key →</button></div></section>
  <section className="gatewayOnboarding"><div className="sectionTitle"><h2>{enabled.length&&keys.length?'继续配置':'开始流转'}</h2><span>三步接入</span></div>{[
   {target:'accounts' as const,title:'认证厂商账号',text:'加载各账号支持的模型与剩余额度',done:enabled.length>0},
   {target:'keys' as const,title:'分配 Agent Key',text:'为每个 Agent 选择可调用的提供商与模型',done:keys.some(k=>k.enabled&&k.models.length)},
   {target:'agents' as const,title:'配置本地 Agent',text:'复制对应协议配置，验证授权后开始使用',done:!!activity?.total},
  ].map((item,index)=><button key={item.target} onClick={()=>onNavigate(item.target)}><span className={item.done?'stepDone':''}>{item.done?'✓':`0${index+1}`}</span><div><strong>{item.title}</strong><small>{item.text}</small></div><Icon name="arrow" size={15}/></button>)}</section></div>
  <section className="gatewayRecent"><div className="sectionTitle"><h2>最近 API 调用</h2><span>仅本次运行 · 不保存对话内容</span></div>{activity?.recent.length?<div className="apiCallTable"><div className="apiCallRow apiCallHeader"><span>Agent / Key</span><span>模型与协议</span><span>输入 / 输出 tokens</span><span>状态 / 耗时</span></div>{activity.recent.slice(0,8).map(call=><div className="apiCallRow" key={call.id}><span><b>{call.agent}</b><small>{new Date(call.startedAt).toLocaleTimeString()}</small></span><span><code>{call.model}</code><small>{call.protocol}</small></span><span>{call.inputTokens===null?'—':count(call.inputTokens)} / {call.outputTokens===null?'—':count(call.outputTokens)}</span><span><b className={call.status<400?'good':'muted'}>{call.status}</b><small>{(call.durationMs/1000).toFixed(2)} s</small></span></div>)}</div>:<div className="gatewayEmpty"><Icon name="plug" size={24}/><div><strong>等待第一个 Agent 请求</strong><p>完成接入后，这里显示模型、协议、耗时和上游报告的 token 用量。</p></div><button onClick={()=>onNavigate('agents')}>查看接入方式 →</button></div>}<p className="usageFootnote">未返回 usage 的请求显示「—」，不估算 token。各厂商额度独立计量，共享的是模型访问能力。</p></section>
 </div>;
}
