import OpenAI from 'openai';
import { z } from 'zod';
import type { ResponsesClient, ResponsesApiResponse } from './responses-loop.js';

export const providerSchema = z.object({
  kind: z.enum(['cliproxy','openai','custom']),
  baseURL: z.string().url().refine(value => {
    const url = new URL(value);
    return !url.username && !url.password && !url.search && !url.hash &&
      (url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1','localhost','[::1]'].includes(url.hostname)));
  }, 'Use HTTPS, or HTTP on loopback only.'),
  model: z.string().trim().max(200),
  historyMode: z.enum(['stateless','previous_response_id']).default('stateless'),
  reasoning: z.enum(['off','low','medium','high']).default('off'),
}).strict();
export type ProviderConfig = z.infer<typeof providerSchema>;
export const defaultProvider: ProviderConfig = {kind:'cliproxy',baseURL:'http://127.0.0.1:8317/v1',model:'',historyMode:'stateless',reasoning:'off'};
export type ProbeResult = {responses:boolean; functionCall:boolean; functionOutput:boolean; previousResponseId:boolean; imageInput:boolean; reasoning:boolean; errors:Record<string,string>};

export class ResponsesProvider implements ResponsesClient {
  private client: OpenAI;
  constructor(readonly config: ProviderConfig, apiKey: string) {
    providerSchema.parse(config);
    if (!apiKey) throw new Error('请先配置 Provider API Key 或启动 Local Agent。');
    this.client = new OpenAI({apiKey, baseURL:config.baseURL.replace(/\/$/,''),timeout:60000,maxRetries:0,
      fetchOptions:{redirect:'error'}});
  }
  async create(request: Record<string, unknown>, signal: AbortSignal): Promise<ResponsesApiResponse> {
    try { return await this.client.responses.create(request, {signal}) as ResponsesApiResponse; }
    catch (error) {
      if (signal.aborted) throw new Error('Run aborted.');
      // Classify known transport failures, but never expose raw upstream content or credentials.
      if (error instanceof OpenAI.APIError) {
        const message = error.message;
        const status = `HTTP ${error.status ?? 'network'}`;
        if (/TLS handshake timeout/i.test(message)) throw new Error(`上游 TLS 握手超时（${status}）。请检查 CLIProxyAPI 到上游的网络或代理连接，再重新探测；这不是模型能力结论。`);
        if (/\bEOF\b|connection reset|ECONNRESET/i.test(message)) throw new Error(`上游连接意外断开（${status}）。请检查网络或代理连接，稍后重新探测；这不是消息格式不支持的结论。`);
        if (/auth_unavailable/i.test(message)) throw new Error(`暂无可用上游账号（${status}）。账号可能处于错误冷却期，请检查 Local Agent 账号状态后重试。`);
      }
      throw new Error(error instanceof OpenAI.APIError ? `Provider 请求失败（HTTP ${error.status ?? 'network'}），请检查服务、模型及账号。` : 'Provider 连接失败或超时。');
    }
  }
  async listModels() {
    try { const page = await this.client.models.list(); return page.data.map(m => ({id:m.id})); }
    catch { throw new Error('无法获取模型列表，请检查 API 地址、Key 和登录状态。'); }
  }
  async probe(): Promise<ProbeResult> {
    const result: ProbeResult = {responses:false,functionCall:false,functionOutput:false,previousResponseId:false,imageInput:false,reasoning:false,errors:{}};
    const base = {model:this.config.model,store:false};
    const call = async (label: keyof Omit<ProbeResult,'errors'>, request:Record<string,unknown>) => {
      try {
        const response = await this.create({...base,...request},AbortSignal.timeout(60000));
        if (response.status !== 'completed' || !Array.isArray(response.output)) throw new Error('未返回完整 Responses 输出');
        result[label] = true; return response;
      } catch(e) {result.errors[label] = e instanceof Error ? e.message : '探测失败'; return undefined;}
    };
    const first = await call('responses',{input:'Reply with OK only.',store:true});
    const tool = {type:'function',name:'probe_echo',description:'Return a test value',strict:true,parameters:{type:'object',properties:{value:{type:'string'}},required:['value'],additionalProperties:false}};
    const request = {input:'Call probe_echo with value ping.',tools:[tool],tool_choice:{type:'function',name:'probe_echo'}};
    const toolResponse = await call('functionCall',request);
    const item = toolResponse?.output?.find(x=>x.type==='function_call' && x.name==='probe_echo');
    if (!item || !('call_id' in item) || typeof item.call_id !== 'string') {result.functionCall=false; result.errors.functionCall='模型未返回所要求的 function_call';}
    else await call('functionOutput',{tools:[tool],input:[{role:'user',content:request.input},...toolResponse!.output!,{type:'function_call_output',call_id:item.call_id,output:'pong'}]});
    if(first) await call('previousResponseId',{previous_response_id:first.id,input:'Reply OK again.',store:true});
    else result.errors.previousResponseId = '未执行：前置 Responses 请求失败，无法取得 response ID。请先解决连接错误后重新探测。';
    await call('imageInput',{input:[{role:'user',content:[{type:'input_text',text:'Acknowledge this image.'},{type:'input_image',image_url:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAeklEQVR4nO3PUQkAIBTAwBfMYMYxqiH8OITBAtxmnf11wwUNaEEDWtCAFjSgBQ1oQQNa0IAWNKAFDWhBA1rQgBY0oAUNaEEDWtCAFjSgBQ1oQQNa0IAWNKAFDWhBA1rQgBY0oAUNaEEDWtCAFjSgBQ1oQQNa0IAWPHYBe55BPDfzr3AAAAAASUVORK5CYII='}]}]});
    await call('reasoning',{input:'Reply OK.',reasoning:{effort:this.config.reasoning === 'off' ? 'low' : this.config.reasoning}});
    if (first && result.errors.previousResponseId) result.errors.previousResponseId += ' 此 HTTP 链路未通过历史续接，请选择 stateless（完整历史回传）；不代表模型不支持多轮对话。';
    if (result.errors.imageInput) result.errors.imageInput += ' 图片请求未通过，不能仅凭状态码判定模型不支持视觉。';
    return result;
  }
}
