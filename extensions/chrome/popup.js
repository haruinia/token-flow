const status=document.querySelector('#status');
async function send(message){const result=await chrome.runtime.sendMessage(message);status.textContent=result.error??result.status;document.querySelector('#disconnect').disabled=!result.connected;return result;}
document.querySelector('#connect').addEventListener('submit',async event=>{event.preventDefault();const button=document.querySelector('#submit');button.disabled=true;status.textContent='正在连接…';try{const [tab]=await chrome.tabs.query({active:true,currentWindow:true});const result=await send({action:'connect',connectionURL:document.querySelector('#connection').value.trim(),tabId:tab.id});if(!result.error)document.querySelector('#connection').value='';}catch(error){status.textContent=error.message;}finally{button.disabled=false;}});
document.querySelector('#disconnect').addEventListener('click',()=>send({action:'disconnect'}));
void send({action:'status'});
