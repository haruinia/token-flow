import { setTimeout as delay } from 'node:timers/promises';
import type { QuotaResponse } from './types.js';

export const transientQuotaStatus=(status:number)=>[408,500,502,503,504].includes(status);
/** Only transport failures are retryable; never infer them from provider error text. */
export class QuotaTransportError extends Error {}
export async function retryQuotaCall(call:()=>Promise<QuotaResponse>,signal:AbortSignal,onRetry:(attempt:number)=>void):Promise<QuotaResponse> {
  for(let attempt=1;;attempt++){
    signal.throwIfAborted();
    try{
      const response=await call();
      if(transientQuotaStatus(response.statusCode))throw new QuotaTransportError(`额度上游连接失败（HTTP ${response.statusCode}）。`);
      return response;
    }catch(error){
      signal.throwIfAborted();
      if(!(error instanceof QuotaTransportError))throw error;
      if(attempt===5)throw new Error(`${error.message} 已尝试 5 次，请稍后重试或检查网络与代理。`);
      onRetry(attempt+1);
      await delay(1000*2**(attempt-1),undefined,{signal});
    }
  }
}
