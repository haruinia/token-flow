export async function copyText(text:string):Promise<void> {
  const desktop=(window as Window & {desktop?:{copyText?:(text:string)=>Promise<void>}}).desktop;
  if(desktop?.copyText)await desktop.copyText(text);
  else await navigator.clipboard.writeText(text);
}
