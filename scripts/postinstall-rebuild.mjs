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
//
// 失败策略：重编译失败仅告警不阻断 install（本机工具链缺失等环境问题不应让
// pnpm install/add 整体失败；dev/test 脚本会按需重新编译，或手动运行）：
//   pnpm rebuild:native:electron（Electron ABI）/ pnpm rebuild:native:node（Node ABI）
// ──────────────────────────────────────────────────────────────

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

if (process.env['SKIP_ELECTRON_REBUILD'] === '1') {
  console.log('[postinstall] SKIP_ELECTRON_REBUILD=1，跳过原生模块重编译');
  process.exit(0);
}

console.log('[postinstall] 重编译原生模块为 Electron ABI（better-sqlite3, node-pty）...');
// 直接 node 调用 @electron/rebuild CLI（与 rebuild-native.mjs 同源路径）：
// 此前经 pnpm exec + shell 包装在部分环境必败（spawnSync pnpm.cmd 链路脆弱），
// 直调实测可成功。
const electronRebuildCli = join(
  process.cwd(),
  'node_modules',
  '@electron',
  'rebuild',
  'lib',
  'cli.js',
);
const result = spawnSync(
  process.execPath,
  [electronRebuildCli, '-f', '-w', 'better-sqlite3', '-w', 'node-pty'],
  { stdio: 'inherit' },
);

if (result.status !== 0) {
  console.warn(
    '[postinstall] ⚠️ electron-rebuild 失败（不阻断 install）：本机工具链可能缺失。' +
      '需要原生模块时手动重编：pnpm rebuild:native:electron（或设 SKIP_ELECTRON_REBUILD=1 静默跳过）',
  );
  process.exit(0);
}
console.log('[postinstall] 原生模块重编译完成');
