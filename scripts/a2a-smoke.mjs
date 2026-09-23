import { _electron as electron } from 'playwright';
import { mkdtemp,mkdir,writeFile,readFile,rm,realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { createServer } from 'node:net';
import assert from 'node:assert/strict';
const root=await mkdtemp(join(await realpath(tmpdir()),'a2a-ui-'));
const allocator=createServer();await new Promise(r=>allocator.listen(0,'127.0.0.1',r));const port=allocator.address().port;await new Promise(r=>allocator.close(r));
let app;const packaged=process.argv.includes('--packaged');let processConflict=false;
try{
 await mkdir(join(root,'cliproxy'));await mkdir(join(root,'claude'));await mkdir(join(root,'codex'));
 await writeFile(join(root,'codex','auth.json'),JSON.stringify({tokens:{access_token:'fixture-access',refresh_token:'fixture-refresh',id_token:'x.e30.x',account_id:'local-fixture'}}));
 const original='{"env":{"KEEP":"original"},"permissions":{"allow":[]}}';await writeFile(join(root,'claude','settings.json'),original);
 await writeFile(join(root,'cliproxy','fixture-accounts.json'),JSON.stringify([{name:'codex.json',provider:'codex',email:'source@example.test',status:'active',models:['gpt-5.6-sol']}]));
 // Test-only process snapshot, injected before app import; never changes real processes.
 const bootstrap=join(root,'bootstrap.cjs');await writeFile(bootstrap,`const cp=require('node:child_process');const original=cp.execFile;cp.execFile=function(file,args,...rest){if(file==='ps'){rest.at(-1)(null,'','');return {on(){},kill(){}};}return original.call(this,file,args,...rest);};cp.execFile[require('node:util').promisify.custom]=async(file,args,options)=>file==='ps'?{stdout:'',stderr:''}:require('node:util').promisify(original)(file,args,options);require('node:module').syncBuiltinESMExports();import(${JSON.stringify(new URL('../dist/main.js',import.meta.url).href)});`);
 app=await electron.launch({args:packaged?[]:[bootstrap],...(packaged?{executablePath:resolve('release/mac-arm64/token-flowb.app/Contents/MacOS/token-flowb')}:{}),env:{...process.env,AGENT_DATA_ROOT:root,CODEX_HOME:join(root,'codex'),CLAUDE_CONFIG_DIR:join(root,'claude'),WORKBUDDY_CONFIG_DIR:join(root,'workbuddy'),AGENT_PORT:'0',AGENT_PROXY_PORT:String(port),CLIPROXY_BINARY:resolve('tests/fixtures/fake-cliproxy.mjs')}});
 const page=await app.firstWindow();const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.locator('.a2aPage').waitFor();await page.locator('.a2aSource').filter({hasText:'本地 Codex 授权'}).waitFor();
 await page.locator('.a2aSource').filter({hasText:'source@example.test'}).click();await page.getByRole('dialog').getByRole('button',{name:'codex/gpt-5.6-sol',exact:true}).click();
 const initial=await page.evaluate(()=>fetch('/api/a2a').then(r=>r.json()));const destination=initial.targets.find(t=>t.id==='claude');processConflict=packaged&&destination.pids.length>0;
 if(processConflict)page.once('dialog',dialog=>dialog.accept());
 await page.getByRole('button',{name:'接入 Claude Code',exact:true}).click();await page.getByText('已接入 Claude Code，请重启后使用新设置。原配置已自动备份。',{exact:true}).waitFor();
 const connectedButton=page.getByRole('button',{name:'已接入',exact:true});assert.equal(await connectedButton.isEnabled(),true);assert.equal(await connectedButton.getAttribute('title'),'🤔 想换模型的话，请先还原接口。');const beforeClick=await readFile(join(root,'claude','settings.json'),'utf8');await connectedButton.click();await page.locator('.banner.notice').filter({hasText:'想换模型的话，请先还原接口'}).waitFor();assert.equal(await readFile(join(root,'claude','settings.json'),'utf8'),beforeClick);
 const changed=JSON.parse(await readFile(join(root,'claude','settings.json'),'utf8'));assert.equal(changed.env.KEEP,'original');assert.match(changed.env.ANTHROPIC_AUTH_TOKEN,/^tfb_/);
 await mkdir('artifacts/a2a',{recursive:true});await page.screenshot({path:'artifacts/a2a/connected.png'});
 await page.getByRole('button',{name:'指定维修师傅',exact:true}).click();await page.locator('.repairChooser .a2aSource').filter({hasText:'source@example.test'}).click();await page.getByRole('dialog').getByRole('button',{name:'codex/gpt-5.6-sol',exact:true}).click();await page.getByText('你的网关维修师傅已就位',{exact:true}).waitFor();await page.getByRole('button',{name:'找师傅帮忙',exact:true}).click();
 await page.getByRole('button',{name:'检查接入',exact:true}).click();await page.getByRole('button',{name:'开始维修',exact:true}).click();await page.waitForFunction(()=>fetch('/api/maintenance').then(r=>r.json()).then(s=>s.status==='completed'));await page.screenshot({path:'artifacts/a2a/maintenance.png'});
 await page.getByRole('navigation',{name:'主导航'}).getByRole('button',{name:'A2A 接入',exact:true}).click();if(!processConflict){await page.getByRole('button',{name:'还原原接口',exact:true}).click();await page.getByText('原接口已还原。',{exact:true}).waitFor();assert.equal(await readFile(join(root,'claude','settings.json'),'utf8'),original);}
 await page.locator('.a2aSource').filter({hasText:'source@example.test'}).click();await page.getByRole('dialog').getByRole('button',{name:'codex/gpt-5.6-sol',exact:true}).click();
 await page.locator('.a2aTargets button').filter({hasText:'WorkBuddy'}).click();
 assert.equal(await page.locator('.a2aTargets button').filter({hasText:'Cursor'}).count(),0);
 assert.equal(await page.locator('.a2aTargets button').filter({hasText:'Qoder IDE'}).isEnabled(),true);
 const workbuddyState=(await page.evaluate(()=>fetch('/api/a2a').then(r=>r.json()))).targets.find(t=>t.id==='workbuddy');
 if(workbuddyState.pids.length)page.once('dialog',dialog=>dialog.accept());
 await page.getByRole('button',{name:'接入 WorkBuddy',exact:true}).click();await page.getByText('已添加 codex/gpt-5.6-sol，重启 WorkBuddy 后在模型菜单选择它。原账号登录和内置模型已保留。',{exact:true}).waitFor();
 const wb=JSON.parse(await readFile(join(root,'workbuddy','models.json'),'utf8'));assert.equal(wb.models[0].id,'codex/gpt-5.6-sol');assert.match(wb.models[0].apiKey,/^tfb_/);
 await app.evaluate(({shell})=>{shell.openExternal=async()=>{};});
 await page.getByRole('button',{name:'登录其他 Agent',exact:true}).click();await page.getByRole('button',{name:'连接 Claude',exact:false}).click();await page.getByRole('button',{name:'取消本次授权',exact:true}).waitFor();
 await fetch(`http://127.0.0.1:${port}/fixture`,{method:'POST',body:JSON.stringify({complete:true})});await page.locator('.a2aPage').waitFor();
 for(const width of [390,768,1320]){await page.setViewportSize({width,height:900});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth||document.querySelector('main').scrollWidth>document.querySelector('main').clientWidth+1),false,`A2A overflow ${width}`);await page.screenshot({path:`artifacts/a2a/interoperability-${width}.png`});}
 assert.deepEqual(errors,[]);console.log(JSON.stringify({a2a:'passed',packaged,configuration:processConflict?'confirmed live-process write, original backed up':'isolated write + restore',maintenance:'selected model + fixture request',widths:[390,768,1320]}));
}catch(error){if(app){console.error(await app.windows()[0].locator('body').innerText());}throw error;}finally{await app?.close();await rm(root,{recursive:true,force:true});}
