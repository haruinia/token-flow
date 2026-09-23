// Backward-compatible Qoder probe entry point.
process.argv.splice(3,0,'qoder','qoder/kmodel_latest');
await import('./source-live-smoke.js');
