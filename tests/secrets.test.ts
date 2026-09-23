import { it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSecrets } from '../apps/desktop/src/secrets.js';
const roots:string[]=[];
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
async function setup(){const root=await mkdtemp(join(tmpdir(),'secrets-test-'));roots.push(root);await mkdir(join(root,'secrets'));return root;}
const storage={isEncryptionAvailable:()=>true,encryptString:(v:string)=>Buffer.from(`encrypted:${v}`),decryptString:(b:Buffer)=>{if(!b.toString().startsWith('encrypted:'))throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.');return b.toString().slice(10);}};
it('preserves unreadable ciphertext and replaces it only after backing it up',async()=>{
 const root=await setup();const file=join(root,'secrets','cliproxy.bin');await writeFile(file,'corrupt');
 const secrets=createSecrets(root,storage);expect(await secrets.get('cliproxy')).toBe('');expect(await readFile(file,'utf8')).toBe('corrupt');
 expect(secrets.warnings().join()).toContain('无法解密');await secrets.set('cliproxy','replacement');
 expect(await secrets.get('cliproxy')).toBe('replacement');
 const backup=(await readdir(join(root,'secrets'))).find(name=>name.startsWith('cliproxy.bin.unreadable-'))!;
 expect(await readFile(join(root,'secrets',backup),'utf8')).toBe('corrupt');
 expect(secrets.warnings().join()).not.toContain('replacement');
});
it('does not overwrite locked-store credentials and lets reads recover once unlocked',async()=>{
 const root=await setup();let available=false;
 await writeFile(join(root,'secrets','custom.bin'),'encrypted:original');
 const secrets=createSecrets(root,{...storage,isEncryptionAvailable:()=>available});
 expect(await secrets.get('custom')).toBe('');await expect(secrets.set('custom','new')).rejects.toThrow('不可用');
 expect(await readFile(join(root,'secrets','custom.bin'),'utf8')).toBe('encrypted:original');
 available=true;expect(await secrets.get('custom')).toBe('original');
});
it('backs up undecryptable API keys before explicit replacement and retains ciphertext if encryption fails',async()=>{
 const root=await setup();const file=join(root,'secrets','openai.bin');await writeFile(file,'broken');
 const failed=createSecrets(root,{...storage,encryptString:()=>{throw new Error('keychain locked');}});
 await expect(failed.set('openai','new')).rejects.toThrow('locked');expect(await readFile(file,'utf8')).toBe('broken');
 const secrets=createSecrets(root,storage);await secrets.set('openai','new');expect(await secrets.get('openai')).toBe('new');
 expect((await readdir(join(root,'secrets'))).some(name=>name.startsWith('openai.bin.unreadable-'))).toBe(true);
 expect(await secrets.get('custom')).toBe('');
});
it('stores independent Cursor SDK credentials in the encrypted credential store',async()=>{
 const root=await setup();const secrets=createSecrets(root,storage);const credential=JSON.stringify({apiKey:'fixture-cursor-key',disabled:false});await secrets.set('cursor-account',credential);expect(await secrets.get('cursor-account')).toBe(credential);expect((await readdir(join(root,'secrets')))).toContain('cursor-account.bin');await secrets.set('cursor-account','');expect(await secrets.get('cursor-account')).toBe('');
});
