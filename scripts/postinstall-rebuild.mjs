// scripts/postinstall-rebuild.mjs
// postinstall：自动重编译原生模块（better-sqlite3/node-pty）为当前 Electron ABI——
// 按 Node ABI 编译与 Electron 运行时不一致会 NODE_MODULE_VERSION 崩溃，此前每次
// Electron 升级都要手动 electron-rebuild；失败仅告警不阻断 install（工具链缺失属
// 环境问题），跳过：SKIP_ELECTRON_REBUILD=1
// ⚠️ 直调 @electron/rebuild CLI（node + cli.js）而非 pnpm exec：后者经 pnpm.cmd
// shell 包装在部分环境 spawnSync 必败，直调实测可成功

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

if (process.env['SKIP_ELECTRON_REBUILD'] === '1') {
  console.log('[postinstall] SKIP_ELECTRON_REBUILD=1，跳过原生模块重编译');
  process.exit(0);
}

console.log('[postinstall] 重编译原生模块为 Electron ABI（better-sqlite3, node-pty）...');
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
