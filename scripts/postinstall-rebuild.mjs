// scripts/postinstall-rebuild.mjs
// postinstall：自动重编译原生模块为当前 Electron ABI
// ──────────────────────────────────────────────────────────────
// 设计动机（可维护性）：
// - better-sqlite3 / node-pty 是原生模块，安装时默认按 Node ABI 编译，
//   与 Electron 运行时 ABI 不一致会导致 "NODE_MODULE_VERSION" 启动崩溃。
// - 此前每次 Electron 升级需手动 electron-rebuild（已多次踩坑）。
// - 本脚本在 pnpm install 后自动重编译，消除手动步骤。
//
// 跳过方式（CI / 无需原生模块的场景）：
//   设置环境变量 SKIP_ELECTRON_REBUILD=1
// ──────────────────────────────────────────────────────────────

import { spawnSync } from 'node:child_process';

if (process.env['SKIP_ELECTRON_REBUILD'] === '1') {
  console.log('[postinstall] SKIP_ELECTRON_REBUILD=1，跳过原生模块重编译');
  process.exit(0);
}

console.log('[postinstall] 重编译原生模块为 Electron ABI（better-sqlite3, node-pty）...');
const result = spawnSync(
  process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
  ['exec', 'electron-rebuild', '-f', '-w', 'better-sqlite3', '-w', 'node-pty'],
  { stdio: 'inherit' },
);

if (result.status !== 0) {
  console.error('[postinstall] electron-rebuild 失败（可设 SKIP_ELECTRON_REBUILD=1 跳过）');
  process.exit(result.status ?? 1);
}
console.log('[postinstall] 原生模块重编译完成');
