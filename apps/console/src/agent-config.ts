import { a2aCapabilities } from '@cua-sample/contracts/a2a';
export type AgentKind='codex'|'claude'|'openai'|'qoder'|'cursor';
export const agentCatalog=[
 {id:'cursor' as const,name:'Cursor',protocol:'Chat Completions',path:'/v1/chat/completions',description:'Cursor Settings → Models → API Keys。自定义请求经过 Cursor 服务器，需要外网可访问的 HTTPS 网关；本机地址不能直接使用。Tab 补全继续使用 Cursor 内置模型。',docs:'https://cursor.com/help/models-and-usage/api-keys'},
 {id:'qoder' as const,name:'Qoder 独立应用',protocol:'Responses API',path:'/v1/responses',description:'Qoder 独立应用：Settings → Models → Add → OpenAI Compatible → Responses。仅适用于支持自定义地址的版本，不适用于 Qoder IDE。',docs:'https://docs.qoder.com/qoder/custom-models'},
 {id:'codex' as const,name:'Codex',protocol:'Responses API',path:'/v1/responses',description:'直接使用统一 Responses 接口，保留工具调用和流式响应。',docs:'https://developers.openai.com/codex/config-reference'},
 {id:'claude' as const,name:'Claude Code',protocol:'Anthropic Messages',path:'/v1/messages',description:'将 Messages 请求与结果交给网关转换，按 Key 路由到已授权模型。',docs:'https://code.claude.com/docs/en/llm-gateway'},
 {id:'openai' as const,name:'OpenAI 兼容 Agent',protocol:'Chat Completions',path:'/v1/chat/completions',description:'在支持自定义接口的工具中填写 Base URL、Key 和模型 ID。',docs:''},
];
const shell=(text:string)=>`'${text.replaceAll("'","'\\''")}'`;
const ps=(text:string)=>`'${text.replaceAll("'","''")}'`;
export function agentConfig(kind:AgentKind,origin:string,model:string,powershell=false){
 const url=new URL(origin);
 if(kind==='cursor'){
  if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.pathname!=='/'||['localhost','127.0.0.1','[::1]'].includes(url.hostname)||url.hostname.endsWith('.localhost')||url.hostname.endsWith('.local')||/^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)/.test(url.hostname))throw new Error('Cursor 需要外网可访问的 HTTPS 网关地址，不能使用本机或局域网地址。');
  return JSON.stringify({settings:'Cursor Settings → Models → API Keys',openAIApiKey:'替换为此 Agent 的客户端 Key',overrideOpenAIBaseURL:`${url.origin}/v1`,customModel:model,note:'保存后，在新对话中选择此自定义模型并测试。模型目录或网关测试成功不代表 Cursor 已接通。'},null,2);
 }
 if(url.protocol!=='http:'||!['127.0.0.1','localhost'].includes(url.hostname))throw new Error('仅支持本机网关地址');
 const quote=powershell?ps:shell;const baseURL=`${url.origin}/v1`;
 const assign=(key:string,value:string)=>powershell?`$env:${key} = ${quote(value)}`:`export ${key}=${quote(value)}`;
 if(kind==='codex')return [assign('TOKEN_FLOW_KEY','替换为此 Agent 的客户端 Key'),'codex '+[
  ...(a2aCapabilities(model)?.serverTools===false?['web_search="disabled"']:[]),'model_provider="token_flow"','model_providers.token_flow.name="token-flow"',`model_providers.token_flow.base_url=${JSON.stringify(baseURL)}`,
  'model_providers.token_flow.env_key="TOKEN_FLOW_KEY"','model_providers.token_flow.wire_api="responses"','model_providers.token_flow.requires_openai_auth=false','model_providers.token_flow.supports_websockets=false',
 ].map(value=>`-c ${quote(value)}`).join(' ')+` --model ${quote(model)}`].join('\n\n');
 if(kind==='claude')return [
  assign('ANTHROPIC_BASE_URL',url.origin),assign('ANTHROPIC_AUTH_TOKEN','替换为此 Agent 的客户端 Key'),assign('ANTHROPIC_API_KEY',''),
  ...['ANTHROPIC_MODEL','ANTHROPIC_DEFAULT_OPUS_MODEL','ANTHROPIC_DEFAULT_SONNET_MODEL','ANTHROPIC_DEFAULT_HAIKU_MODEL','ANTHROPIC_SMALL_FAST_MODEL','CLAUDE_CODE_SUBAGENT_MODEL'].map(key=>assign(key,model)),
  `claude --model ${quote(model)}`,
 ].join('\n');
 if(kind==='qoder')return JSON.stringify({settings:'Qoder Settings → Models → Add',provider:'OpenAI Compatible',api:'Responses',baseURL,apiKey:'替换为此 Agent 的客户端 Key',model,note:'仅适用于支持自定义地址的 Qoder 独立应用，不适用于 Qoder IDE。验证并添加后，在对话中选择该模型。'},null,2);
 return JSON.stringify({baseURL,apiKey:'替换为此 Agent 的客户端 Key',model,protocol:'chat/completions'},null,2);
}
