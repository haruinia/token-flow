let socket, selectedTab, heartbeat;
let status = '未连接';
let connecting = false;
const sessions = new Set();
async function disconnect() {
  const tabId=selectedTab, ws=socket;
  selectedTab=undefined;socket=undefined;clearInterval(heartbeat);sessions.clear();status='未连接';
  ws?.close();
  if(tabId!==undefined)await chrome.debugger.detach({tabId}).catch(()=>{});
  await chrome.action.setBadgeText({text:''});
}
async function connect(connectionURL, tabId) {
  if(connecting)throw new Error('正在连接，请稍后');
  connecting=true;
  try {
    const url=new URL(connectionURL);
    if(url.protocol!=='ws:'||url.hostname!=='127.0.0.1'||!url.port||url.pathname!=='/extension'||url.username||url.password||url.hash||!/^\d+$/.test(url.port)||!/^[a-f0-9]{64}$/.test(url.searchParams.get('token')??''))throw new Error('请粘贴桌面端生成的本机连接码');
    const tab=await chrome.tabs.get(tabId);
    if(!/^https?:\/\//.test(tab.url??''))throw new Error('请切换到普通网站标签页，Chrome 内部页无法连接');
    await disconnect();status='正在连接';
    await chrome.debugger.attach({tabId},'1.3');selectedTab=tabId;
    const {targetInfo}=await chrome.debugger.sendCommand({tabId},'Target.getTargetInfo');
    const ws=new WebSocket(url.href);socket=ws;
    await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('连接超时，请重新生成连接码')),10000);ws.onopen=()=>{clearTimeout(timer);resolve();};ws.onerror=()=>{clearTimeout(timer);reject(new Error('无法连接桌面端，请检查应用和连接码'));};ws.onclose=()=>{clearTimeout(timer);reject(new Error('连接被拒绝，请重新生成连接码'));};});
    ws.onclose=()=>{if(socket===ws)void disconnect();};
    ws.onerror=()=>{};
    ws.onmessage=async event=>{
      if(socket!==ws)return;
      let command;try{command=JSON.parse(event.data);}catch{await disconnect();return;}
      if(command.type!=='command')return;
      try {
        if(typeof command.method!=='string'||(command.sessionId&&!sessions.has(command.sessionId)))throw new Error('无效指令会话');
        const target={tabId,...(command.sessionId?{sessionId:command.sessionId}:{})};
        // Reconnecting Playwright needs fresh executionContextCreated events.
        if(command.method==='Runtime.enable')await chrome.debugger.sendCommand(target,'Runtime.disable');
        const result=await chrome.debugger.sendCommand(target,command.method,command.params??{});
        if(socket===ws&&ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify({id:command.id,result}));
      }catch(error){if(socket===ws&&ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify({id:command.id,error:error.message}));}
    };
    ws.send(JSON.stringify({type:'hello',target:targetInfo}));
    heartbeat=setInterval(()=>{if(ws.readyState===WebSocket.OPEN)ws.send('{"type":"ping"}');},20000);
    status='已连接：'+(tab.title??tab.url);await chrome.action.setBadgeText({text:'ON'});await chrome.action.setBadgeBackgroundColor({color:'#438b73'});
  }catch(error){await disconnect();status=error.message;throw error;}finally{connecting=false;}
}
chrome.runtime.onMessage.addListener((message,sender,reply)=>{
  if(sender.id!==chrome.runtime.id)return;
  (async()=>{
    if(message.action==='connect')await connect(message.connectionURL,message.tabId);
    else if(message.action==='disconnect')await disconnect();
    return {status,connected:selectedTab!==undefined};
  })().then(reply,error=>reply({error:error.message,status,connected:false}));return true;
});
chrome.debugger.onEvent.addListener((source,method,params)=>{
  if(source.tabId!==selectedTab||socket?.readyState!==WebSocket.OPEN)return;
  if(method==='Target.attachedToTarget')sessions.add(params.sessionId);
  if(method==='Target.detachedFromTarget')sessions.delete(params.sessionId);
  socket.send(JSON.stringify({type:'event',method,params,sessionId:source.sessionId}));
});
chrome.debugger.onDetach.addListener(source=>{if(source.tabId===selectedTab)void disconnect();});
chrome.tabs.onRemoved.addListener(tabId=>{if(tabId===selectedTab)void disconnect();});
chrome.tabs.onUpdated.addListener((tabId,change,tab)=>{if(tabId===selectedTab&&socket?.readyState===WebSocket.OPEN)socket.send(JSON.stringify({type:'tab',title:tab.title??'',url:tab.url??''}));});
