import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, type BrowserContext } from 'playwright';

export function safeEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(['PATH','HOME','USERPROFILE','SYSTEMROOT','WINDIR','TEMP','TMP','TMPDIR','LANG','DISPLAY','XAUTHORITY'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
}
export class BrowserHost {
  context?: BrowserContext;
  endpoint?: string;
  private opening?: Promise<string>;
  constructor(readonly root:string, readonly headless = false) {}
  async open(): Promise<string> {
    if(this.context && this.endpoint) return this.endpoint;
    if(this.opening) return this.opening;
    this.opening = this.launch();
    try {return await this.opening;} finally {this.opening=undefined;}
  }
  private async launch() {
    const profile = join(this.root,'browser','profiles','default');
    await mkdir(profile,{recursive:true,mode:0o700});
    const context = await chromium.launchPersistentContext(profile,{
      channel:"chromium",headless:this.headless,viewport:null,args:['--remote-debugging-port=0','--remote-debugging-address=127.0.0.1'],
      env:safeEnvironment(),timeout:30000,handleSIGINT:false,handleSIGTERM:false,handleSIGHUP:false,
    });
    try {
      const port = (await readFile(join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0];
      if(!/^\d+$/.test(port)) throw new Error('无法读取浏览器调试端口');
      this.context=context; this.endpoint=`http://127.0.0.1:${port}`;
      context.on('close',()=>{this.context=undefined;this.endpoint=undefined;});
      if(!context.pages().length) await context.newPage();
      return this.endpoint;
    } catch(e) {await context.close(); throw e;}
  }
  async close() {await this.opening?.catch(()=>undefined); await this.context?.close();}
  async state() {return {running:!!this.context,profile:'default',tabs:await Promise.all((this.context?.pages()??[]).map(async(page,index)=>({index,url:page.url(),title:await page.title().catch(()=>'' )})))};}
}
