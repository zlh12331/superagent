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
//   TAM_SRC=<上游解压根目录> node scripts/prepare-memory-hub.mjs [--skip-if-exists]
// 环境变量：
//   TAM_SRC             上游 TencentDB-Agent-Memory 根目录（必填）
//   MEMORY_HUB_OPTIONAL 置为 '1' 时，上游不可用则生成占位目录并告警退出 0
//                       （CI 打包用：产物不含记忆引擎，运行时自动降级为空实现）
//
// 为什么没有默认路径：上游源码不入仓（见 .gitignore），npm registry 上
//   @tencentdb-agent-memory/memory-tencentdb-v2 只有 1.0.0-beta.1，供不起本项目
//   需要的 2.0.x，因此唯一来源是维护者本地持有的压缩包，必须显式指路。
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
const SRC = process.env['TAM_SRC'];
const CORE = join(SRC ?? '', 'MemoryCore');
const MARKER = '.memory-hub-placeholder';

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
const upstreamEntry = join(CORE, 'src', 'gateway', 'server.ts');
const targetReady =
  existsSync(join(TARGET, 'src', 'gateway', 'server.ts')) &&
  existsSync(join(TARGET, 'node_modules'));

if (!existsSync(upstreamEntry)) {
  if (targetReady) {
    console.log(`[prepare-memory-hub] 上游不可用，沿用已有产物（${TARGET}）`);
    process.exit(0);
  }
  if (process.env['MEMORY_HUB_OPTIONAL'] === '1') {
    writePlaceholder();
    process.exit(0);
  }
  console.error(
    SRC === undefined
      ? '[prepare-memory-hub] 环境变量 TAM_SRC 未设置（上游 TencentDB-Agent-Memory 根目录）'
      : `[prepare-memory-hub] 未找到上游入口：${upstreamEntry}（TAM_SRC=${SRC}）`,
  );
  console.error('  请设置 TAM_SRC 后重试，记忆引擎随包分发。');
  console.error('  CI 暂不集成记忆引擎时，设置 MEMORY_HUB_OPTIONAL=1 打包无引擎产物。');
  process.exit(1);
}

/**
 * 生成占位运行目录：让 electron-builder 的两个 extraResources `from` 路径都存在，
 * 产物可正常打包安装；记忆引擎在运行时（MemoryHubService）降级为空实现。
 */
function writePlaceholder() {
  rmSync(TARGET, { recursive: true, force: true });
  mkdirSync(join(TARGET, 'node_modules'), { recursive: true });
  const note = [
    'Placeholder for resources/memory-hub (upstream TencentDB-Agent-Memory / MemoryCore).',
    '',
    'This build intentionally ships WITHOUT the memory engine: TAM_SRC was not provided',
    'and MEMORY_HUB_OPTIONAL=1 was set. MemoryHubService detects the missing entry and',
    'falls back to the no-op MemoryPort, so every memory call degrades instead of failing.',
    '',
    'To bundle the real engine: TAM_SRC=<upstream root> node scripts/prepare-memory-hub.mjs',
    '',
  ].join('\n');
  writeFileSync(join(TARGET, MARKER), note, 'utf8');
  writeFileSync(join(TARGET, 'node_modules', MARKER), note, 'utf8');
  console.warn(
    '[prepare-memory-hub] ⚠ 上游缺失，已生成占位目录 —— 本产物不含记忆引擎（运行时降级空实现）',
  );
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
