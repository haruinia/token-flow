import type { LocalAgentSnapshot } from '../../../packages/core/src/cliproxy';
export function sourceOptions(local:LocalAgentSnapshot){
 return local.accounts.filter(a=>a.provider!=='cursor'&&!a.disabled&&!a.unavailable&&['active','ready','ok'].includes(a.status)&&a.models?.some(id=>local.models.some(m=>m.id===id))).map(account=>{
  const quota=local.quotas[account.id];
  const remaining=quota?.status==='ok'?quota.windows.flatMap(w=>typeof w.usedPercent==='number'&&Number.isFinite(w.usedPercent)?[Math.max(0,Math.min(100,100-w.usedPercent))]:[]):[];
  return {...account,remaining:remaining.length?Math.min(...remaining):null,models:[...new Set(account.models!.filter(id=>local.models.some(m=>m.id===id)))]};
 }).sort((a,b)=>(b.remaining??-1)-(a.remaining??-1)||a.label.localeCompare(b.label));
}
