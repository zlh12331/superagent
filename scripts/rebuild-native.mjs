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
const autoMode = process.argv.includes('--auto');

if (target !== 'node' && target !== 'electron') {
  console.error('用法：node scripts/rebuild-native.mjs <node|electron> [--auto]');
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

// 1.5 auto 模式：检测当前 ABI 是否已匹配目标（匹配则跳过 rebuild，秒级返回）
if (autoMode && target === 'node') {
  // 关键：better-sqlite3 的 .node 是懒加载（db() 实例化时才加载）——
  // 仅 require 包入口会骗过检测，必须实例化才能真正校验 ABI
  // 同时测 node-pty（严格 ABI 模块）；解析基准与 vitest 一致（src/main 向上）
  const srcRequire = createRequire(join(process.cwd(), 'src/main/infra/ai/cron-service.ts'));
  try {
    const Database = srcRequire('better-sqlite3');
    const conn = new Database(':memory:');
    conn.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');
    conn.close();
    srcRequire('node-pty');
    console.log('[rebuild-native] ✓ Node ABI 已就绪（--auto 跳过）');
    process.exit(0);
  } catch {
    console.log('[rebuild-native] Node ABI 不匹配，执行 rebuild');
  }
}
if (autoMode && target === 'electron') {
  const electronBin = require('electron');
  const probeFile = fileURLToPath(new URL('../.tmp/abi-check.cjs', import.meta.url));
  const probe = [
    "const { app } = require('electron');",
    'app.whenReady().then(() => {',
    '  try {',
    "    const db = require('better-sqlite3')(':memory:');",
    "    const pty = require('node-pty');",
    "    console.log('ABI_OK');",
    '  } catch {',
    "    console.log('ABI_MISMATCH');",
    '  }',
    '  app.exit(0);',
    '});',
  ].join('\n');
  require('node:fs').writeFileSync(probeFile, probe, 'utf8');
  const check = spawnSync(electronBin, [probeFile], { encoding: 'utf8', timeout: 30_000 });
  require('node:fs').rmSync(probeFile, { force: true });
  if ((check.stdout ?? '').includes('ABI_OK')) {
    console.log('[rebuild-native] ✓ Electron ABI 已就绪（--auto 跳过）');
    process.exit(0);
  }
  console.log('[rebuild-native] Electron ABI 不匹配，执行 rebuild');
}

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
