/** One request may contain a summary followed by inference. Activity at the
 * upstream boundary keeps both buffered and streamed calls alive. */
export function upstreamIdle(milliseconds=120_000) {
 const controller=new AbortController();
 let timer:ReturnType<typeof setTimeout>|undefined;
 const close=()=>clearTimeout(timer);
 const touch=()=>{
  close();
  if(!controller.signal.aborted)timer=setTimeout(()=>controller.abort(new Error('Upstream idle timeout')),milliseconds);
 };
 controller.signal.addEventListener('abort',close,{once:true});
 touch();
 return {
  signal:controller.signal,
  abort:()=>controller.abort(),
  close,
  watch(response:Response) {
   touch();
   if(!response.body)return response;
   const body=response.body.pipeThrough(new TransformStream<Uint8Array,Uint8Array>({
    transform(chunk,output){touch();output.enqueue(chunk);}
   }),{signal:controller.signal});
   return new Response(body,{status:response.status,statusText:response.statusText,headers:response.headers});
  }
 };
}
