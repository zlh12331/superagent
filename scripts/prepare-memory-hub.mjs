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
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

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

// 5.1 裁剪孤儿依赖（体积优化）
//
// 策略（2026-09-13 改为可达性分析，替代此前的包名前缀匹配）：
//   1. 从顶层 package.json 的 dependencies 出发，沿 dependencies / peerDependencies /
//      optionalDependencies 求可达闭包 → 这些必须保留
//   2. 不在闭包内的 .pnpm 实体目录 = 孤儿（其声明者已被裁掉或从未被引用）→ 删除
//   3. 先摘除所有指向待删包的 junction/symlink，再删实体目录
//      （pnpm 用 junction 链接；留下断链会让 electron-builder 的 7zip 报错）
//
// 为什么改成可达性分析：此前用固定前缀匹配（['node-llama-cpp', '@node-llama-cpp',
//   'openclaw']），存在两个问题：
//   a. 上游包名变化即漏裁（实测：包名是 @openclaw/ai 等带 scope 形式，前缀 'openclaw'
//      匹配不到 → 其整棵依赖子树成为孤儿却留在产物里）
//   b. 裁掉声明者后，其独占依赖不会连带清理（实测孤儿合计 135MB，含 typescript 23MB /
//      tree-sitter-bash 19MB / playwright-core 13MB 等）
//   可达性分析天然覆盖这两类，且不依赖具体包名。
//
// 保留项说明：node-llama-cpp 与 openclaw 作为 peerDependencies 出现在闭包中——
//   但它们的**实体若未被任何保留包依赖**则仍会被裁（这正是我们要的效果）；
//   本集成不使用本地推理（蒸馏走 OpenAI 兼容 HTTP）与插件宿主（sidecar 独立启动）。

const PNPM_DIR = join(TARGET, 'node_modules', '.pnpm');

/** 读取一个包目录的依赖名集合 */
function readDeps(dir) {
  try {
    const pj = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    return [
      ...Object.keys(pj.dependencies ?? {}),
      ...Object.keys(pj.peerDependencies ?? {}),
      ...Object.keys(pj.optionalDependencies ?? {}),
    ];
  } catch {
    return [];
  }
}

/**
 * 从 .pnpm 实体目录名解析该实体**自身的包名**
 *
 * 目录名格式：`<包名>@<版本>[_<peer 解析后缀>]`，作用域包的分隔符 `/` 被编码为 `+`。
 * 例：
 *   openclaw@2026.9.4_@opentele_93aeb3cb…  → openclaw
 *   @openclaw+fs-safe@0.8.5                → @openclaw/fs-safe
 *   zod@4.6.2                              → zod
 *
 * ⚠️ 必须解析自身包名而不是遍历其 node_modules：`.pnpm/<实体>/node_modules/` 里
 *   同时装着该实体的**全部依赖**（pnpm 隔离式布局）。若把其中的包名都登记到本实体，
 *   会出现"某实体的依赖被当成该实体自身"的错配——实测因此把 zod 的依赖 openclaw
 *   误判为"zod 自身"，导致 214MB 的 openclaw 被错误保留。
 */
function parseOwnPackageName(entryName) {
  const withoutPeers = entryName.split('_')[0] ?? entryName;
  const at = withoutPeers.lastIndexOf('@');
  const raw = at <= 0 ? withoutPeers : withoutPeers.slice(0, at);
  return raw.replace('+', '/');
}

/**
 * 建立「包名 → .pnpm 实体目录名」索引（同一包可能有多版本/多 peer 变体）
 */
function buildPnpmIndex() {
  const index = new Map(); // 包名 → Set<实体目录名>
  for (const entry of readdirSync(PNPM_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'node_modules') continue;
    const ownName = parseOwnPackageName(entry.name);
    // 仅当实体内确实存在该包（避免解析失配时登记错误映射）
    if (!existsSync(join(PNPM_DIR, entry.name, 'node_modules', ownName, 'package.json'))) {
      continue;
    }
    if (!index.has(ownName)) index.set(ownName, new Set());
    index.get(ownName).add(entry.name);
  }
  return index;
}

/** 从顶层依赖出发求可达包名集合 */
function reachablePackages() {
  const rootPkg = JSON.parse(readFileSync(join(TARGET, 'package.json'), 'utf8'));
  const index = buildPnpmIndex();
  const keepNames = new Set();
  const keepEntries = new Set();
  // 起点必须包含 optionalDependencies：上游对可选后端（如 @clickhouse/client）有
  // **静态 import**，缺失会导致模块解析失败（实测：漏掉它直接让引擎启动崩溃）。
  // peerDependencies 不纳入起点——但作为传递依赖时会经 readDeps 进入（见下），
  // 若未被任何保留实体引用则自然被裁。
  const queue = [
    ...Object.keys(rootPkg.dependencies ?? {}),
    ...Object.keys(rootPkg.optionalDependencies ?? {}),
  ];

  while (queue.length > 0) {
    const name = queue.pop();
    if (name === undefined || keepNames.has(name)) continue;
    keepNames.add(name);
    const entries = index.get(name);
    if (entries === undefined) continue; // 平台可选包等未安装的情况
    for (const entryName of entries) {
      if (keepEntries.has(entryName)) continue;
      keepEntries.add(entryName);
      // 该实体内部的依赖继续入队
      const entryNm = join(PNPM_DIR, entryName, 'node_modules');
      const pkgDir = join(entryNm, name);
      for (const dep of readDeps(pkgDir)) {
        if (!keepNames.has(dep)) queue.push(dep);
      }
    }
  }
  return { keepNames, keepEntries, index };
}

if (existsSync(PNPM_DIR)) {
  const { keepEntries } = reachablePackages();

  // 待删实体 = .pnpm 下所有实体目录 − 可达实体
  const allEntries = readdirSync(PNPM_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== 'node_modules')
    .map((e) => e.name);
  const doomed = allEntries.filter((name) => !keepEntries.has(name));

  console.log(
    `[prepare-memory-hub] 依赖可达性分析：保留 ${keepEntries.size} 个实体，孤儿 ${doomed.length} 个`,
  );

  // 1) 删除孤儿实体目录
  let prunedMb = 0;
  for (const name of doomed) {
    try {
      const size = dirSizeMb(join(PNPM_DIR, name));
      rmSync(join(PNPM_DIR, name), { recursive: true, force: true });
      prunedMb += Number(size);
    } catch {
      // 被占用时跳过（Windows 偶发），不阻断构建
    }
  }

  // 2) 清理所有指向已删目标的断链（junction/symlink）
  //
  // 为什么用"扫断链"而不是"按包名摘除"：pnpm 在 node_modules/ 与
  //   .pnpm/node_modules/ 下用 junction 链接到 .pnpm/<实体>，删实体后这些链接即断。
  //   按包名推断易错（实测：把某实体 node_modules 里的依赖误判为实体自身，
  //   导致 214MB 的 openclaw 被错误保留）；扫断链直接可靠——
  //   且断链必须清除，否则 electron-builder 的 7zip 压缩会报"系统找不到指定的路径"。
  let brokenLinks = 0;
  const sweepBrokenLinks = (root, depth) => {
    if (depth > 6 || !existsSync(root)) return;
    let entries;
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const p = join(root, ent.name);
      if (ent.name === '.pnpm' && depth > 0) continue;
      let st;
      try {
        st = lstatSync(p);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) {
        // 目标不存在 = 断链 → 摘除链接本身（不跟随删除）
        if (!existsSync(p)) {
          try {
            unlinkSync(p);
            brokenLinks += 1;
          } catch {
            // 占用时跳过
          }
        }
        continue;
      }
      if (st.isDirectory()) {
        sweepBrokenLinks(p, depth + 1);
      }
    }
  };
  sweepBrokenLinks(join(TARGET, 'node_modules'), 0);
  // .pnpm/node_modules 是扁平 junction 池，单独扫
  sweepBrokenLinks(join(PNPM_DIR, 'node_modules'), 1);

  if (prunedMb > 0) {
    console.log(
      `[prepare-memory-hub] 已清理孤儿依赖 ~${prunedMb.toFixed(0)} MB` +
        `${brokenLinks > 0 ? ` + ${brokenLinks} 个断链` : ''}`,
    );
  }
}

// 5.2 删除运行期无用文件（sourcemap / 类型声明）——同时修复 Windows MAX_PATH
//
// 背景：electron-builder 把本目录部署到 process.resourcesPath/memory-hub，
//   路径前缀约 75 字符（Windows 典型安装位置）。实测产物内最长相对路径 215 字符，
//   合计约 290 > Windows 260 限制（MAX_PATH）——会导致解压/安装失败或运行时读取异常。
//   超限文件集中在 .map（1346 个）与 .d.ts（类型声明），两者运行期均不需要：
//   - .map：sourcemap，仅调试源码映射用（引擎以 tsx 直跑源码，不消费它）
//   - .d.ts：TypeScript 类型声明，纯编译期产物
//   删除后最长路径显著下降，且顺带回收体积。
const USELESS_EXTENSIONS = ['.map', '.d.ts', '.d.ts.map'];
let removedUseless = 0;
let removedBytes = 0;
const stripUselessFiles = (dir) => {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    const p = join(dir, ent.name);
    if (ent.isSymbolicLink()) continue;
    if (ent.isDirectory()) {
      stripUselessFiles(p);
      continue;
    }
    if (!ent.isFile()) continue;
    if (!USELESS_EXTENSIONS.some((ext) => ent.name.endsWith(ext))) continue;
    try {
      removedBytes += statSync(p).size;
      rmSync(p, { force: true });
      removedUseless += 1;
    } catch {
      // 占用时跳过
    }
  }
};
stripUselessFiles(TARGET);
if (removedUseless > 0) {
  console.log(
    `[prepare-memory-hub] 已清理运行期无用文件 ${removedUseless} 个（sourcemap/类型声明）` +
      ` ~${(removedBytes / 1048576).toFixed(1)} MB——同时缓解 Windows 路径长度限制`,
  );
}

// 6. Windows 路径长度检查（MAX_PATH=260）
//
// 背景：electron-builder 把本目录部署到 <安装目录>/resources/memory-hub。
//   产品名较长（Code Agent Desktop），默认安装路径
//   %LOCALAPPDATA%\Programs\Code Agent Desktop\resources\memory-hub ≈ 59 字符前缀；
//   而 Electron 的 exe manifest **未声明 longPathAware**（实测二进制内无该声明），
//   故 Windows 260 限制真实生效。
//
// 已做的缓解（顺序在检查之前）：
//   - 删除 sourcemap / 类型声明（5.2 节）：去掉最深的一批文件
//   - 依赖可达性裁剪（5.1 节）：移除整棵孤儿子树
//   - 下面额外删除**非当前平台的实现文件**（@opentelemetry 的
//     getMachineId-<platform>.js 等按平台分支的独立实现，运行期由同名选择器
//     按 process.platform 加载，非本平台文件不会被引用）
//
// 实测：裁剪后最长相对路径约 212 字符；在 59 字符前缀下仍有约 34 个文件超限，
//   集中在 @opentelemetry/resources 的 platform 目录。故再按平台裁剪一次。
const PLATFORM_SUFFIX_PATTERNS = [
  // 非当前平台的实现文件（形如 getMachineId-darwin.js / -linux / -win / -bsd / -unsupported）
  /-(darwin|linux|win|bsd|unsupported)\.(js|mjs|cjs)$/,
];
const CURRENT_PLATFORM_TAGS = new Set(
  process.platform === 'win32'
    ? ['win', 'unsupported']
    : process.platform === 'darwin'
      ? ['darwin', 'unsupported']
      : ['linux', 'unsupported'],
);
let removedCrossPlatform = 0;
const stripForeignPlatformFiles = (dir) => {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    const p = join(dir, ent.name);
    if (ent.isSymbolicLink()) continue;
    if (ent.isDirectory()) {
      stripForeignPlatformFiles(p);
      continue;
    }
    if (!ent.isFile()) continue;
    // 仅处理 @opentelemetry 包内（避免误伤其他约定的同名文件）
    if (!p.includes(`${sep}@opentelemetry${sep}`)) continue;
    for (const pattern of PLATFORM_SUFFIX_PATTERNS) {
      const m = pattern.exec(ent.name);
      if (m === null) continue;
      const tag = m[1];
      if (tag !== undefined && !CURRENT_PLATFORM_TAGS.has(tag)) {
        try {
          rmSync(p, { force: true });
          removedCrossPlatform += 1;
        } catch {
          // 占用时跳过
        }
      }
      break;
    }
  }
};
stripForeignPlatformFiles(TARGET);
if (removedCrossPlatform > 0) {
  console.log(
    `[prepare-memory-hub] 已删除非本平台实现文件 ${removedCrossPlatform} 个` +
      `（当前平台 ${process.platform}，缓解 Windows 路径长度限制）`,
  );
}

const MAX_PATH = 260;
const ASSUMED_INSTALL_PREFIX = 59; // 默认安装路径实测估算（见上）
let overLimit = 0;
let maxRelative = 0;
const checkPathLength = (dir) => {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    const p = join(dir, ent.name);
    if (ent.isSymbolicLink()) continue;
    if (ent.isDirectory()) {
      checkPathLength(p);
      continue;
    }
    if (!ent.isFile()) continue;
    const relLen = p.length - ROOT.length; // 相对项目根（含 resources/memory-hub）
    if (relLen > maxRelative) maxRelative = relLen;
    if (relLen + ASSUMED_INSTALL_PREFIX > MAX_PATH) overLimit += 1;
  }
};
checkPathLength(TARGET);
if (overLimit > 0) {
  console.warn(
    `[prepare-memory-hub] ⚠ Windows 路径长度：${overLimit} 个文件在默认安装路径下` +
      `可能超过 ${MAX_PATH} 字符（最长相对 ${maxRelative}）。若安装失败请装到更浅的目录。`,
  );
} else {
  console.log(
    `[prepare-memory-hub] 路径长度检查通过（最长相对 ${maxRelative} 字符 + 安装前缀 ` +
      `${ASSUMED_INSTALL_PREFIX} = ${maxRelative + ASSUMED_INSTALL_PREFIX} ≤ ${MAX_PATH}）`,
  );
}

// 7. 摘要
const sizeMb = dirSizeMb(TARGET);
const files = countFiles(TARGET);
console.log(`[prepare-memory-hub] 完成 → ${TARGET}（${sizeMb} MB，${files} 个文件）`);
