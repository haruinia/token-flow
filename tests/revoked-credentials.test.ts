import {expect,it} from 'vitest';
import {revokedCredential} from '../packages/core/src/cliproxy.js';
it('cleans only terminal OAuth refresh failures, not duplicate labels, quota errors or network failures',()=>{
 for(const code of ['invalid_grant','refresh_token_revoked','refresh_token_reused','refresh_token_expired'])expect(revokedCredential({status:'error',status_message:`OAuth refresh failed: ${code}`})).toBe(true);
 for(const message of ['HTTP 401','HTTP 403','HTTP 502','quota exceeded','duplicate account','connection refused','token expired'])expect(revokedCredential({status:'error',status_message:message})).toBe(false);
 expect(revokedCredential({status:'active',status_message:'invalid_grant'})).toBe(false);
});
