import { QuotaRing } from './QuotaRing';
import type { AccountQuota } from '../../../packages/core/src/quota/types';

const formatAmount = (value: number, unit?: string) => unit === 'USD' ? `$${value.toFixed(2)}` : `${Math.round(value).toLocaleString()}${unit ?? ''}`;
const resetLabel = (iso: string) => {
  const ms = Date.parse(iso) - Date.now();
  if (Number.isNaN(ms)) return '';
  if (ms <= 0) return '已重置';
  const minutes = Math.round(ms / 60000);
  const span = minutes < 60 ? `${minutes} 分钟` : minutes < 60 * 48 ? `${Math.round(minutes / 60)} 小时` : `${Math.round(minutes / 1440)} 天`;
  return `${span}后重置（${new Date(iso).toLocaleString()}）`;
};

export function QuotaDetails({quota,label,compact=false}:{quota:AccountQuota;label:string;compact?:boolean}) {
 return <span className={`quota ${quota.status}${compact?' compactQuota':''}`} aria-label={`${label} 额度`}>
  {quota.status==='error'&&<span className="hint" role="status">额度查询失败：{quota.error}</span>}
  {quota.status==='error'&&quota.lastSuccessfulAt&&<span className="hint">以下为 {new Date(quota.lastSuccessfulAt).toLocaleString()} 的上次成功结果，仅供参考，不是当前额度。</span>}
  {quota.status==='ok'&&!quota.windows.length&&!quota.note&&<span className="hint">额度暂未提供</span>}
  {quota.windows.map(window=><span className="quotaWindow quotaWindowRing" key={window.id}>
   <QuotaRing compact={compact} remaining={window.usedPercent===null?null:100-window.usedPercent} label={window.label}/>
   <span className="quotaWindowDetails"><span className="quotaMeta"><span>{window.label}</span></span>
    <b>{window.usedPercent===null?'额度暂未提供':`剩余 ${Math.round(Math.max(0,Math.min(100,100-window.usedPercent)))}%`}{window.note?` · ${window.note}`:''}</b>
    <small>{window.used!==undefined&&window.limit!==undefined?`已用 ${formatAmount(window.used,window.unit)} / ${formatAmount(window.limit,window.unit)}`:window.used!==undefined?`已用 ${formatAmount(window.used,window.unit)}`:''}{window.resetsAt?`${window.used!==undefined?' · ':''}${resetLabel(window.resetsAt)}`:''}</small>
   </span>
  </span>)}
  {quota.note&&<span className="hint">{quota.note}</span>}
  <small className="quotaObserved">查询于 {new Date(quota.observedAt).toLocaleTimeString()}</small>
 </span>;
}
