export type AgentKind='codex'|'claude'|'openai'|'qoder';
export const agentCatalog=[
 {id:'qoder' as const,name:'Qoder IDE',protocol:'Responses API',path:'/v1/responses',description:'Qoder Settings → Models → Add → OpenAI Compatible，选择 Responses，填写下方参数后验证并添加。CLI 的 Custom 向导以当前账号目录为准。',docs:'https://docs.qoder.com/qoder/custom-models'},
 {id:'codex' as const,name:'Codex',protocol:'Responses API',path:'/v1/responses',description:'直接使用统一 Responses 接口，保留工具调用和流式响应。',docs:'https://developers.openai.com/codex/config-reference'},
 {id:'claude' as const,name:'Claude Code',protocol:'Anthropic Messages',path:'/v1/messages',description:'将 Messages 请求与结果交给网关转换，按 Key 路由到已授权模型。',docs:'https://code.claude.com/docs/en/llm-gateway'},
 {id:'openai' as const,name:'OpenAI 兼容 Agent',protocol:'Chat Completions',path:'/v1/chat/completions',description:'在支持自定义接口的工具中填写 Base URL、Key 和模型 ID。',docs:''},
];
const shell=(text:string)=>`'${text.replaceAll("'","'\\''")}'`;
const ps=(text:string)=>`'${text.replaceAll("'","''")}'`;
export function agentConfig(kind:AgentKind,origin:string,model:string,powershell=false){
 const url=new URL(origin);
 if(url.protocol!=='http:'||!['127.0.0.1','localhost'].includes(url.hostname))throw new Error('仅支持本机网关地址');
 const quote=powershell?ps:shell;const baseURL=`${url.origin}/v1`;
 const assign=(key:string,value:string)=>powershell?`$env:${key} = ${quote(value)}`:`export ${key}=${quote(value)}`;
 if(kind==='codex')return [assign('TOKEN_FLOWB_KEY','替换为此 Agent 的客户端 Key'),'codex '+[
  'model_provider="token_flowb"','model_providers.token_flowb.name="token-flowb"',`model_providers.token_flowb.base_url=${JSON.stringify(baseURL)}`,
  'model_providers.token_flowb.env_key="TOKEN_FLOWB_KEY"','model_providers.token_flowb.wire_api="responses"','model_providers.token_flowb.requires_openai_auth=false','model_providers.token_flowb.supports_websockets=false',
 ].map(value=>`-c ${quote(value)}`).join(' ')+` --model ${quote(model)}`].join('\n\n');
 if(kind==='claude')return [
  assign('ANTHROPIC_BASE_URL',url.origin),assign('ANTHROPIC_AUTH_TOKEN','替换为此 Agent 的客户端 Key'),assign('ANTHROPIC_API_KEY',''),
  ...['ANTHROPIC_MODEL','ANTHROPIC_DEFAULT_OPUS_MODEL','ANTHROPIC_DEFAULT_SONNET_MODEL','ANTHROPIC_DEFAULT_HAIKU_MODEL','ANTHROPIC_SMALL_FAST_MODEL','CLAUDE_CODE_SUBAGENT_MODEL'].map(key=>assign(key,model)),
  `claude --model ${quote(model)}`,
 ].join('\n');
 if(kind==='qoder')return JSON.stringify({settings:'Qoder Settings → Models → Add',provider:'OpenAI Compatible',api:'Responses',baseURL,apiKey:'替换为此 Agent 的客户端 Key',model,note:'验证并添加，然后在 Qoder 对话中选择该模型。原登录和内置模型保留。'},null,2);
 return JSON.stringify({baseURL,apiKey:'替换为此 Agent 的客户端 Key',model,protocol:'chat/completions'},null,2);
}
