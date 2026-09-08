import { defineConfig } from 'vitest/config';
export default defineConfig({test:{fileParallelism:false,include:['tests/**/*.test.ts','packages/contracts/*.test.ts'],testTimeout:30000}});
