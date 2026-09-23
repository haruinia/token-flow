import { Transform } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { randomUUID } from 'node:crypto';

export type GatewayCall={id:string;keyId:string;agent:string;model:string;protocol:string;startedAt:string;durationMs:number;status:number;inputTokens:number|null;outputTokens:number|null};
const number=(value:unknown)=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0?value:null;
/** Observe usage without changing payloads or retaining prompts / completions. */
export function observeUsage(sse:boolean,onEnd:(usage:{inputTokens:number|null;outputTokens:number|null;failed:boolean})=>void|Promise<void>) {
 const decoder=new StringDecoder('utf8');let buffer='';let oversized=false;let inputTokens:number|null=null;let outputTokens:number|null=null;let failed=false;let terminal=false;let messages=false;let finalMessageUsage=false;let finishing:Promise<void>|undefined;
 const inspect=(raw:string)=>{if(raw==='[DONE]'){if(!messages)terminal=true;return;}try{
  const event=JSON.parse(raw);
  if(event.type==='message_start')messages=true;
  if(event.type==='message_delta'&&number(event.usage?.output_tokens)!==null)finalMessageUsage=true;
  if(event.type==='message_stop')terminal=finalMessageUsage;
  if(event.type==='response.completed'||event.type==='response.incomplete')terminal=true;
  const usage=event.usage??event.response?.usage??event.message?.usage;
  if(event.type==='error'||event.type==='response.failed'||event.error)failed=true;
  if(usage){const input=number(usage.input_tokens??usage.prompt_tokens);inputTokens=input===null?inputTokens:input+(number(usage.cache_creation_input_tokens)??0)+(number(usage.cache_read_input_tokens)??0);outputTokens=number(usage.output_tokens??usage.completion_tokens)??outputTokens;}
 }catch{/* Some SSE frames are control messages, not JSON. */}};
 const consume=(text:string)=>{
  if(!sse){if(!oversized){buffer+=text;if(buffer.length>524288){buffer='';oversized=true;}}return;}
  for(const part of text.split(/(?<=\n)/)) {
   if(!oversized){buffer+=part;if(buffer.length>524288){buffer='';oversized=true;}}
   if(part.endsWith('\n')){if(!oversized&&buffer.startsWith('data:'))inspect(buffer.slice(5).trim());buffer='';oversized=false;}
  }
 };
 const finish=()=>{
  if(finishing)return finishing;
  consume(decoder.end());if(buffer&&!oversized)inspect(sse?buffer.replace(/^data:\s*/,''):buffer);buffer='';
  finishing=Promise.resolve().then(()=>onEnd({inputTokens,outputTokens,failed:failed||(sse&&!terminal)}));return finishing;
 };
 const stream=new Transform({transform(chunk,_encoding,callback){consume(decoder.write(chunk));callback(null,chunk);},flush(callback){void finish().then(()=>callback(),error=>callback(error));}});
 stream.once('close',()=>{void finish().catch(()=>undefined);});return stream;
}
export class GatewayActivity {
 private recent:GatewayCall[]=[];
 private total=0;private failed=0;private measured=0;private input=0;private output=0;
 readonly since=new Date().toISOString();
 record(call:Omit<GatewayCall,'id'>){
  this.total++;if(call.status>=400)this.failed++;
  if(call.inputTokens!==null||call.outputTokens!==null)this.measured++;
  this.input+=call.inputTokens??0;this.output+=call.outputTokens??0;
  this.recent.unshift({...call,id:randomUUID()});this.recent=this.recent.slice(0,100);
 }
 snapshot(){return {since:this.since,total:this.total,failed:this.failed,measured:this.measured,inputTokens:this.input,outputTokens:this.output,recent:structuredClone(this.recent)};}
}
export type GatewayActivitySnapshot=ReturnType<GatewayActivity['snapshot']>;
