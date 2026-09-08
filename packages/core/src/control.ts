import { randomUUID } from 'node:crypto';
export type ControlState = 'idle'|'agent_control'|'pausing'|'human_control'|'resync';
export class RunControl {
  state:ControlState='idle';
  pending?: {id:string;kind:'human';message:string};
  private paused=false;
  private waiter?: {resolve:()=>void;reject:(e:Error)=>void};
  private signal?:AbortSignal;
  bind(signal:AbortSignal) {this.signal=signal; this.state='agent_control'; this.paused=false;}
  pause() {if(this.state==='agent_control') {this.paused=true;this.state='pausing';}}
  async checkpoint() {
    this.signal?.throwIfAborted();
    if(this.paused) {await this.wait('human','您已接管浏览器。操作完成后继续。'); this.paused=false;}
    this.signal?.throwIfAborted();
  }
  async human(message:string) {await this.wait('human',message);}
  private async wait(kind:'human',message:string) {
    this.signal?.throwIfAborted();
    if(this.waiter) throw new Error('已有待处理的人工操作');
    this.pending={id:randomUUID(),kind,message};
    this.state='human_control';
    const onAbort=()=>this.waiter?.reject(new Error('Run aborted.'));
    try {
      await new Promise<void>((resolve,reject)=>{this.waiter={resolve,reject};this.signal?.addEventListener('abort',onAbort,{once:true});});
      this.signal?.throwIfAborted();
      this.state='resync';
    } finally {this.signal?.removeEventListener('abort',onAbort);this.waiter=undefined;this.pending=undefined;}
  }
  resume(id:string) {
    if(!this.pending || this.pending.id!==id || !this.waiter) throw new Error('确认已过期，请刷新当前任务');
    this.waiter.resolve();
  }
  running(){this.state='agent_control';}
  reset(){this.state='idle';this.pending=undefined;this.paused=false;}
  snapshot(){return {state:this.state,pending:this.pending};}
}
