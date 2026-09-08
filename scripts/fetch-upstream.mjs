import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
const sources=[['openai-cua-sample-app','https://github.com/openai/openai-cua-sample-app.git','f2a3dc523ae406f9b704f9a420a05402a63b4522'],['CLIProxyAPI','https://github.com/router-for-me/CLIProxyAPI.git','d198db54d4c4886c99b21488d54fc576933019a3']];
mkdirSync('upstream',{recursive:true});
for(const [name,url,revision] of sources){
 const path=`upstream/${name}`;
 const run=(args,cwd)=>{const r=spawnSync('git',args,{cwd,stdio:'inherit'});if(r.status!==0)process.exit(r.status??1);};
 if(!existsSync(path)){run(['clone','--no-checkout',url,path]);run(['checkout','--detach',revision],path);}
 const actual=spawnSync('git',['rev-parse','HEAD'],{cwd:path,encoding:'utf8'});
 if(actual.stdout.trim()!==revision)throw new Error(`${name}: expected ${revision}; preserve existing checkout and inspect manually.`);
 console.log(`${name} ${revision}`);
}
