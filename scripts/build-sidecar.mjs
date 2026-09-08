import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
const target = resolve('sidecars', `${process.platform}-${process.arch}`);
mkdirSync(target, {recursive:true});
const result = spawnSync('go',['build','-trimpath','-o',resolve(target,process.platform === 'win32' ? 'cliproxyapi.exe' : 'cliproxyapi'),'./cmd/server'],{cwd:'upstream/CLIProxyAPI',stdio:'inherit'});
process.exit(result.status ?? 1);
