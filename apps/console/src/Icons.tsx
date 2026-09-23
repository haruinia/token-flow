// Reused from the user's youzhao desktop app.
import type { CSSProperties, ReactNode } from 'react';

export type IconName='workspace'|'model'|'plug'|'history'|'browser'|'arrow'|'plus'|'briefcase'|'resume'|'shield'|'chevron'|'send'|'sliders'|'message'|'menu'|'close';
const paths:Record<IconName,ReactNode>={
  workspace:<><rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/></>,
  model:<><rect x="6" y="6" width="12" height="12" rx="3"/><path d="M9 2v4m6-4v4M9 18v4m6-4v4M2 9h4m-4 6h4m12-6h4m-4 6h4"/><path d="m9 14 3-5 3 5m-5-1h4"/></>,
  plug:<><path d="M9 3v5m6-5v5M7 8h10v3a5 5 0 0 1-10 0V8Zm5 8v5"/></>,
  history:<><path d="M3 11a9 9 0 1 1 2 7M3 4v7h7m2-4v5l3 2"/></>,
  browser:<><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M3 9h18M7 6.5h.01m3 0h.01"/></>,
  arrow:<path d="M5 12h14m-6-6 6 6-6 6"/>,
  plus:<path d="M12 5v14M5 12h14"/>,
  briefcase:<><rect x="3" y="7" width="18" height="14" rx="3"/><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M3 12a22 22 0 0 0 18 0M12 12v4"/></>,
  resume:<><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-6-6Zm0 0v6h6"/><circle cx="10" cy="12" r="2"/><path d="M7 18c0-4 6-4 6 0m3-5h1m-1 4h1"/></>,
  shield:<><path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z"/><path d="m8 12 3 3 5-6"/></>,
  chevron:<path d="m9 5 7 7-7 7"/>,
  send:<path d="M12 19V5m-6 6 6-6 6 6"/>,
  sliders:<><path d="M4 7h7m4 0h5M4 17h3m4 0h9"/><circle cx="13" cy="7" r="2"/><circle cx="9" cy="17" r="2"/></>,
  message:<path d="M21 11a8 8 0 0 1-8 8H8l-5 3V6a3 3 0 0 1 3-3h7a8 8 0 0 1 8 8Z"/>,
  menu:<path d="M4 6h16M4 12h16M4 18h16"/>,
  close:<path d="M18 6 6 18M6 6l12 12"/>,
};
export function Icon({name,size=18,style}: {name:IconName;size?:number;style?:CSSProperties}) {
  return <svg className="uiIcon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={style}>{paths[name]}</svg>;
}
