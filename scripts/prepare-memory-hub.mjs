// scripts/prepare-memory-hub.mjs
// 生成 resources/memory-hub/（上游 TencentDB-Agent-Memory · MemoryCore 运行目录）
// ──────────────────────────────────────────────────────────────
// 背景：记忆引擎由 MemoryHubService 以 sidecar 子进程方式拉起（ELECTRON_RUN_AS_NODE=1）。
//   dev 环境通过 MEMORY_HUB_ROOT 指向上游解压源码目录；打包环境需要自包含运行目录，
//   经 electron-builder extraResources 部署到 process.resourcesPath/memory-hub。
//
// 策略（与 dev 路径一致）：prod 也走 `src/gateway/server.ts + tsx`。
//   上游官方 tsdown 入口是 index.ts，产物 dist 里没有 gateway/server.js，
//   因此不构建 dist，直接拷贝 src + package.json，并在目标目录用 pnpm 重建
//   node_modules（在目标原地 install 而非拷贝，保证 pnpm 符号链接正确）。
//
// 用法：
//   node scripts/prepare-memory-hub.mjs [--skip-if-exists]
// 环境变量：
//   TAM_SRC  上游根目录（默认 C:\Users\26592\AppData\Local\Temp\tam-src\TencentDB-Agent-Memory-2.0.1-beta.2）
// ──────────────────────────────────────────────────────────────

import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = process.cwd();
const TARGET = join(ROOT, 'resources', 'memory-hub');
const DEFAULT_SRC =
  'C:\\Users\\26592\\AppData\\Local\\Temp\\tam-src\\TencentDB-Agent-Memory-2.0.1-beta.2';
const SRC = process.env['TAM_SRC'] ?? DEFAULT_SRC;
const CORE = join(SRC, 'MemoryCore');

const skipIfExists = process.argv.includes('--skip-if-exists');
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

function run(cmd, args, cwd) {
  const res = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
  if (res.status !== 0) {
    console.error(`[prepare-memory-hub] 命令失败：${cmd} ${args.join(' ')}`);
    process.exit(res.status ?? 1);
  }
}

function dirSizeMb(dir) {
  let bytes = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) bytes += dirSizeMb(p) * 1024 * 1024;
    else if (entry.isFile()) bytes += statSync(p).size;
  }
  return (bytes / 1024 / 1024).toFixed(1);
}

function countFiles(dir) {
  let n = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) n += countFiles(p);
    else n += 1;
  }
  return n;
}

// 1. 校验上游
if (!existsSync(join(CORE, 'src', 'gateway', 'server.ts'))) {
  console.error(
    `[prepare-memory-hub] 未找到上游入口：${join(CORE, 'src', 'gateway', 'server.ts')}`,
  );
  console.error(`  请设置 TAM_SRC 指向 TencentDB-Agent-Memory 解压根目录（当前：${SRC}）`);
  process.exit(1);
}

// 2. 已存在且跳过
if (
  skipIfExists &&
  existsSync(join(TARGET, 'src', 'gateway', 'server.ts')) &&
  existsSync(join(TARGET, 'node_modules'))
) {
  console.log(`[prepare-memory-hub] 目标已就绪，跳过（${TARGET}）`);
  process.exit(0);
}

// 3. 重建目标目录
rmSync(TARGET, { recursive: true, force: true });
mkdirSync(TARGET, { recursive: true });

// 4. 拷贝运行所需文件（排除测试 / 插件 / 脚本 / 文档等非运行时内容）
const COPY_FILES = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'];
for (const f of COPY_FILES) {
  const srcFile = join(CORE, f);
  if (existsSync(srcFile)) cpSync(srcFile, join(TARGET, f));
}
const IGNORE_DIRS = new Set(['__tests__', '__mocks__', 'integrations']);
cpSync(join(CORE, 'src'), join(TARGET, 'src'), {
  recursive: true,
  filter: (src) => {
    const base = src.split(/[\\/]/).pop();
    if (IGNORE_DIRS.has(base)) return false;
    if (/\.test\.ts$/.test(src) || /\.spec\.ts$/.test(src)) return false;
    return true;
  },
});
console.log('[prepare-memory-hub] 已拷贝 src/ + package.json（排除测试文件）');

// 5. 在目标目录重建 node_modules
//    - 排除 optionalDependencies（mongodb/cos/kafka/redis/clickhouse/opik 等重型包，不在本集成范围），
//      经目标目录 .npmrc 的 `optional=false` 生效
//    - --store-dir 指向系统临时目录（勿放目标内，否则逻辑体积翻倍；pnpm 链接保持可用）
//    - --ignore-scripts 绕开 postinstall 的 bash 依赖
console.log('[prepare-memory-hub] 在目标目录安装生产依赖（排除 optional，--ignore-scripts）…');
writeFileSync(join(TARGET, '.npmrc'), 'optional=false\n', 'utf8');
const storeDir = join(tmpdir(), 'pnpm-store-memory-hub');
run(
  pnpm,
  ['install', '--prod', '--ignore-scripts', '--no-frozen-lockfile', '--store-dir', storeDir],
  TARGET,
);
rmSync(join(TARGET, '.npmrc'), { force: true });

// 6. 摘要
const sizeMb = dirSizeMb(TARGET);
const files = countFiles(TARGET);
console.log(`[prepare-memory-hub] 完成 → ${TARGET}（${sizeMb} MB，${files} 个文件）`);
