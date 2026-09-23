export function QuotaRing({remaining,label,compact=false}:{remaining:number|null;label:string;compact?:boolean}) {
 const value=remaining===null||!Number.isFinite(remaining)?null:Math.max(0,Math.min(100,remaining));
 return <span className={`quotaRing ${compact?'compact ':''}${value===null?'unknown':value<=10?'low':value<=25?'medium':''}`} role="img" aria-label={`${label} · ${value===null?'额度未知':`剩余 ${Math.round(value)}%`}`}>
  <svg viewBox="0 0 64 64" aria-hidden="true"><circle className="quotaRingTrack" cx="32" cy="32" r="27"/><circle className="quotaRingValue" cx="32" cy="32" r="27" pathLength="100" strokeDasharray={`${value??0} 100`} opacity={value===0||value===null?0:1}/></svg>
  <span aria-hidden="true">{value===null?'—':<>{Math.round(value)}<small>%</small></>}</span>
 </span>;
}
