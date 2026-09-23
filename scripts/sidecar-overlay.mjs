import { mkdtempSync,readFileSync,writeFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
export function sidecarOverlay(test=false){
// Build from maintained patches without rewriting the upstream checkout.
const patchDir=mkdtempSync(join(tmpdir(),'token-flow-sidecar-'));
const source=resolve('upstream/CLIProxyAPI/sdk/api/handlers/handlers.go');
const original=readFileSync(source,'utf8');
const anchor='meta := make(map[string]any)';
if(!original.includes(anchor))throw new Error('Upstream routing hook changed; inspect before building.');
const patched=join(patchDir,'handlers.go');
writeFileSync(patched,original.replace(anchor,anchor+'\n\tif ginCtx != nil {\n\t\tif selected := strings.TrimSpace(ginCtx.GetHeader("X-Token-Flow-Auth")); selected != "" {\n\t\t\tmeta[coreexecutor.PinnedAuthMetadataKey] = selected\n\t\t}\n\t}'));
const replacements={
 [resolve('upstream/CLIProxyAPI/internal/runtime/executor/agent_responses.go')]:resolve('patches/cliproxy/agent_responses.go'),
 [resolve('upstream/CLIProxyAPI/internal/runtime/executor/workbuddy_executor.go')]:resolve('patches/cliproxy/workbuddy_executor.go'),
 [source]:patched,
 [resolve('upstream/CLIProxyAPI/internal/runtime/executor/qoder_executor.go')]:resolve('patches/cliproxy/qoder_executor.go'),
 [resolve('upstream/CLIProxyAPI/internal/runtime/executor/helps/qoder_protocol.go')]:resolve('patches/cliproxy/qoder_protocol.go'),
};
// Test files in a developer's checkout may already exist. Use the same destination
// names so the overlay replaces them rather than registering duplicate tests.
if(test){
 replacements[resolve('upstream/CLIProxyAPI/internal/runtime/executor/workbuddy_wire_test.go')]=resolve('tests/sidecar/workbuddy_wire_test.go');
 replacements[resolve('upstream/CLIProxyAPI/sdk/api/handlers/token_flow_pin_test.go')]=resolve('tests/sidecar-pin.go');
 replacements[resolve('upstream/CLIProxyAPI/internal/runtime/executor/qoder_claude_test.go')]=resolve('tests/sidecar/qoder_claude_test.go');
 replacements[resolve('upstream/CLIProxyAPI/internal/runtime/executor/helps/qoder_protocol_test.go')]=resolve('tests/sidecar/qoder_protocol_test.go');
}
const overlay=join(patchDir,'overlay.json');writeFileSync(overlay,JSON.stringify({Replace:replacements}));
return {overlay,close:()=>rmSync(patchDir,{recursive:true,force:true})};
}
