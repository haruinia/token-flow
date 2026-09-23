import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

// Dev and packaged builds must choose the same directory and single-instance lock.
export function resolveProfile(appData: string, override?: string) {
 if(override)return resolve(override);
 const candidates=['token-flowb','desktop-browser-agent','Browser Agent'].map(name=>join(appData,name));
 return candidates.find(path=>existsSync(join(path,'cliproxy','auth')))
   ?? candidates.find(path=>existsSync(path)) ?? candidates[0];
}
