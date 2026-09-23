import type { LocalModel } from '../../../packages/core/src/cliproxy';

// Names describe the catalog entry; IDs remain unchanged for permissions and routing.
export function modelLabel(models: LocalModel[], id: string) {
 const model=models.find(item=>item.id===id);
 if(model?.provider!=='qoder'||!model.displayName?.trim())return id;
 const name=model.displayName.trim().replace(/\s*\(Qoder\)$/i,'').replace(/\s+/g,'-');
 return `qoder/${name}`;
}
