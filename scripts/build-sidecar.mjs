import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { sidecarOverlay } from './sidecar-overlay.mjs';
import { resolve } from 'node:path';

const goosByPlatform = {darwin: 'darwin', win32: 'windows', linux: 'linux'};
const goarchByArch = {arm64: 'arm64', x64: 'amd64', ia32: '386'};
const spec = process.argv[2] || `${process.platform}-${process.arch}`;
const [platform, arch] = spec.split('-');
const goos = goosByPlatform[platform];
const goarch = goarchByArch[arch];
if (!goos || !goarch) {
  console.error(`未知 sidecar 目标：${spec}`);
  process.exit(1);
}
const target = resolve('sidecars', spec);
mkdirSync(target, {recursive: true});
const env = {...process.env, GOOS: goos, GOARCH: goarch};
if (platform !== process.platform || arch !== process.arch) env.CGO_ENABLED = '0';
const patch=sidecarOverlay();const overlay=patch.overlay;
const result = spawnSync('go', ['build', '-overlay',overlay, '-trimpath', '-o', resolve(target, platform === 'win32' ? 'cliproxyapi.exe' : 'cliproxyapi'), './cmd/server'], {
  cwd: 'upstream/CLIProxyAPI', stdio: 'inherit', env,
});
patch.close();
process.exit(result.status ?? 1);
