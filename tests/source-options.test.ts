import { expect,it } from 'vitest';
import { sourceOptions } from '../apps/console/src/source-options';
import type { LocalAgentSnapshot } from '../packages/core/src/cliproxy';
it('shows only usable credentials, ranks by lowest remaining window, leaves unknown quota last',()=>{
 const accounts=['high','low','unknown','disabled','invalid'].map(id=>({id,provider:'codex',label:id,status:'active',disabled:id==='disabled',unavailable:id==='invalid',models:['codex/model','codex/model']}));
 const local={accounts,models:[{id:'codex/model',provider:'codex'}],quotas:{high:{status:'ok',windows:[{usedPercent:10},{usedPercent:25}]},low:{status:'ok',windows:[{usedPercent:95}]}}} as unknown as LocalAgentSnapshot;
 expect(sourceOptions(local)[0].models).toEqual(['codex/model']);
 expect(sourceOptions(local).map(a=>[a.id,a.remaining])).toEqual([['high',75],['low',5],['unknown',null]]);
});
