import { constants } from 'node:fs';
import { copyFile, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

type Storage = {
  decryptString(data:Buffer):string;
  encryptString(value:string):Buffer;
  isEncryptionAvailable():boolean;
  getSelectedStorageBackend?():string;
};
/** Keep unreadable ciphertext for recovery; missing credentials must not prevent the workspace opening. */
export function createSecrets(root:string, storage:Storage, platform=process.platform) {
  const unreadable=new Set<string>();
  const warnings=new Map<string,string>();
  const label=(name:string)=>({cliproxy:'内部网关',openai:'OpenAI',custom:'自定义接口','cursor-account':'Cursor 账号'}[name]??name);
  const path=(name:string)=>{
    if(!['cliproxy','openai','custom','cursor-account'].includes(name))throw new Error('未知密钥类型');
    return join(root,'secrets',`${name}.bin`);
  };
  const canEncrypt=()=>storage.isEncryptionAvailable()&&!(platform==='linux'&&storage.getSelectedStorageBackend?.()==='basic_text');
  return {
    canEncrypt,
    warnings:()=>[...warnings.values()],
    temporaryGateway:()=>warnings.set('cliproxy','系统安全密钥存储不可用，内部网关本次使用临时密钥；重启后会变化。原有登录账号和客户端 Key 不受影响。'),
    async get(name:string) {
      let data:Buffer;
      try {data=await readFile(path(name));}
      catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return '';throw error;}
      if(!canEncrypt()) {
        warnings.set(name,`${label(name)}密钥暂时无法读取，请解锁系统钥匙串后重启应用。原加密文件已保留。`);
        return '';
      }
      try{return storage.decryptString(data);}
      catch {
        unreadable.add(name);
        warnings.set(name,`${label(name)}密钥无法解密，原加密文件已保留。${name==='cliproxy'?'已重新生成内部网关密钥，旧的内部直连客户端需更新密钥；账号登录和受限客户端 Key 不受影响。':'请解锁系统钥匙串后重启，或在「模型中心 → 接口与能力」重新填写 API Key。'}`);
        return '';
      }
    },
    async set(name:string,value:string) {
      if(!canEncrypt())throw new Error('系统安全密钥存储不可用，请解锁系统钥匙串后重试。');
      const file=path(name);
      const encrypted=storage.encryptString(value);
      // Back up even if get() was not called before replacing the credential.
      let existing:Buffer|undefined;
      try{existing=await readFile(file);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
      if(existing&&!unreadable.has(name)){try{storage.decryptString(existing);}catch{unreadable.add(name);}}
      if(existing&&unreadable.has(name))await copyFile(file,`${file}.unreadable-${randomUUID()}`,constants.COPYFILE_EXCL);
      await writeFile(`${file}.tmp`,encrypted,{mode:0o600});
      await rename(`${file}.tmp`,file);
      unreadable.delete(name);
      if(name!=='cliproxy')warnings.delete(name);
    },
  };
}
