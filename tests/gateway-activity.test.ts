import { it,expect } from 'vitest';
import { observeUsage } from '../packages/core/src/gateway-activity.js';
import { agentConfig } from '../apps/console/src/agent-config.js';
async function inspect(payload:string,sse:boolean){
 let usage:unknown;const output:Buffer[]=[];const observer=observeUsage(sse,u=>{usage=u;});observer.on('data',chunk=>output.push(chunk));
 const finished=new Promise<void>((r,j)=>{observer.once('end',r);observer.once('error',j);});
 const bytes=Buffer.from(payload);for(let i=0;i<bytes.length;i+=7)observer.write(bytes.subarray(i,i+7));observer.end();await finished;
 expect(Buffer.concat(output).toString()).toBe(payload);return usage;
}
it('preserves byte-split UTF-8 streaming, accumulates Messages usage without double counting and handles SSE errors',async()=>{
 expect(await inspect('data: {"type":"message_start","message":{"usage":{"input_tokens":11,"output_tokens":0}}}\n\ndata: {"type":"content_block_delta","delta":{"text":"你好"}}\n\ndata: {"type":"message_delta","usage":{"output_tokens":9}}\n\ndata: {"type":"message_stop"}\n\n',true)).toEqual({inputTokens:11,outputTokens:9,failed:false});
 expect(await inspect('data: {"type":"error","error":{"message":"private"}}\n\n',true)).toMatchObject({failed:true,inputTokens:null,outputTokens:null});
});
it('keeps unreported token usage unknown and handles regular JSON',async()=>{
 expect(await inspect('{"output":["private"]}',false)).toMatchObject({inputTokens:null,outputTokens:null});
 expect(await inspect('{"usage":{"prompt_tokens":4,"completion_tokens":2}}',false)).toMatchObject({inputTokens:4,outputTokens:2});
});
it('generates scoped custom-provider configs with protocol-correct URLs and safe quoting',()=>{
 const codex=agentConfig('codex','http://127.0.0.1:9527','codex/gpt-5.6-sol');
 expect(codex).toContain('wire_api="responses"');expect(codex).toContain('env_key="TOKEN_FLOWB_KEY"');expect(codex).toContain('supports_websockets=false');
 const claude=agentConfig('claude','http://127.0.0.1:9527','codex/gpt-5.6-sol');
 expect(claude).toContain("ANTHROPIC_BASE_URL='http://127.0.0.1:9527'");expect(claude).toContain('ANTHROPIC_DEFAULT_HAIKU_MODEL');
 expect(agentConfig('claude','http://127.0.0.1:9527',"codex/a'b",true)).toContain("codex/a''b");
 expect(()=>agentConfig('codex','https://example.com','model')).toThrow();
 expect(JSON.parse(agentConfig('openai','http://127.0.0.1:9527','claude/shared')).baseURL).toBe('http://127.0.0.1:9527/v1');
});

it('counts Anthropic cached input alongside normal input without counting OpenAI cached details twice',async()=>{
 expect(await inspect('{"usage":{"input_tokens":10,"cache_read_input_tokens":20,"cache_creation_input_tokens":5,"output_tokens":3}}',false)).toMatchObject({inputTokens:35,outputTokens:3});
 expect(await inspect('{"usage":{"input_tokens":30,"input_tokens_details":{"cached_tokens":20},"output_tokens":3}}',false)).toMatchObject({inputTokens:30,outputTokens:3});
});

it('does not treat a clean EOF with initial Messages usage as final settlement',async()=>{
 const broken='data: {"type":"message_start","message":{"usage":{"input_tokens":7,"output_tokens":0}}}\n\ndata: {"type":"content_block_delta","delta":{"text":"generated but unmetered"}}\n\n';
 expect(await inspect(broken,true)).toEqual({inputTokens:7,outputTokens:0,failed:true});
 expect(await inspect(broken+'data: {"type":"message_stop"}\n\n',true)).toMatchObject({failed:true});
});
