// scripts/prepare-memory-hub.mjs
// 生成 resources/memory-hub/（上游 TencentDB-Agent-Memory · MemoryCore 运行目录）
// ──────────────────────────────────────────────────────────────
// 背景：记忆引擎由 MemoryHubService 以 sidecar 子进程方式拉起。
//   源代码 = packages/memory-engine/MemoryCore（vendored 进仓，见该目录 UPSTREAM.md）；
//   打包环境需要自包含运行目录，经 electron-builder extraResources 部署到
//   process.resourcesPath/memory-hub。
//
// 策略：构建 dist 产物（2026-10-05 起，替代 tsx 直跑）。
//   上游官方 tsdown 入口是 index.ts，产物 dist 里没有 gateway/server.js，因此
//   由本脚本用 esbuild 把过滤后的 src 全量转译为 dist（非 bundle，import specifier
//   原样保留 → 源码的 `.js` 后缀导入在 dist 内恰好命中同名 .js 产物，运行时零
//   loader 依赖）；转译后删除 src，产物只留 dist + node_modules。
//
//   ⚠️ 为什么不再 tsx 直跑（1.4.0/1.5.0 真机实证的启动失败，2026-10-05 排障）：
//   打包环境 Electron 会剥掉 NODE_OPTIONS（stderr: "Most NODE_OPTIONs are not
//   supported in packaged apps"）→ tsx loader 挂不上；而 Node 24 的原生类型剥离
//   仍能直跑 .ts 到 import 阶段，但它不做 tsx 的 `.js`→`.ts` 导入映射 →
//   `import '../core/tdai-core.js'` 按字面找文件 → ERR_MODULE_NOT_FOUND →
//   sidecar 启动 100% 失败，记忆功能全程静默降级。dev 模式不受影响（未打包，
//   NODE_OPTIONS 生效），继续走 src + tsx 分支（MemoryHubService.resolveEntry
//   的 dist 优先 / src 回退双分支无需改动）。
//
//   node_modules 仍在目标目录原地 pnpm install（保证 pnpm 符号链接正确）。
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
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { build as esbuildBuild } from 'esbuild';

const ROOT = process.cwd();
const TARGET = join(ROOT, 'resources', 'memory-hub');
// 源码真源：仓内 vendored 上游（可用 MEMORY_ENGINE_ROOT 覆盖，仅限测试）
const CORE =
  process.env['MEMORY_ENGINE_ROOT'] ?? join(ROOT, 'packages', 'memory-engine', 'MemoryCore');

const skipIfExists = process.argv.includes('--skip-if-exists');
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

/** 支持的架构集合（与 electron-builder.yml 的 target.arch 对齐） */
const ALL_ARCHS = ['x64', 'arm64'];

/**
 * 目标架构：可由 CODE_AGENT_TARGET_ARCHS 收窄（逗号分隔），默认全部
 *
 * 与 scripts/prepare-codegraph.mjs 同一约定（release.yml 每个构建 job 都 export
 * `CODE_AGENT_TARGET_ARCHS=${{ matrix.target-archs }}`）。默认（未设置）保持
 * **双架构**：本地 `pnpm build:win`（CLI 同时传 --x64 --arm64）在单架构机器上
 * 交叉构建时，收窄到 host 架构会把错误架构的原生绑定打进另一架构的包。
 * 只有 CI 单架构 job 显式收窄时才裁剪——此时 runner 架构即目标架构。
 */
function resolveTargetArchs() {
  const raw = process.env['CODE_AGENT_TARGET_ARCHS'];
  if (raw === undefined || raw.trim() === '') {
    return ALL_ARCHS;
  }
  const requested = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  const unknown = requested.filter((a) => !ALL_ARCHS.includes(a));
  if (unknown.length > 0) {
    console.error(
      `[prepare-memory-hub] CODE_AGENT_TARGET_ARCHS 含未知架构：${unknown.join(', ')}` +
        `（支持：${ALL_ARCHS.join(', ')}）`,
    );
    process.exit(1);
  }
  return requested.length > 0 ? requested : ALL_ARCHS;
}

const targetArchs = resolveTargetArchs();

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
  existsSync(join(TARGET, 'dist', 'gateway', 'server.js')) &&
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
// ⚠️ optionalDependencies **不能清空**（2026-10-05 bundle 实测）：可选后端的包
//   （@clickhouse/client、@opentelemetry/sdk-node、kafka/crc-32 等）在引擎源码的
//   **静态 import 链**上——bundle 时 esbuild 要沿链解析，缺包即 Build failed
//   （21 个 Could not resolve）。旧"清空重包"策略只适用于转译模式（不解析 import），
//   bundle 模式下必须先装上供解析；bundle 完成后 5.1 裁剪会以 BUNDLE_EXTERNAL 为
//   闭包起点把它们全部回收（最终 node_modules 只剩 external 子树）。
//   也不能用 install 的 `--no-optional`——那会连带排除依赖树中传递的平台二进制
//   （如 @node-rs/jieba-win32-x64-msvc），导致 jieba 加载崩溃。
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
//
// ⚠️ virtualStoreDirMaxLength（2026-09-20 修 Windows 升级失败）：
// 默认的 .pnpm 实体目录名形如 `@opentelemetry+sdk-node@0.2_7e8bdd95a3790ff09…`
// （约 70 字符），与深层包路径叠加后使安装目录内的最深相对路径达 **206 字符**。
// 而 Windows 的 NSIS 卸载器在「更新模式」下要把每个文件**重命名**到
// `$PLUGINSDIR\old-install\<相对路径>`（实测 $PLUGINSDIR 45 字符 + 前缀 13 字符），
// 总长 264 > MAX_PATH 260 ⇒ 重命名失败 ⇒ 卸载器 Abort（退出码 2）⇒ 安装器弹
// 「Failed to uninstall old application files」。已用真实 makensis 复现
// （206 字符路径 CreateDirectory/Rename 均 FAILED，短路径对照 OK）。
// 收紧到 24 后实体目录名为哈希（33 字符），最深相对路径降到 170（目标 228 < 260）。
//
// supportedArchitectures：引擎依赖 @node-rs/jieba，它按平台/架构分发原生绑定
// （optionalDependencies，如 jieba-darwin-x64 / -darwin-arm64），运行时由包内
// index.js 按 process.platform + process.arch 动态 require。只装 host 架构会在
// 交叉构建时打进错误架构的绑定（x64 包内为 arm64 绑定 → 分词功能失败）。
// cpu 列表由 targetArchs 决定：默认双架构（本地交叉构建安全）；CI 单架构 job 经
// CODE_AGENT_TARGET_ARCHS 收窄后，另一架构的原生包（@esbuild / @node-rs/jieba
// 的异架构绑定，实测 ~12MB）不再下载——该 job 的产物只服务单一架构。
writeFileSync(
  join(TARGET, 'pnpm-workspace.yaml'),
  'packages: []\n' +
    'supportedArchitectures:\n  os:\n    - current\n  cpu:\n' +
    targetArchs.map((a) => `    - ${a}\n`).join('') +
    'virtualStoreDirMaxLength: 24\n' +
    // shamefullyHoist（2026-10-05，1.6.0-beta.1 真机实证的第二层缺陷）：
    // electron-builder / NSIS 链路会把 pnpm 的 junction **解引用展开成实体目录**
    // （安装目录实测 tcvdb-text isSymbolicLink=false）——展开后入口包不再是链接，
    // Node 原生 ESM 从实体路径向上找 node_modules 只会到顶层，间接依赖
    // （如 tcvdb-text 的 murmurhash，只存在于 .pnpm 私有层）必然解析失败
    // （ERR_MODULE_NOT_FOUND）。tsx 自带 resolver 会折叠 symlink，dev 无此问题；
    // dist 修复后原生 ESM 首次跑 pnpm 布局才暴露。全量提升到顶层后，
    // 无论下游如何展开，间接依赖都在顶层可达。
    'shamefullyHoist: true\n',
  'utf8',
);
if (targetArchs.length < ALL_ARCHS.length) {
  console.log(
    `[prepare-memory-hub] 按 CODE_AGENT_TARGET_ARCHS 收窄目标架构：${targetArchs.join(', ')}` +
      '（跳过异架构原生依赖）',
  );
}
const storeDir = join(tmpdir(), 'pnpm-store-memory-hub');
run(
  pnpm,
  ['install', '--prod', '--ignore-scripts', '--no-frozen-lockfile', '--store-dir', storeDir],
  TARGET,
);

// 4.5 编译 TS → dist（esbuild **bundle 单入口**；2026-10-05 深度优化安装体积）
//     - bundle：非 external 的依赖全部打进 dist/gateway/server.js 单文件——
//       安装体积/时间的主导因素是 node_modules 的海量小文件（NSIS 解引用复制），
//       bundle 后 node_modules 只需保留 external 的原生包子树。
//     - external：原生 .node 绑定无法打包（esbuild 不处理二进制），运行时仍从
//       node_modules 解析（hoist 后顶层可达）。上游裸 require 的包全集见
//       grep（createRequire 调用）：node:sqlite（内置，自动 external）、
//       @node-rs/jieba、@node-rs/jieba/dict、sqlite-vec。
//     - ../integrations/* external：该目录未拷贝进产物（IGNORE_DIRS），且仅经
//       **动态 import**（server.ts 的 cos-backend 等）延迟加载——bundle 时必须
//       放行解析，运行时行为与转译模式一致（走到才炸，本集成不使用该插件面）。
//     - banner：**不加**。上游对 require 的使用全部自建 createRequire
//       （tokenize.ts / memory-store.ts 等文件头 import { createRequire } from
//       'node:module'），banner 再注入会与它们在输出顶层重名
//       （"createRequire has already been declared"，实测冒烟抓到）。
//     - stub 插件：node-llama-cpp 系（本地推理，上游注释明说是 OpenClaw 的 peer、
//       经动态 import 按需加载，本集成不使用）→ 空模块。运行时走到该分支才炸，
//       与 integrations 同一取舍。
//     - @reflink/reflink：传递依赖的原生包（引擎源码无直接 import，被某保留包
//       require），必须 external 而非 stub；裁剪起点同步包含它。
//     - ⚠️ external 清单同时是 5.1 裁剪的可达性起点：非 external 的包已被打进
//       dist，运行时不再从 node_modules 解析，node_modules 只保留 external 子树。
//     - ⚠️ 位置约束：必须在 5 install **之后**——bundle 要沿 import 链解析
//       node_modules（首跑曾误置于 install 前，21 个 Could not resolve 全源于此）。
const BUNDLE_EXTERNAL = ['@node-rs/jieba', 'sqlite-vec', '@reflink/reflink'];
const SRC_DIR = join(TARGET, 'src');
const DIST_DIR = join(TARGET, 'dist');
const stubLocalInference = {
  name: 'stub-local-inference',
  setup(build) {
    build.onResolve({ filter: /^(node-llama-cpp|@node-llama-cpp\/.*)$/ }, (args) => ({
      path: args.path,
      namespace: 'stub-llama',
    }));
    build.onLoad({ filter: /.*/, namespace: 'stub-llama' }, () => ({
      contents: 'export default {};',
      loader: 'js',
    }));
  },
};
try {
  await esbuildBuild({
    entryPoints: [join(SRC_DIR, 'gateway', 'server.ts')],
    outdir: join(DIST_DIR, 'gateway'),
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    sourcemap: false,
    logLevel: 'warning',
    plugins: [stubLocalInference],
    external: [...BUNDLE_EXTERNAL, '../integrations/*'],
    // ⚠️ 别名 __cjsRequire 必需：banner 与上游模块的同名 import 不参与 esbuild 的
    //    scope-hoist 重命名，直用 createRequire 会撞上游自建 import（实测报
    //    "Identifier 'createRequire' has already been declared"）。
    //    const require = … 供 esbuild 的 __require fallback 使用（CJS 依赖内部的
    //    动态 require——如 node:assert——在 ESM 输出里只能靠它解析，实测
    //    "Dynamic require of node:assert is not supported"）。
    banner: {
      js: [
        "import { createRequire as __cjsRequire } from 'node:module';",
        'const require = __cjsRequire(import.meta.url);',
      ].join('\n'),
    },
  });
} catch (err) {
  console.error(`[prepare-memory-hub] ❌ esbuild bundle 失败（fail-closed，不产残缺包）：`, err);
  process.exit(1);
}
// 产物自洽性校验：入口必须在位（与 MemoryHubService.resolveEntry 的 dist 分支对齐）
if (!existsSync(join(DIST_DIR, 'gateway', 'server.js'))) {
  console.error('[prepare-memory-hub] ❌ 编译产物缺 dist/gateway/server.js（入口校验失败）');
  process.exit(1);
}
rmSync(SRC_DIR, { recursive: true, force: true });
console.log(
  '[prepare-memory-hub] 已 bundle src/gateway/server.ts → dist/（入口校验通过，src 已移除）',
);

// 4.6 记录 bundle 内联包的实体路径 + 补拷 data 文件（必须在 5.1 裁剪**之前**——
//     tcvdb-text 的 JS 已进 bundle，其实体与顶层链接会被 5.1 判为孤儿删掉；
//     但它的 data/ 散装文件运行时仍被按原包路径推导读取）
//     ⚠️ 拷贝必须也在这里完成：realpath 指向 .pnpm 内部，5.1.5 删 .pnpm 后就
//     读不到了（曾在 5.1.6 才拷，实体已被自己删除——beta.4 修复期实测）。
//     bundle 后的路径推导：tcvdb-text 的 paths.js packageRoot = __dirname/../，
//     __dirname = dist/gateway/ ⇒ 运行时读 dist/data/ → 拷到 dist/data/ 对齐。
const BUNDLED_DATA_PKGS = ['@tencentdb-agent-memory/tcvdb-text']; // 包名 → data/ 需补拷
for (const name of BUNDLED_DATA_PKGS) {
  const real = realpathSync(join(TARGET, 'node_modules', name));
  const dataSrc = join(real, 'data');
  const dataDest = join(DIST_DIR, 'data');
  if (existsSync(dataSrc)) {
    mkdirSync(dataDest, { recursive: true });
    // BM25 词典 json 原始版带缩进空格（实测 273MB）；minify 语义无损（键值不变），
    // 降一数量级。解析失败时退回原样拷贝（宁可大不可缺）。
    for (const entry of readdirSync(dataSrc, { withFileTypes: true })) {
      const src = join(dataSrc, entry.name);
      const dest = join(dataDest, entry.name);
      if (entry.isFile() && entry.name.endsWith('.json')) {
        try {
          const parsed = JSON.parse(readFileSync(src, 'utf8'));
          writeFileSync(dest, JSON.stringify(parsed), 'utf8');
          continue;
        } catch {
          // 解析失败 → 原样拷贝
        }
      }
      cpSync(src, dest, { recursive: true });
    }
    console.log(`[prepare-memory-hub] 已补拷 ${name} data/ → dist/data/（JSON 已 minify）`);
  } else {
    console.error(`[prepare-memory-hub] ❌ ${name} 缺 data/ 目录（stopwords/BM25 词典缺失）`);
    process.exit(1);
  }
}

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
 * 从 .pnpm 实体目录解析该实体**自身的包名**
 *
 * 两条路径（2026-09-20 增补第二条）：
 * 1. **目录名解析**（常规布局）：`<包名>@<版本>[_<peer 后缀>]`，作用域包的分隔符
 *    `/` 编码为 `+`。例：`@openclaw+fs-safe@0.8.5` → `@openclaw/fs-safe`。
 * 2. **结构识别**（哈希名布局）：virtualStoreDirMaxLength 收紧后目录名变为
 *    `_<32 位哈希>`，目录名里没有包名 ⇒ 改看该实体 `node_modules/` 下的
 *    **非链接成员**。pnpm 的隔离式布局中，实体自身的包是**真实目录**，其依赖是
 *    junction/symlink 链接；实测该结构在 73 个实体上「非链接成员」恒为 1 个、
 *    且与包名一致（零歧义）。
 *
 * ⚠️ 必须解析自身包名而不是遍历全部成员：`.pnpm/<实体>/node_modules/` 里同时装着
 *   该实体的**全部依赖**。若把其中的包名都登记到本实体，会出现"某实体的依赖被当成
 *   该实体自身"的错配——实测因此把 zod 的依赖 openclaw 误判为"zod 自身"，导致
 *   214MB 的 openclaw 被错误保留。
 *
 * @returns 包名；两条路径都失败时为 null（调用方跳过该实体）
 */
function parseOwnPackageName(entryName) {
  const byName = parseNameFromEntry(entryName);
  if (byName !== null) {
    return byName;
  }
  return parseNameFromStructure(entryName);
}

/** 目录名解析（常规布局；哈希名返回 null） */
function parseNameFromEntry(entryName) {
  // 哈希名（virtualStoreDirMaxLength 生效后的形态）没有可解析的包名
  if (entryName.startsWith('_')) {
    return null;
  }
  const withoutPeers = entryName.split('_')[0] ?? entryName;
  const at = withoutPeers.lastIndexOf('@');
  const raw = at <= 0 ? withoutPeers : withoutPeers.slice(0, at);
  return raw === '' ? null : raw.replace('+', '/');
}

/**
 * 结构识别（哈希名布局）：实体自身是 node_modules 下唯一的**非链接**成员
 *
 * 用 realpath 对比判定链接——Windows 上 pnpm 用 junction，Node 的
 * `lstat().isSymbolicLink()` 对 junction 返回 false，但 realpath 与原路径不同。
 */
function parseNameFromStructure(entryName) {
  const nmDir = join(PNPM_DIR, entryName, 'node_modules');
  let members;
  try {
    members = readdirSync(nmDir, { withFileTypes: true });
  } catch {
    return null;
  }
  const own = [];
  for (const member of members) {
    if (member.name === '.bin') continue;
    const full = join(nmDir, member.name);
    if (member.name.startsWith('@')) {
      // 作用域目录：其下的子目录才是包本身
      let subs;
      try {
        subs = readdirSync(full, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const sub of subs) {
        const subFull = join(full, sub.name);
        if (isRealDirectory(subFull)) own.push(`${member.name}/${sub.name}`);
      }
      continue;
    }
    if (isRealDirectory(full)) own.push(member.name);
  }
  // 仅在唯一时才认定（多成员意味着布局异常，宁可跳过该实体也不误判）
  return own.length === 1 ? (own[0] ?? null) : null;
}

/** 判定是否为「实体自身的真实目录」（非 junction/符号链接） */
function isRealDirectory(path) {
  try {
    return realpathSync(path) === resolve(path);
  } catch {
    return false;
  }
}

/**
 * 建立「包名 → .pnpm 实体目录名」索引（同一包可能有多版本/多 peer 变体）
 */
function buildPnpmIndex() {
  const index = new Map(); // 包名 → Set<实体目录名>
  for (const entry of readdirSync(PNPM_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'node_modules') continue;
    const ownName = parseOwnPackageName(entry.name);
    // 两条识别路径都失败时跳过该实体（宁可少登记也不误判归属）
    if (ownName === null) {
      console.warn(`[prepare-memory-hub] ⚠️ 无法识别实体自身包名，跳过：${entry.name}`);
      continue;
    }
    // 仅当实体内确实存在该包（避免解析失配时登记错误映射）
    if (!existsSync(join(PNPM_DIR, entry.name, 'node_modules', ownName, 'package.json'))) {
      continue;
    }
    if (!index.has(ownName)) index.set(ownName, new Set());
    index.get(ownName).add(entry.name);
  }
  return index;
}

/** 从 BUNDLE_EXTERNAL（bundle 后仍需 node_modules 的包）出发求可达包名集合 */
function reachablePackages() {
  const index = buildPnpmIndex();
  const keepNames = new Set();
  const keepEntries = new Set();
  // 起点只放 external 清单（bundle 后非 external 的包已打进 dist，运行时不再
  // 从 node_modules 解析）——节点上被 external 包依赖的原生绑定（如
  // @node-rs/jieba 的平台 optionalDeps）会经 readDeps 自然进入闭包。
  // 旧起点（顶层 dependencies + optionalDependencies 全量）在 bundle 模式下
  // 会把已打进 dist 的几百 MB 包留在 node_modules，违背 bundle 的优化目标。
  const queue = [...BUNDLE_EXTERNAL];

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

// 5.1.5 依赖链接实体化（dereference）+ 删除 .pnpm 私有层
//
// ⚠️ 必须与 electron-builder.yml 里「排除 .pnpm」配套（beta.3 CD 实测失败根因）：
//   hoist 的顶层依赖是 junction（指向 .pnpm 实体），filter 排除 .pnpm 后打包产物里
//   这些链接**全部断链** → 7za 报大量 "The system cannot find the path specified"
//   退出码 1（electron-builder/scripts 注释早有警告："断链会让 7zip 压缩报错"）。
//   解法：打包前把顶层 junction 解引用为真实目录副本、整个删掉 .pnpm——
//   裁剪后顶层只剩 external 子树（~10 个包），解引用成本可忽略；
//   产物变为「纯实体、零链接」，任何下游复制/压缩链路都不再依赖 pnpm 布局。
// 细节：
//   - realpath 判定链接（Windows 上 pnpm v11 用 symlink、旧版用 junction，两者
//     lstat 行为不同——统一以 realpath 与原路径是否一致为准）
//   - 两步走：先 unlink 全部链接本体（对 symlink/junction 都安全），再从 .pnpm
//     实体复制到顶层空位——避免 rmSync(recursive) 误入 junction 实体、避免
//     rename 的占用面（Beta.3 前两版实测分别栽在这两处）
//   - 复制安全：pnpm 的包间链接都在 .pnpm 私有层，包目录内部无嵌套链接，单层复制不扩散
//   - .bin（命令链接池）与 pnpm 元数据文件运行时不需要，随 .pnpm 一起删
const NM_DIR = join(TARGET, 'node_modules');
const PRIVATE_DIR = join(NM_DIR, '.pnpm');
if (existsSync(PRIVATE_DIR)) {
  // 收集所有链接成员并**只删链接本体**（unlinkSync 对 symlink 与 Windows junction
  // 都安全——不跟随目标；Beta.3 教训：对 junction 用 rmSync(recursive) 会深入
  // .pnpm 实体引发连锁错误）
  const relink = [];
  /** 包名 → 实体路径（bundle 内联包的 data 文件要从这里补拷，见 5.1.6） */
  const relinkPackages = new Map();
  const collectLinks = (dir, depth) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (
        entry.name === '.pnpm' ||
        entry.name === '.bin' ||
        entry.name === '.modules.yaml' ||
        entry.name === '.package-map.json' ||
        entry.name === '.pnpm-workspace-state-v1.json'
      ) {
        continue;
      }
      const p = join(dir, entry.name);
      let real;
      try {
        real = realpathSync(p);
      } catch {
        continue; // 断链：随 .pnpm 删除一起消失
      }
      if (real !== resolve(p)) {
        unlinkSync(p);
        relink.push([p, real]);
        // 记录包名 → 实体路径（供 5.1.6 补拷数据文件）。
        // ⚠️ 不用正则：Windows 路径分隔符 + node -e 双层转义极易失真，
        // 分段找最后一个 node_modules 段之后的Join 才稳。
        const segs = String(p).split(/[\\/]/);
        const nmIdx = segs.lastIndexOf('node_modules');
        if (nmIdx >= 0 && nmIdx + 1 < segs.length) {
          relinkPackages.set(segs.slice(nmIdx + 1).join('/'), real);
        }
        continue;
      }
      // 真实目录：仅 @scope 组织层需要下钻找包链接
      if (entry.isDirectory() && entry.name.startsWith('@') && depth === 0) {
        collectLinks(p, depth + 1);
      }
    }
  };
  collectLinks(NM_DIR, 0);
  // 从 .pnpm 实体复制到顶层空位（目标已 unlink，纯新建——无 rename/覆盖/占用面）
  for (const [p, real] of relink) {
    cpSync(real, p, { recursive: true });
  }
  // 删私有层与运行时无用元数据；清掉断链清理残留的空 @scope 壳与顶层散文件
  rmSync(PRIVATE_DIR, { recursive: true, force: true });
  rmSync(join(NM_DIR, '.bin'), { recursive: true, force: true });
  for (const entry of readdirSync(NM_DIR, { withFileTypes: true })) {
    const p = join(NM_DIR, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith('@')) {
        let subs;
        try {
          subs = readdirSync(p);
        } catch {
          continue;
        }
        if (subs.length === 0) rmSync(p, { recursive: true, force: true });
      }
    } else {
      rmSync(p, { force: true });
    }
  }
  // external 包存在性校验（fail-closed——实体化丢包会让 sidecar 运行时才炸）
  for (const pkg of BUNDLE_EXTERNAL) {
    if (!existsSync(join(NM_DIR, pkg, 'package.json'))) {
      console.error(`[prepare-memory-hub] ❌ 实体化后缺 external 包：${pkg}`);
      process.exit(1);
    }
  }
  console.log(
    `[prepare-memory-hub] 已实体化 ${relink.length} 个依赖链接并删除 .pnpm 私有层` +
      '（产物零链接，与打包排除 .pnpm 自洽）',
  );
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

// 5.3 BM25 词典无损压缩（tcvdb-text 的 data/bm25_*.json）
//
// 背景：上游 @tencentdb-agent-memory/tcvdb-text 的 BM25 预训练词典以 pretty-print
//   JSON 分发（en ~191MB / zh ~81MB，为运行目录最大头）。运行期读取方式是
//   readFileSync + JSON.parse（tcvdb-text/dist/encoder/bm25.js 的 setParamsSync），
//   与排版无关 ⇒ JSON.stringify(JSON.parse(x)) 后语义完全等价（数值/键序不变，
//   实测 roundtrip 一致），却可省 ~32% 体积。
// 范围与安全性：只重写生成目录内 tcvdb-text/data/bm25_*.json；解析失败或 minify
//   未变小则保留原文件（不阻断构建）；不触碰 MemoryCore 上游源码（integrity 锁定域）。
// 注意：单文件 JSON.parse 峰值内存可达 ~1-2GB（en 词典 ~543 万词条），CI runner 可承受。
const BM25_FILE_PATTERN = /^bm25_.+\.json$/;
let bm25TrimmedFiles = 0;
let bm25SavedBytes = 0;
if (existsSync(PNPM_DIR)) {
  for (const ent of readdirSync(PNPM_DIR, { withFileTypes: true })) {
    if (!ent.isDirectory() || ent.name === 'node_modules') continue;
    const dataDir = join(
      PNPM_DIR,
      ent.name,
      'node_modules',
      '@tencentdb-agent-memory',
      'tcvdb-text',
      'data',
    );
    if (!existsSync(dataDir)) continue;
    for (const f of readdirSync(dataDir)) {
      if (!BM25_FILE_PATTERN.test(f)) continue;
      const filePath = join(dataDir, f);
      try {
        const raw = readFileSync(filePath, 'utf8');
        const min = JSON.stringify(JSON.parse(raw));
        if (min.length < raw.length) {
          writeFileSync(filePath, min, 'utf8');
          bm25TrimmedFiles += 1;
          bm25SavedBytes += raw.length - min.length;
        }
      } catch {
        // 词典损坏/解析失败：保留原文件（运行期行为与未压缩时一致）
      }
    }
  }
}
if (bm25TrimmedFiles > 0) {
  console.log(
    `[prepare-memory-hub] 已无损压缩 BM25 词典 ${bm25TrimmedFiles} 个` +
      ` ~${(bm25SavedBytes / 1048576).toFixed(1)} MB（语义等价 minify，键值不变）`,
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
/**
 * 升级路径的额外前缀（2026-09-20 补，本次事故的直接原因）
 *
 * ⚠️ 为什么必须单独算：NSIS 卸载器在**更新模式**（--updated）下不删除文件，而是
 * 把每个文件**重命名**到 `$PLUGINSDIR\old-install\<相对路径>`（uninstaller.nsh 的
 * un.atomicRMDir）。任一重命名失败即 Abort（退出码 2），安装器随即弹
 * 「Failed to uninstall old application files」并中止升级。
 *
 * 实测数据（本机真实 makensis 复现）：
 *   $PLUGINSDIR = C:\Users\<user>\AppData\Local\Temp\nsgXXXX.tmp（45 字符）
 *   加 `\old-install\`（13）= 58 字符
 *   原最长相对路径 206 → 目标 264 > 260 ⇒ CreateDirectory/Rename 均 FAILED
 *   （短路径对照 OK，证明是长度而非权限/占用问题）
 *
 * ⇒ 只校验「安装前缀 + 相对路径」（全新安装路径）会**漏掉升级场景**：
 *   1.3.1 能装（全新安装不重命名）而 1.3.2 升级失败，正是这个盲区。
 * 生成侧已用 virtualStoreDirMaxLength=24 收紧（见步骤 5 的说明）。
 */
const UPDATE_MODE_EXTRA_PREFIX = 58;
let overLimit = 0;
let overLimitUpdate = 0;
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
    // 全新安装：<安装目录>/resources/memory-hub/<rel>
    if (relLen + ASSUMED_INSTALL_PREFIX > MAX_PATH) overLimit += 1;
    // 升级：文件名同样会被重命名到 $PLUGINSDIR\old-install 下，故加该前缀
    if (relLen + UPDATE_MODE_EXTRA_PREFIX > MAX_PATH) overLimitUpdate += 1;
  }
};
checkPathLength(TARGET);
const installTotal = maxRelative + ASSUMED_INSTALL_PREFIX;
const updateTotal = maxRelative + UPDATE_MODE_EXTRA_PREFIX;
if (overLimit > 0) {
  console.warn(
    `[prepare-memory-hub] ⚠ Windows 路径长度：${overLimit} 个文件在默认安装路径下` +
      `可能超过 ${MAX_PATH} 字符（最长相对 ${maxRelative}）。若安装失败请装到更浅的目录。`,
  );
}
if (overLimitUpdate > 0) {
  // 升级场景必须 fail-loud：它不会立刻暴露，而是在用户「重启并安装」时才以
  // 「Failed to uninstall old application files」的形式爆发（真实事故形态）
  console.error(
    `[prepare-memory-hub] ❌ Windows 升级路径超限：${overLimitUpdate} 个文件在升级时` +
      `（$PLUGINSDIR\\old-install 前缀 ${UPDATE_MODE_EXTRA_PREFIX}）会超过 ${MAX_PATH} 字符` +
      `（最长相对 ${maxRelative} → ${updateTotal}）。` +
      '这会让 NSIS 卸载器 Abort 并阻断用户升级。请收紧依赖目录名长度' +
      '（virtualStoreDirMaxLength）或裁掉更深层的文件。',
  );
  process.exit(1);
}
if (overLimit === 0 && overLimitUpdate === 0) {
  console.log(
    `[prepare-memory-hub] 路径长度检查通过（最长相对 ${maxRelative}；全新安装 ` +
      `${installTotal} ≤ ${MAX_PATH}；升级 ${updateTotal} ≤ ${MAX_PATH}）`,
  );
}

// 7. 摘要
const sizeMb = dirSizeMb(TARGET);
const files = countFiles(TARGET);
console.log(`[prepare-memory-hub] 完成 → ${TARGET}（${sizeMb} MB，${files} 个文件）`);
