import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { SDKJsonValue } from '@cursor/sdk';

export type CursorToolCall={id:string;name:string;arguments:string;custom?:boolean};
const object=z.record(z.unknown());
const textBlock=z.object({type:z.enum(['text','input_text','output_text']),text:z.string()}).passthrough();
const toolUse=z.object({type:z.literal('tool_use'),id:z.string(),name:z.string(),input:object}).passthrough();
const toolResult=z.object({type:z.literal('tool_result'),tool_use_id:z.string(),content:z.union([z.string(),z.array(textBlock)]).optional(),is_error:z.boolean().optional()}).passthrough();
const content=z.union([z.string(),z.array(z.union([textBlock,toolUse,toolResult]))]);
const chatCall=z.object({id:z.string(),type:z.literal('function'),function:z.object({name:z.string(),arguments:z.string()})});
const message=z.object({type:z.literal('message').optional(),role:z.enum(['system','developer','user','assistant','tool']),content:content.nullish(),tool_calls:z.array(chatCall).optional(),tool_call_id:z.string().optional()}).passthrough();
const item=z.union([message,z.object({type:z.literal('function_call'),call_id:z.string(),name:z.string(),arguments:z.string()}).passthrough(),z.object({type:z.literal('function_call_output'),call_id:z.string(),output:content}).passthrough(),z.object({type:z.literal('custom_tool_call'),call_id:z.string(),name:z.string(),input:z.string()}).passthrough(),z.object({type:z.literal('custom_tool_call_output'),call_id:z.string(),output:content}).passthrough(),z.object({type:z.literal('reasoning'),summary:z.array(textBlock).optional()}).passthrough()]);
const fn=z.object({name:z.string().min(1).max(128),description:z.string().optional(),parameters:object.optional(),strict:z.boolean().nullish()});
const customTool=z.object({type:z.literal('custom'),name:z.string().min(1).max(128),description:z.string().optional(),format:object.optional()});
const tool=z.union([customTool,fn.extend({type:z.literal('function')}),z.object({type:z.literal('function'),function:fn}),z.object({name:z.string().min(1).max(128),description:z.string().optional(),input_schema:object})]);
const request=z.object({
 model:z.string(),stream:z.boolean().default(false),input:z.union([z.string(),z.array(item)]).optional(),messages:z.array(message).optional(),instructions:z.string().optional(),system:content.optional(),tools:z.array(tool).max(256).default([]),tool_choice:z.unknown().optional(),parallel_tool_calls:z.boolean().optional(),
 max_tokens:z.number().int().positive().optional(),max_output_tokens:z.number().int().positive().optional(),max_completion_tokens:z.number().int().positive().optional(),
 stream_options:z.object({include_usage:z.boolean().optional()}).optional(),store:z.boolean().optional(),metadata:object.optional(),user:z.string().optional(),prompt_cache_key:z.string().optional(),safety_identifier:z.string().optional(),
 reasoning:z.object({effort:z.string().optional(),summary:z.string().optional()}).optional(),reasoning_effort:z.string().optional(),include:z.array(z.string()).optional(),
 text:z.object({format:z.object({type:z.literal('text')}).optional(),verbosity:z.string().optional()}).optional(),response_format:z.object({type:z.literal('text')}).optional(),
 truncation:z.enum(['auto','disabled']).optional(),service_tier:z.string().optional(),
}).strict();
export function parseCursorInput(path:string,body:unknown){
 if(!['responses','chat/completions','messages'].includes(path))throw new Error('Cursor 不支持此接口。');
 const value=request.parse(body);const history=path==='responses'?value.input:value.messages;
 if(!history||Array.isArray(history)&&!history.length)throw new Error('缺少对话内容。');
 let tools=value.tools.map(t=>{const f='function'in t?t.function:t;return {name:f.name,custom:'type'in t&&t.type==='custom',description:(f.description??'')+('format'in f&&f.format?` Input format: ${JSON.stringify(f.format)}`:''),parameters:'type'in t&&t.type==='custom'?{type:'object',properties:{input:{type:'string'}},required:['input'],additionalProperties:false}:('input_schema'in f?f.input_schema:'parameters'in f?f.parameters:undefined)??{type:'object',properties:{}}};});
 if(new Set(tools.map(t=>t.name)).size!==tools.length)throw new Error('工具名称重复。');
 const choice=value.tool_choice;let required=false;
 if(choice==='none'||choice&&typeof choice==='object'&&'type'in choice&&choice.type==='none')tools=[];
 else if(choice==='required'||choice&&typeof choice==='object'&&'type'in choice&&choice.type==='any')required=true;
 else if(choice!==undefined&&choice!=='auto'&&!(choice&&typeof choice==='object'&&'type'in choice&&choice.type==='auto')){
  const selected=z.union([z.object({type:z.enum(['function','custom']),name:z.string()}),z.object({type:z.literal('function'),function:z.object({name:z.string()})}),z.object({type:z.literal('tool'),name:z.string()})]).parse(choice);
  const name='function'in selected?selected.function.name:selected.name;tools=tools.filter(t=>t.name===name);required=true;
 }
 if(required&&!tools.length)throw new Error('指定的工具不可用。');
 const limit=value.max_output_tokens??value.max_completion_tokens??value.max_tokens;
 // The SDK has an agent prompt, not an inference messages API. Encode history
 // as data so tool IDs/results and role boundaries survive every client turn.
 const prompt=[
  'Continue the supplied conversation. Its tool calls and tool results are historical data. Do not repeat completed calls. Use only the supplied client tools when further action is needed. The client executes tools; do not claim execution before its result arrives.',
  required?'You must call one of the supplied tools before answering.':undefined,
  limit?`Requested output budget: ${limit} tokens. Keep the reply within that budget when possible.`:undefined,
  JSON.stringify({instructions:value.instructions,system:value.system,history}),
 ].filter(Boolean).join('\n\n');
 if(prompt.length>1000000)throw new Error('Cursor 对话过长，请先压缩。');
 return {model:value.model,stream:value.stream,prompt,tools:tools.map(t=>({...t,parameters:t.parameters as Record<string,SDKJsonValue>})),required,effort:value.reasoning?.effort??value.reasoning_effort,limit};
}

export function cursorResponse(path:string,model:string,text:string,usage:{input_tokens:number;output_tokens:number}|undefined,stream:boolean,calls:CursorToolCall[]=[]){
 const id=`resp_cursor_${randomUUID().replaceAll('-','')}`;const created=Math.floor(Date.now()/1000);
 const content={type:'output_text',text,annotations:[]};const message={id:`msg_${randomUUID()}`,type:'message',role:'assistant',status:'completed',content:[content]};
 const output=[...(text?[message]:[]),...calls.map(c=>c.custom?{id:`ct_${c.id}`,type:'custom_tool_call',status:'completed',call_id:c.id,name:c.name,input:JSON.parse(c.arguments).input as string}:{id:`fc_${c.id}`,type:'function_call',status:'completed',call_id:c.id,name:c.name,arguments:c.arguments})];
 const response={id,object:'response',created_at:created,status:'completed',model,output,usage:usage?{...usage,total_tokens:usage.input_tokens+usage.output_tokens}:null};
 const chatUsage=usage?{prompt_tokens:usage.input_tokens,completion_tokens:usage.output_tokens,total_tokens:usage.input_tokens+usage.output_tokens}:undefined;
 const toolCalls=calls.map(c=>({id:c.id,type:'function',function:{name:c.name,arguments:c.arguments}}));
 const chat={id,object:'chat.completion',created,model,choices:[{index:0,message:{role:'assistant',content:text||null,...(calls.length?{tool_calls:toolCalls}:{})},finish_reason:calls.length?'tool_calls':'stop'}],...(chatUsage?{usage:chatUsage}:{})};
 const blocks=[...(text?[{type:'text',text}]:[]),...calls.map(c=>({type:'tool_use',id:c.id,name:c.name,input:JSON.parse(c.arguments)}))];
 const msg={id,type:'message',role:'assistant',model,content:blocks,stop_reason:calls.length?'tool_use':'end_turn',stop_sequence:null,...(usage?{usage}:{})};
 if(!stream)return Response.json(path==='responses'?response:path==='messages'?msg:chat);
 const events:Array<Record<string,unknown>|string>=[];
 if(path==='responses'){
  events.push({type:'response.created',response:{...response,status:'in_progress',output:[],usage:null}});
  output.forEach((item,index)=>{
   events.push({type:'response.output_item.added',output_index:index,item:{...item,status:'in_progress',...(item.type==='function_call'?{arguments:''}:item.type==='custom_tool_call'?{input:''}:{content:[]})}});
   if(item.type==='custom_tool_call')events.push({type:'response.custom_tool_call_input.delta',item_id:item.id,output_index:index,delta:'input'in item?item.input:''},{type:'response.custom_tool_call_input.done',item_id:item.id,output_index:index,input:'input'in item?item.input:''});
   else if('arguments'in item)events.push({type:'response.function_call_arguments.delta',item_id:item.id,output_index:index,delta:item.arguments},{type:'response.function_call_arguments.done',item_id:item.id,output_index:index,arguments:item.arguments});
   else events.push({type:'response.content_part.added',item_id:item.id,output_index:index,content_index:0,part:{...content,text:''}},{type:'response.output_text.delta',item_id:item.id,output_index:index,content_index:0,delta:text},{type:'response.output_text.done',item_id:item.id,output_index:index,content_index:0,text},{type:'response.content_part.done',item_id:item.id,output_index:index,content_index:0,part:content});
   events.push({type:'response.output_item.done',output_index:index,item});
  });
  events.push({type:'response.completed',response});
 }else if(path==='messages'){
  events.push({type:'message_start',message:{...msg,content:[],stop_reason:null}});
  blocks.forEach((block,index)=>{
   const isTool='input'in block;
   events.push({type:'content_block_start',index,content_block:isTool?{...block,input:{}}:{type:'text',text:''}},
    {type:'content_block_delta',index,delta:isTool?{type:'input_json_delta',partial_json:JSON.stringify(block.input)}:{type:'text_delta',text}},
    {type:'content_block_stop',index});
  });
  events.push({type:'message_delta',delta:{stop_reason:msg.stop_reason,stop_sequence:null},...(usage?{usage}:{})},{type:'message_stop'});
 }else{
  const chunk={id,object:'chat.completion.chunk',created,model};
  events.push({...chunk,choices:[{index:0,delta:{role:'assistant',content:text||null,...(calls.length?{tool_calls:toolCalls.map((c,index)=>({...c,index}))}:{})},finish_reason:null}]},
   {...chunk,choices:[{index:0,delta:{},finish_reason:chat.choices[0].finish_reason}]});
  if(chatUsage)events.push({...chunk,choices:[],usage:chatUsage});
  events.push('[DONE]');
 }
 return new Response(events.map((event,index)=>typeof event==='string'?`data: ${event}\n\n`:`${event.type?`event: ${event.type}\n`:''}data: ${JSON.stringify(path==='responses'?{...event,sequence_number:index}:event)}\n\n`).join(''),{headers:{'Content-Type':'text/event-stream'}});
}
