import { app, BrowserWindow, safeStorage, session, dialog, shell, nativeImage, ipcMain, clipboard } from 'electron';
import { mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSecrets } from './secrets.js';
import { resolveProfile } from './profile.js';
import { createDesktopService } from '../../../packages/core/src/service.js';

const here=dirname(fileURLToPath(import.meta.url));
// Retain the existing profile across the product rename, without copying credentials.
const profile=resolveProfile(app.getPath('appData'),process.env.AGENT_DATA_ROOT);
mkdirSync(profile,{recursive:true,mode:0o700});
app.setPath('userData',profile);
app.setName('token-flow');
if(!app.requestSingleInstanceLock()) app.quit();
else { void start().catch(error=>{dialog.showErrorBox('token-flow 启动失败',error instanceof Error?error.message:String(error));app.exit(1);}); }
async function start() {
  let window:BrowserWindow|undefined;
  let closing=false;
  await app.whenReady();
  const icon=join(here,'console','app-icon.png');
  if(process.platform==='darwin')app.dock?.setIcon(nativeImage.createFromPath(icon));
  const root=process.env.AGENT_DATA_ROOT?resolve(process.env.AGENT_DATA_ROOT):app.getPath('userData');
  await mkdir(join(root,'secrets'),{recursive:true,mode:0o700});
  const secrets=createSecrets(root,safeStorage);
  let localKey=await secrets.get('cliproxy');
  if(!localKey){
    localKey=randomBytes(32).toString('hex');
    if(secrets.canEncrypt())await secrets.set('cliproxy',localKey);
    else secrets.temporaryGateway();
  }
  const token=randomBytes(32).toString('hex');
  const base=app.isPackaged?process.resourcesPath:resolve(here,'..');
  const service=await createDesktopService({root,token,localKey,secrets,credentialWarnings:secrets.warnings,openExternal:url=>shell.openExternal(url),proxyPort:process.env.AGENT_PROXY_PORT?Number(process.env.AGENT_PROXY_PORT):undefined,binary:process.env.CLIPROXY_BINARY?resolve(process.env.CLIPROXY_BINARY):join(base,'sidecars',`${process.platform}-${process.arch}`,process.platform==='win32'?'cliproxyapi.exe':'cliproxyapi'),uiRoot:join(here,'console')});
  const address=await service.app.listen({host:'127.0.0.1',port:Number(process.env.AGENT_PORT??9527)});
  ipcMain.handle('clipboard:write-text',(event,text:unknown)=>{
    if(!window || event.sender!==window.webContents || event.senderFrame!==window.webContents.mainFrame || new URL(event.senderFrame.url).origin!==address)throw new Error('Clipboard request denied');
    if(typeof text!=='string' || text.length>1_000_000)throw new Error('Invalid clipboard text');
    clipboard.writeText(text);
  });
  await session.defaultSession.cookies.set({url:address,name:'agent_session',value:token,httpOnly:true,sameSite:'strict',path:'/'});
  const show=async()=>{
    if(window){if(window.isMinimized())window.restore();window.show();window.focus();return;}
    window=new BrowserWindow({width:1320,height:900,minWidth:900,minHeight:640,show:false,backgroundColor:'#ffffff',title:'token-flow',icon,...(process.platform==='darwin'?{titleBarStyle:'hiddenInset' as const,trafficLightPosition:{x:20,y:20}}:{}),webPreferences:{preload:join(here,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
    window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
    window.webContents.on('will-navigate',(event,url)=>{if(new URL(url).origin!==address)event.preventDefault();});
    window.webContents.session.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));
    window.on('closed',()=>{window=undefined;});
    await window.loadURL(address);
    window.show();
    window.focus();
  };
  app.on('second-instance',()=>{void show();});app.on('activate',()=>{void show();});
  app.on('window-all-closed',()=>app.quit());
  app.on('before-quit',event=>{if(closing)return;event.preventDefault();closing=true;void service.app.close().finally(()=>app.quit());});
  // The workspace opens immediately; saved accounts, namespaced models and quotas load in the background.
  void service.discoverLocal().catch(() => undefined); // Failure is exposed in the model center with a retry action.
  await show();
}
