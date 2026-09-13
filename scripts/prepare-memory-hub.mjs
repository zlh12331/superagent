// scripts/prepare-memory-hub.mjs
// 生成 resources/memory-hub/（上游 TencentDB-Agent-Memory · MemoryCore 运行目录）
// ──────────────────────────────────────────────────────────────
// 背景：记忆引擎由 MemoryHubService 以 sidecar 子进程方式拉起。
//   源代码 = packages/memory-engine/MemoryCore（vendored 进仓，见该目录 UPSTREAM.md）；
//   打包环境需要自包含运行目录，经 electron-builder extraResources 部署到
//   process.resourcesPath/memory-hub。
//
// 策略：走 `src/gateway/server.ts + tsx`。
//   上游官方 tsdown 入口是 index.ts，产物 dist 里没有 gateway/server.js，
//   因此不构建 dist，直接拷贝 src + package.json，并在目标目录用 pnpm 重建
//   node_modules（在目标原地 install 而非拷贝，保证 pnpm 符号链接正确）。
//
// 用法：
//   node scripts/prepare-memory-hub.mjs [--skip-if-exists]
// 环境变量：
//   MEMORY_ENGINE_ROOT  覆盖源码根目录（默认 packages/memory-engine/MemoryCore）——
//                       仅用于测试/临时验证；正常构建与 CI 一律用仓内源码。
//
// 源码来源已 vendoring 进仓（2026-09-13）：此前依赖维护者本地解压目录 +
//   TAM_SRC 环境变量，导致 CI 构建拿不到引擎、正式产物缺失记忆功能。
//   现不再支持"缺引擎则生成占位产物"（该静默降级曾让残缺包正常发布）。
// ──────────────────────────────────────────────────────────────

import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = process.cwd();
const TARGET = join(ROOT, 'resources', 'memory-hub');
// 源码真源：仓内 vendored 上游（可用 MEMORY_ENGINE_ROOT 覆盖，仅限测试）
const CORE =
  process.env['MEMORY_ENGINE_ROOT'] ?? join(ROOT, 'packages', 'memory-engine', 'MemoryCore');

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

// 1. 校验源码（vendored 进仓，缺失即失败——不再有"生成占位产物"的静默降级）
const upstreamEntry = join(CORE, 'src', 'gateway', 'server.ts');
const targetReady =
  existsSync(join(TARGET, 'src', 'gateway', 'server.ts')) &&
  existsSync(join(TARGET, 'node_modules'));

if (!existsSync(upstreamEntry)) {
  console.error(`[prepare-memory-hub] 未找到记忆引擎源码入口：${upstreamEntry}`);
  console.error('  源码应位于 packages/memory-engine/MemoryCore（vendored 上游，随仓库分发）。');
  console.error('  若该目录缺失，说明 checkout 不完整——请检查 git 状态，勿用占位产物打包。');
  process.exit(1);
}

// 2. 已存在且跳过
if (skipIfExists && targetReady) {
  console.log(`[prepare-memory-hub] 目标已就绪，跳过（${TARGET}）`);
  process.exit(0);
}

// 3. 重建目标目录
rmSync(TARGET, { recursive: true, force: true });
mkdirSync(TARGET, { recursive: true });

// 4. 拷贝运行所需文件（排除测试 / 插件 / 脚本 / 文档等非运行时内容）
//    注意：不拷贝 pnpm-workspace.yaml——上游它是 pnpm v10 的 allowBuilds 配置（无 packages 字段），
//    拷贝会让 pnpm 进入 workspace 模式却缺 packages，install 报 "packages field missing or empty"。
//    目标是单包安装，仅 package.json + lock 即可。
const COPY_FILES = ['package.json', 'pnpm-lock.yaml'];
for (const f of COPY_FILES) {
  const srcFile = join(CORE, f);
  if (existsSync(srcFile)) cpSync(srcFile, join(TARGET, f));
}
// 精简上游 package.json 的 optionalDependencies（mongodb/cos/kafka/redis/clickhouse/opik 等
// 服务端/测试用重型包，不在本集成范围）。不能设 `optional=false`——那会把依赖树中传递的
// 平台二进制（如 @node-rs/jieba-win32-x64-msvc）一并排除，导致 jieba 加载崩溃。
// 清空顶层 optionalDependencies 即可：测试重包不装，平台二进制照常解析。
const pkgPath = join(TARGET, 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
if (pkg.optionalDependencies && Object.keys(pkg.optionalDependencies).length > 0) {
  pkg.optionalDependencies = {};
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2), 'utf8');
  console.log('[prepare-memory-hub] 已清空 optionalDependencies（排除测试重型包）');
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
//    - --store-dir 指向系统临时目录（勿放目标内，否则逻辑体积翻倍；pnpm 链接保持可用）
//    - --ignore-scripts 绕开 postinstall 的 bash 依赖（上游插件为 OpenClaw 环境，运行不需要）
console.log('[prepare-memory-hub] 在目标目录安装生产依赖（--ignore-scripts）…');
// 隔离 workspace：写一个仅含空 packages 的 pnpm-workspace.yaml，阻止 pnpm 沿目录上溯
// 找到 F:\TraeProjects\1\ 项目根 workspace（否则依赖被装到父级、目标目录近乎为空）。
writeFileSync(join(TARGET, 'pnpm-workspace.yaml'), 'packages: []\n', 'utf8');
const storeDir = join(tmpdir(), 'pnpm-store-memory-hub');
run(
  pnpm,
  ['install', '--prod', '--ignore-scripts', '--no-frozen-lockfile', '--store-dir', storeDir],
  TARGET,
);

// 5.1 清理运行时不需要的重型 peer/optional 平台二进制（体积优化）
//    - node-llama-cpp：本地 LLM 推理引擎（peerDependency，多平台二进制共 ~670MB，
//      含 @node-llama-cpp/<platform> 各平台包）。我们的蒸馏走 OpenAI 兼容 HTTP
//      （MemoryHubLlmConfig），不落地推理，可安全移除。
//    - openclaw：上游插件宿主（peerDependency），sidecar 以独立 gateway 启动，不经过宿主。
// 注意：pnpm 用 junction（目录符号链接）链接 .pnpm/<pkg>@<ver> 到 node_modules/<pkg> 与
//    .pnpm/node_modules/<pkg>。仅删 .pnpm 目录会留下指向已删目标的断链 junction——electron-builder
//    的 7zip 压缩遇到断链会报"系统找不到指定的路径"并失败。因此必须先删除所有指向这些包的
//    junction/symlink（unlinkSync 只删链接不删目标），再删实体目录。
/** 递归删除 node_modules 下所有 name 命中 PRUNE_PREFIXES 的符号链接/目录 */
function pruneSymlinks(root) {
  const entries = readdirSync(root, { withFileTypes: true });
  for (const ent of entries) {
    const p = join(root, ent.name);
    if (ent.isSymbolicLink() && PRUNE_PREFIXES.some((prefix) => ent.name.startsWith(prefix))) {
      // junction/symlink：只摘除链接本身，不跟随删除目标
      unlinkSync(p);
      continue;
    }
    if (ent.isDirectory()) {
      // 跳过 .pnpm 实体缓存目录（它们在下一段单独按需删除）
      if (ent.name === '.pnpm') continue;
      pruneSymlinks(p);
    }
  }
}
const PRUNE_PREFIXES = ['node-llama-cpp', '@node-llama-cpp', 'openclaw'];
const pruneDir = join(TARGET, 'node_modules', '.pnpm');
if (existsSync(pruneDir)) {
  // 1) 递归摘除 node_modules 树中指向目标包的 junction（防断链）
  pruneSymlinks(join(TARGET, 'node_modules'));
  // 2) 删除 .pnpm 中的实体目录（体积回收）
  let prunedMb = 0;
  for (const dir of readdirSync(pruneDir, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    // .pnpm 目录名形如 node-llama-cpp@… / @node-llama-cpp+win-x64-cuda3.20.0 / openclaw…_…
    if (!PRUNE_PREFIXES.some((prefix) => dir.name.startsWith(prefix))) continue;
    try {
      const size = dirSizeMb(join(pruneDir, dir.name));
      rmSync(join(pruneDir, dir.name), { recursive: true, force: true });
      prunedMb += Number(size);
    } catch {
      // 个别目录被占用时跳过（不阻断整体流程）
    }
  }
  // 3) 摘除 .pnpm/node_modules 下的相关 junction（含 @node-llama-cpp/win-* 子项）
  const pnpmNodeModules = join(pruneDir, 'node_modules');
  if (existsSync(pnpmNodeModules)) {
    for (const ent of readdirSync(pnpmNodeModules, { withFileTypes: true })) {
      const p = join(pnpmNodeModules, ent.name);
      if (PRUNE_PREFIXES.some((prefix) => ent.name.startsWith(prefix))) {
        if (ent.isSymbolicLink()) {
          unlinkSync(p);
        } else {
          // @node-llama-cpp 等是普通目录，内含 win-* junction → 整目录删除（递归删链接+空壳）
          rmSync(p, { recursive: true, force: true });
        }
      }
    }
  }
  if (prunedMb > 0) {
    console.log(`[prepare-memory-hub] 已清理重型插件二进制 ~${prunedMb.toFixed(0)} MB`);
  }
}

// 6. 摘要
const sizeMb = dirSizeMb(TARGET);
const files = countFiles(TARGET);
console.log(`[prepare-memory-hub] 完成 → ${TARGET}（${sizeMb} MB，${files} 个文件）`);
