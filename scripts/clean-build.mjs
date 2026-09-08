import { rm } from 'node:fs/promises';
// Only generated build output belonging to this project.
await rm(new URL('../dist/',import.meta.url),{recursive:true,force:true});
