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

if (skipIfExists && targetReady) {
  console.log(`[prepare-memory-hub] 目标已就绪，跳过（${TARGET}）`);
  process.exit(0);
}

rmSync(TARGET, { recursive: true, force: true });
mkdirSync(TARGET, { recursive: true });

const COPY_FILES = ['package.json', 'pnpm-lock.yaml'];
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

console.log('[prepare-memory-hub] 在目标目录安装生产依赖（--ignore-scripts）…');
writeFileSync(
  join(TARGET, 'pnpm-workspace.yaml'),
  'packages: []\n' +
    'supportedArchitectures:\n  os:\n    - current\n  cpu:\n' +
    targetArchs.map((a) => `    - ${a}\n`).join('') +
    'virtualStoreDirMaxLength: 24\n' +
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
if (!existsSync(join(DIST_DIR, 'gateway', 'server.js'))) {
  console.error('[prepare-memory-hub] ❌ 编译产物缺 dist/gateway/server.js（入口校验失败）');
  process.exit(1);
}

const REGISTRY_JSON_SRC = join(SRC_DIR, 'metadata', 'config', 'metadata_config_params.json');
if (!existsSync(REGISTRY_JSON_SRC)) {
  console.error(
    `[prepare-memory-hub] ❌ 缺 ${REGISTRY_JSON_SRC}` +
      '（上游目录结构变化？loadDefaultRegistry 在打包版必然失败）',
  );
  process.exit(1);
}
try {
  JSON.parse(readFileSync(REGISTRY_JSON_SRC, 'utf8'));
} catch (err) {
  console.error(
    `[prepare-memory-hub] ❌ metadata_config_params.json 不是合法 JSON：${err.message}`,
  );
  process.exit(1);
}
const REGISTRY_JSON_DEST = join(DIST_DIR, 'gateway', 'metadata_config_params.json');
cpSync(REGISTRY_JSON_SRC, REGISTRY_JSON_DEST);
console.log('[prepare-memory-hub] 已补拷 metadata_config_params.json → dist/gateway/');

rmSync(SRC_DIR, { recursive: true, force: true });
console.log(
  '[prepare-memory-hub] 已 bundle src/gateway/server.ts → dist/（入口校验通过，src 已移除）',
);

const BUNDLED_DATA_PKGS = ['@tencentdb-agent-memory/tcvdb-text'];
for (const name of BUNDLED_DATA_PKGS) {
  const real = realpathSync(join(TARGET, 'node_modules', name));
  const dataSrc = join(real, 'data');
  const dataDest = join(DIST_DIR, 'data');
  if (existsSync(dataSrc)) {
    mkdirSync(dataDest, { recursive: true });
    for (const entry of readdirSync(dataSrc, { withFileTypes: true })) {
      const src = join(dataSrc, entry.name);
      const dest = join(dataDest, entry.name);
      if (entry.isFile() && entry.name.endsWith('.json')) {
        try {
          const parsed = JSON.parse(readFileSync(src, 'utf8'));
          writeFileSync(dest, JSON.stringify(parsed), 'utf8');
          continue;
        } catch {}
      }
      cpSync(src, dest, { recursive: true });
    }
    console.log(`[prepare-memory-hub] 已补拷 ${name} data/ → dist/data/（JSON 已 minify）`);
  } else {
    console.error(`[prepare-memory-hub] ❌ ${name} 缺 data/ 目录（stopwords/BM25 词典缺失）`);
    process.exit(1);
  }
}

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
  const index = new Map();
  for (const entry of readdirSync(PNPM_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'node_modules') continue;
    const ownName = parseOwnPackageName(entry.name);
    if (ownName === null) {
      console.warn(`[prepare-memory-hub] ⚠️ 无法识别实体自身包名，跳过：${entry.name}`);
      continue;
    }
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
  const queue = [...BUNDLE_EXTERNAL];

  while (queue.length > 0) {
    const name = queue.pop();
    if (name === undefined || keepNames.has(name)) continue;
    keepNames.add(name);
    const entries = index.get(name);
    if (entries === undefined) continue;
    for (const entryName of entries) {
      if (keepEntries.has(entryName)) continue;
      keepEntries.add(entryName);
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

  const allEntries = readdirSync(PNPM_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== 'node_modules')
    .map((e) => e.name);
  const doomed = allEntries.filter((name) => !keepEntries.has(name));

  console.log(
    `[prepare-memory-hub] 依赖可达性分析：保留 ${keepEntries.size} 个实体，孤儿 ${doomed.length} 个`,
  );

  let prunedMb = 0;
  for (const name of doomed) {
    try {
      const size = dirSizeMb(join(PNPM_DIR, name));
      rmSync(join(PNPM_DIR, name), { recursive: true, force: true });
      prunedMb += Number(size);
    } catch {}
  }

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
        if (!existsSync(p)) {
          try {
            unlinkSync(p);
            brokenLinks += 1;
          } catch {}
        }
        continue;
      }
      if (st.isDirectory()) {
        sweepBrokenLinks(p, depth + 1);
      }
    }
  };
  sweepBrokenLinks(join(TARGET, 'node_modules'), 0);
  sweepBrokenLinks(join(PNPM_DIR, 'node_modules'), 1);

  if (prunedMb > 0) {
    console.log(
      `[prepare-memory-hub] 已清理孤儿依赖 ~${prunedMb.toFixed(0)} MB` +
        `${brokenLinks > 0 ? ` + ${brokenLinks} 个断链` : ''}`,
    );
  }
}

const NM_DIR = join(TARGET, 'node_modules');
const PRIVATE_DIR = join(NM_DIR, '.pnpm');
if (existsSync(PRIVATE_DIR)) {
  const relink = [];
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
        continue;
      }
      if (real !== resolve(p)) {
        unlinkSync(p);
        relink.push([p, real]);
        continue;
      }
      if (entry.isDirectory() && entry.name.startsWith('@') && depth === 0) {
        collectLinks(p, depth + 1);
      }
    }
  };
  collectLinks(NM_DIR, 0);
  for (const [p, real] of relink) {
    cpSync(real, p, { recursive: true });
  }
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
    } catch {}
  }
};
stripUselessFiles(TARGET);
if (removedUseless > 0) {
  console.log(
    `[prepare-memory-hub] 已清理运行期无用文件 ${removedUseless} 个（sourcemap/类型声明）` +
      ` ~${(removedBytes / 1048576).toFixed(1)} MB——同时缓解 Windows 路径长度限制`,
  );
}

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
      } catch {}
    }
  }
}
if (bm25TrimmedFiles > 0) {
  console.log(
    `[prepare-memory-hub] 已无损压缩 BM25 词典 ${bm25TrimmedFiles} 个` +
      ` ~${(bm25SavedBytes / 1048576).toFixed(1)} MB（语义等价 minify，键值不变）`,
  );
}

const PLATFORM_SUFFIX_PATTERNS = [/-(darwin|linux|win|bsd|unsupported)\.(js|mjs|cjs)$/];
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
    if (!p.includes(`${sep}@opentelemetry${sep}`)) continue;
    for (const pattern of PLATFORM_SUFFIX_PATTERNS) {
      const m = pattern.exec(ent.name);
      if (m === null) continue;
      const tag = m[1];
      if (tag !== undefined && !CURRENT_PLATFORM_TAGS.has(tag)) {
        try {
          rmSync(p, { force: true });
          removedCrossPlatform += 1;
        } catch {}
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
const ASSUMED_INSTALL_PREFIX = 59;
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
    const relLen = p.length - ROOT.length;
    if (relLen > maxRelative) maxRelative = relLen;
    if (relLen + ASSUMED_INSTALL_PREFIX > MAX_PATH) overLimit += 1;
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

const sizeMb = dirSizeMb(TARGET);
const files = countFiles(TARGET);
console.log(`[prepare-memory-hub] 完成 → ${TARGET}（${sizeMb} MB，${files} 个文件）`);
