// CDP session mapping follows Microsoft Playwright 1.63's BrowserModel/CDPRelay.
// Adapted for a single explicitly selected tab; see THIRD_PARTY.md (Apache-2.0).
import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';

const secret = () => randomBytes(32).toString('hex');
const equal = (a:string,b:string) => a.length===b.length && timingSafeEqual(Buffer.from(a),Buffer.from(b));
type Target = {browserContextId:string;targetId:string;type:string;title:string;url:string};
type Pending = {resolve:(value:unknown)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>};
export class ExtensionRelay {
  private server = createServer((_req,res)=>{res.writeHead(404);res.end();});
  private sockets = new WebSocketServer({noServer:true,maxPayload:16*1024*1024});
  private extension?:WebSocket;
  private client?:WebSocket;
  private target?:Target;
  private pairingToken='';
  private expires=0;
  private cdpToken=secret();
  private port=0;
  private sequence=0;
  private pending=new Map<number,Pending>();
  private children=new Set<string>();
  private attached=false;
  private generation=0;
  constructor() {
    this.server.on('upgrade',(req,socket,head)=>{
      const url=new URL(req.url??'/', 'http://127.0.0.1');
      const token=url.searchParams.get('token')??'';
      const origin=req.headers.origin;
      const extension=url.pathname==='/extension';
      const valid=extension
        ? !!this.pairingToken && Date.now()<this.expires && !this.extension && equal(token,this.pairingToken) && /^chrome-extension:\/\/[a-p]{32}$/.test(origin??'')
        : url.pathname==='/cdp' && !!this.target && !this.client && !origin && equal(token,this.cdpToken);
      if(req.headers.host!==`127.0.0.1:${this.port}` || !valid){socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');socket.destroy();return;}
      this.sockets.handleUpgrade(req,socket,head,ws=>extension?this.acceptExtension(ws):this.acceptClient(ws));
    });
  }
  async pair() {
    if(!this.port){await new Promise<void>((resolve,reject)=>{this.server.once('error',reject);this.server.listen(0,'127.0.0.1',resolve);});this.port=(this.server.address() as {port:number}).port;}
    this.disconnect();this.pairingToken=secret();this.expires=Date.now()+5*60_000;
    return {connectionURL:`ws://127.0.0.1:${this.port}/extension?token=${this.pairingToken}`,expiresAt:new Date(this.expires).toISOString()};
  }
  state(){return {running:!!this.target,profile:'chrome-extension',tabs:this.target?[{index:0,url:this.target.url,title:this.target.title}]:[]};}
  endpoint(){if(!this.target)throw new Error('请先在 Chrome 扩展中连接当前标签页。');return `ws://127.0.0.1:${this.port}/cdp?token=${this.cdpToken}`;}
  private acceptExtension(ws:WebSocket){
    this.extension=ws;this.pairingToken='';
    const timer=setTimeout(()=>{if(!this.target)ws.close(1008,'Handshake timeout');},10000);
    ws.on('error',()=>{});
    ws.on('message',data=>{
      if(this.extension!==ws)return;
      try{
        const message=JSON.parse(data.toString());
        if(message.type==='hello'){
          if(this.target || !message.target || typeof message.target.targetId!=='string' || message.target.type!=='page' || !/^https?:\/\//.test(message.target.url))throw new Error('Invalid target');
          this.target={browserContextId:'selected-context',targetId:message.target.targetId,type:'page',url:String(message.target.url),title:String(message.target.title??'')};clearTimeout(timer);return;
        }
        if(message.type==='ping'){ws.send('{"type":"pong"}');return;}
        if(message.type==='tab'){if(this.target && typeof message.url==='string' && typeof message.title==='string'){this.target.url=message.url;this.target.title=message.title;}return;}
        if(message.id){const pending=this.pending.get(message.id);if(!pending)return;this.pending.delete(message.id);clearTimeout(pending.timer);message.error?pending.reject(new Error(String(message.error))):pending.resolve(message.result??{});return;}
        if(message.type==='event' && this.attached && typeof message.method==='string'){
          if(message.method==='Target.attachedToTarget' && typeof message.params?.sessionId==='string')this.children.add(message.params.sessionId);
          if(message.method==='Target.detachedFromTarget')this.children.delete(message.params?.sessionId);
          this.send({method:message.method,params:message.params??{},sessionId:message.sessionId??'selected-tab'});
        }
      }catch{ws.close(1008,'Invalid bridge message');}
    });
    ws.on('close',()=>{clearTimeout(timer);if(this.extension===ws)this.disconnect();});
  }
  private acceptClient(ws:WebSocket){
    this.client=ws;this.attached=false;this.children.clear();const generation=++this.generation;
    ws.on('error',()=>{});
    ws.on('message',async data=>{
      let message:{id:number;method:string;params?:Record<string,unknown>;sessionId?:string};
      try{message=JSON.parse(data.toString());if(!Number.isInteger(message.id)||typeof message.method!=='string')throw new Error();}catch{ws.close(1008,'Invalid CDP message');return;}
      try{const result=await this.command(message.method,message.params??{},message.sessionId);if(this.generation===generation)this.send({id:message.id,sessionId:message.sessionId,result});}
      catch(error){if(this.generation===generation)this.send({id:message.id,sessionId:message.sessionId,error:{message:error instanceof Error?error.message:'Bridge command failed'}});}
    });
    ws.on('close',()=>{if(this.client===ws){this.client=undefined;this.attached=false;this.children.clear();this.generation++;this.rejectPending();}});
  }
  private send(message:unknown){if(this.client?.readyState===WebSocket.OPEN)this.client.send(JSON.stringify(message));}
  private async command(method:string,params:Record<string,unknown>,sessionId?:string):Promise<unknown>{
    if(!this.target)throw new Error('Chrome 标签页已断开');
    // Browser-wide mutation/enumeration is deliberately not forwarded to the user's profile.
    if(!sessionId){
      if(method==='Browser.getVersion')return {protocolVersion:'1.3',product:'Chrome/Extension-Bridge',userAgent:'BrowserAgent/1.0',revision:'1',jsVersion:'1'};
      if(method==='Browser.setDownloadBehavior')return {};
      if(method==='Target.getTargetInfo')return {targetInfo:this.target};
      if(method==='Target.setAutoAttach'){
        if(params.autoAttach && !this.attached){this.attached=true;this.send({method:'Target.attachedToTarget',params:{sessionId:'selected-tab',targetInfo:{...this.target,attached:true},waitingForDebugger:false}});}return {};
      }
      throw new Error('扩展模式仅支持已连接标签页，不支持浏览器全局操作或创建/关闭标签页。');
    }
    if(sessionId!=='selected-tab'&&!this.children.has(sessionId))throw new Error('Unknown selected-tab session');
    if(method==='Page.close' || (method.startsWith('Target.') && !['Target.setAutoAttach','Target.getTargetInfo','Target.detachFromTarget'].includes(method)) || /^(Browser|Storage)\./.test(method) || /^(Network\.(getAllCookies|setCookies|clearBrowserCookies|clearBrowserCache)|Target\.(createTarget|closeTarget|attachToTarget|getTargets))$/.test(method))throw new Error('浏览器全局操作不在当前标签页连接范围内。');
    return this.request({method,params,...(sessionId==='selected-tab'?{}:{sessionId})});
  }
  private request(command:unknown){
    if(this.extension?.readyState!==WebSocket.OPEN)return Promise.reject(new Error('Chrome 扩展已断开'));
    const id=++this.sequence;
    return new Promise<unknown>((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error('Chrome 扩展指令超时'));},30000);this.pending.set(id,{resolve,reject,timer});this.extension!.send(JSON.stringify({id,type:'command',...command as object}));});
  }
  private rejectPending(){for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new Error('Chrome 连接已断开'));}this.pending.clear();}
  disconnect(){this.pairingToken='';this.expires=0;this.cdpToken=secret();this.target=undefined;this.attached=false;this.children.clear();this.generation++;const extension=this.extension;this.extension=undefined;const client=this.client;this.client=undefined;extension?.close(1000,'Disconnected');client?.close(1000,'Disconnected');this.rejectPending();}
  async close(){this.disconnect();for(const ws of this.sockets.clients)ws.terminate();this.sockets.close();if(this.port)await new Promise<void>(resolve=>this.server.close(()=>resolve()));this.port=0;}
}
