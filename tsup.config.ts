import { defineConfig } from 'tsup';
export default defineConfig([
 {entry:{main:'apps/desktop/src/main.ts',headless:'packages/core/src/headless.ts','javascript-worker':'packages/core/src/javascript-worker.ts'},format:['esm'],platform:'node',target:'node22',outDir:'dist',clean:false,removeNodeProtocol:false,external:['electron','playwright'],noExternal:['@cua-sample/contracts']},
 {entry:{preload:'apps/desktop/src/preload.ts'},format:['cjs'],platform:'node',outDir:'dist',external:['electron']}
]);
