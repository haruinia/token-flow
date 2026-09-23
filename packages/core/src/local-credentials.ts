import { readFile } from 'node:fs/promises';
import { dirname,join } from 'node:path';
import { z } from 'zod';
import type { AgentPaths } from './agent-connections.js';
const token=z.string().min(1).max(20000);
// Startup discovery and explicit imports read only supported local OAuth files; never return secrets to the renderer.
export async function localCredential(target:'codex'|'claude',paths:AgentPaths):Promise<Record<string,unknown>> {
  const path=join(dirname(paths[target]),target==='codex'?'auth.json':'.credentials.json');
  let value:unknown;try{value=JSON.parse(await readFile(path,'utf8'));}catch{throw new Error('未找到可读取的本地 OAuth 凭据；若保存在系统钥匙串，请通过模型中心重新授权。');}
  if(target==='codex'){
    const {tokens}=z.object({tokens:z.object({access_token:token,refresh_token:token,id_token:token,account_id:z.string().optional()})}).parse(value);
    let claims:Record<string,unknown>={};try{claims=JSON.parse(Buffer.from(tokens.id_token.split('.')[1],'base64url').toString());}catch{/* Unverified claims are display hints only. */}
    return {...tokens,email:typeof claims.email==='string'?claims.email:'本地 Codex 授权',expired:typeof claims.exp==='number'?new Date(claims.exp*1000).toISOString():undefined,last_refresh:new Date().toISOString()};
  }
  const {claudeAiOauth:oauth}=z.object({claudeAiOauth:z.object({accessToken:token,refreshToken:token,expiresAt:z.number().optional()})}).parse(value);
  return {access_token:oauth.accessToken,refresh_token:oauth.refreshToken,expired:oauth.expiresAt?new Date(oauth.expiresAt).toISOString():undefined,email:'本地 Claude Code 授权',last_refresh:new Date().toISOString()};
}
