import { app, BrowserWindow, safeStorage, session, dialog, shell } from 'electron';
import { mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDesktopService } from '../../../packages/core/src/service.js';

const here=dirname(fileURLToPath(import.meta.url));
if(process.env.AGENT_DATA_ROOT){const dataRoot=resolve(process.env.AGENT_DATA_ROOT);mkdirSync(dataRoot,{recursive:true,mode:0o700});app.setPath('userData',dataRoot);}
if(!app.requestSingleInstanceLock()) app.quit();
else { void start().catch(error=>{dialog.showErrorBox('Browser Agent 启动失败',error instanceof Error?error.message:String(error));app.exit(1);}); }
async function start() {
  let window:BrowserWindow|undefined;
  let closing=false;
  await app.whenReady();
  const root=process.env.AGENT_DATA_ROOT?resolve(process.env.AGENT_DATA_ROOT):app.getPath('userData');
  await mkdir(join(root,'secrets'),{recursive:true,mode:0o700});
  const secrets={
    get:async(name:string)=>{try{const data=await readFile(join(root,'secrets',`${name}.bin`));return safeStorage.decryptString(data);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return '';throw e;}},
    set:async(name:string,value:string)=>{if(!safeStorage.isEncryptionAvailable()||(process.platform==='linux'&&safeStorage.getSelectedStorageBackend()==='basic_text'))throw new Error('系统安全密钥存储不可用');await writeFile(join(root,'secrets',`${name}.bin`),safeStorage.encryptString(value),{mode:0o600});}
  };
  let localKey=await secrets.get('cliproxy');
  if(!localKey){localKey=randomBytes(32).toString('hex');await secrets.set('cliproxy',localKey);}
  const token=randomBytes(32).toString('hex');
  const base=app.isPackaged?process.resourcesPath:resolve(here,'..');
  const service=await createDesktopService({root,token,localKey,secrets,openExternal:url=>shell.openExternal(url),proxyPort:process.env.AGENT_PROXY_PORT?Number(process.env.AGENT_PROXY_PORT):undefined,binary:process.env.CLIPROXY_BINARY?resolve(process.env.CLIPROXY_BINARY):join(base,'sidecars',`${process.platform}-${process.arch}`,process.platform==='win32'?'cliproxyapi.exe':'cliproxyapi'),uiRoot:join(here,'console')});
  const address=await service.app.listen({host:'127.0.0.1',port:0});
  await session.defaultSession.cookies.set({url:address,name:'agent_session',value:token,httpOnly:true,sameSite:'strict',path:'/'});
  const show=async()=>{
    if(window){window.show();return;}
    window=new BrowserWindow({width:1440,height:940,minWidth:960,minHeight:680,backgroundColor:'#151719',title:'Browser Agent',webPreferences:{preload:join(here,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
    window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
    window.webContents.on('will-navigate',(event,url)=>{if(new URL(url).origin!==address)event.preventDefault();});
    window.webContents.session.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));
    window.on('closed',()=>{window=undefined;});
    await window.loadURL(address);
  };
  app.on('second-instance',()=>{void show();});app.on('activate',()=>{void show();});
  app.on('window-all-closed',()=>app.quit());
  app.on('before-quit',event=>{if(closing)return;event.preventDefault();closing=true;void service.app.close().finally(()=>app.quit());});
  await show();
}
