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
