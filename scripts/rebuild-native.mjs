// scripts/rebuild-native.mjs
// 原生模块 ABI 一键切换（better-sqlite3 / node-pty）
// ──────────────────────────────────────────────────────────────
// 背景：Electron 原生模块需按运行时编译（NODE_MODULE_VERSION 不匹配会 ERR_DLOPEN_FAILED）
//   - node 目标（vitest / 开发工具链）：`pnpm rebuild better-sqlite3 node-pty`
//   - electron 目标（应用 / E2E）：`pnpm exec electron-rebuild -f -w better-sqlite3 -w node-pty`
// 用法：
//   node scripts/rebuild-native.mjs node       # 切到 Node ABI（跑测试前）
//   node scripts/rebuild-native.mjs electron   # 切到 Electron ABI（pnpm dev 前）
// ──────────────────────────────────────────────────────────────

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const target = process.argv[2];

if (target !== 'node' && target !== 'electron') {
  console.error('用法：node scripts/rebuild-native.mjs <node|electron>');
  process.exit(1);
}

const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

console.log(`[rebuild-native] 目标：${target} ABI`);

// 1. 清理残留 Electron 进程（rebuild 期间 .node 文件被占用会报 EPERM）
if (process.platform === 'win32') {
  spawnSync('taskkill', ['/F', '/IM', 'electron.exe', '/T'], { stdio: 'ignore' });
} else {
  spawnSync('pkill', ['-f', 'electron'], { stdio: 'ignore' });
}
console.log('[rebuild-native] 残留 Electron 进程已清理');

// 2. 重建原生模块
// node：pnpm rebuild（Node ABI）；electron：直接 node 调用 @electron/rebuild CLI（绕开 pnpm/shell 包装）
const electronRebuildCli = join(
  process.cwd(),
  'node_modules',
  '@electron',
  'rebuild',
  'lib',
  'cli.js',
);
const args =
  target === 'node'
    ? ['rebuild', 'better-sqlite3', 'node-pty']
    : [electronRebuildCli, '-f', '-w', 'better-sqlite3', '-w', 'node-pty'];
const result =
  target === 'node'
    ? spawnSync(pnpm, args, { stdio: 'inherit', shell: process.platform === 'win32' })
    : spawnSync(process.execPath, args, { stdio: 'inherit' });
if (result.status !== 0) {
  console.error(`[rebuild-native] rebuild 失败（exit ${result.status ?? 'null'}）`);
  process.exit(result.status ?? 1);
}

// 3. 验证：目标运行时实际加载（require 成功 = ABI 匹配）
if (target === 'node') {
  try {
    require('better-sqlite3');
    console.log('[rebuild-native] ✓ Node ABI 就绪（better-sqlite3 加载成功）');
  } catch (err) {
    console.error('[rebuild-native] ✗ ABI 校验失败：', err instanceof Error ? err.message : err);
    process.exit(1);
  }
} else {
  // electron 目标：用 Electron 二进制加载模块验证（避免偏移探测不可靠）
  const electronBin = require('electron');
  const probe = [
    "const { app } = require('electron');",
    'app.whenReady().then(() => {',
    '  try {',
    "    const db = require('better-sqlite3')(':memory:');",
    "    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');",
    "    console.log('ABI_OK');",
    '  } catch (e) {',
    "    console.log('ABI_FAIL: ' + e.code);",
    '  }',
    '  app.exit(0);',
    '});',
  ].join('\n');
  const probeFile = fileURLToPath(new URL('../.tmp/rebuild-abi-probe.cjs', import.meta.url));
  require('node:fs').writeFileSync(probeFile, probe, 'utf8');
  const verify = spawnSync(electronBin, [probeFile], { encoding: 'utf8', timeout: 30_000 });
  require('node:fs').rmSync(probeFile, { force: true });
  if ((verify.stdout ?? '').includes('ABI_OK')) {
    console.log('[rebuild-native] ✓ Electron ABI 就绪（better-sqlite3 在 Electron 中加载成功）');
  } else {
    console.error(
      '[rebuild-native] ✗ ABI 校验失败：',
      (verify.stdout ?? '').trim() || (verify.stderr ?? '').slice(0, 300),
    );
    process.exit(1);
  }
}
