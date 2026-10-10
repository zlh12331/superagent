import { existsSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const RELEASE_DIR = join(ROOT, 'release');

/**
 * 引擎运行必需的关键依赖（裁掉任一即启动失败；作为裁剪误伤的哨兵）
 *
 * ⚠️ 2026-10-05 bundle 架构后收缩：非 external 的依赖已全部打进
 * `dist/gateway/server.js` 单文件（含引擎自有包 tcvdb-text），node_modules 只保留
 * **external 的原生绑定子树**——哨兵只列这些（native .node 无法打进 bundle）。
 * `tsx` 已随 dist 方案退役（打包产物为纯 JS，无需 TS loader），从哨兵移除。
 */
const REQUIRED_ENGINE_DEPS: readonly string[] = [
  '@node-rs/jieba',
  '@reflink/reflink',
  'sqlite-vec',
];

/** 定位 electron-builder 的 unpacked 目录（跨平台） */
function findUnpackedDirs(): string[] {
  if (!existsSync(RELEASE_DIR)) return [];
  const candidates = readdirSync(RELEASE_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => name.includes('unpacked') || name.startsWith('mac'));
  return candidates.map((name) => join(RELEASE_DIR, name));
}

/**
 * 在 unpacked 目录下解析 resources/memory-hub 的实际路径
 *
 * 布局差异（故不能只认一种）：
 * - Windows/Linux：`<dir>/resources/memory-hub`
 * - macOS：`<dir>/<Product>.app/Contents/Resources/memory-hub`
 * 兜底：浅层递归搜索 `memory-hub` 目录名（限深度 4，覆盖 mac universal 等变体），
 *   避免因 electron-builder 布局微调而误判"缺引擎"阻塞发版。
 */
function resolveEngineDirs(unpackedDir: string): string[] {
  const found: string[] = [];
  const direct = join(unpackedDir, 'resources', 'memory-hub');
  if (existsSync(direct)) found.push(direct);

  const walk = (dir: string, depth: number): void => {
    if (depth > 4 || found.length > 0) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const full = join(dir, entry.name);
      if (entry.name === 'memory-hub') {
        found.push(full);
        return;
      }
      if (
        entry.name.endsWith('.app') ||
        entry.name === 'Contents' ||
        entry.name === 'Resources' ||
        entry.name.endsWith('-unpacked') ||
        entry.name.startsWith('mac')
      ) {
        walk(full, depth + 1);
      }
    }
  };
  walk(unpackedDir, 0);
  return found;
}

/** 列出 unpacked 目录下的 resources 候选路径（失败诊断用，尤其 macOS 未实测路径） */
function listResourcesCandidates(unpackedDir: string): string[] {
  const out: string[] = [];
  try {
    for (const entry of readdirSync(unpackedDir, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name === 'resources') {
        out.push(`${unpackedDir.replace(ROOT, '.')}/resources`);
      }
      if (entry.isDirectory() && entry.name.endsWith('.app')) {
        out.push(`${unpackedDir.replace(ROOT, '.')}/${entry.name}/Contents/Resources`);
      }
    }
  } catch {}
  return out;
}

interface CheckResult {
  readonly ok: boolean;
  readonly detail: string;
}

/** 校验单个引擎目录 */
function checkEngineDir(dir: string): CheckResult[] {
  const results: CheckResult[] = [];

  const distEntry = join(dir, 'dist', 'gateway', 'server.js');
  const srcEntry = join(dir, 'src', 'gateway', 'server.ts');
  results.push({
    ok: existsSync(distEntry) || existsSync(srcEntry),
    detail: existsSync(distEntry)
      ? '引擎入口（dist/gateway/server.js）'
      : existsSync(srcEntry)
        ? '引擎入口（src/gateway/server.ts）'
        : '引擎入口缺失（dist/gateway/server.js 与 src/gateway/server.ts 均不存在）',
  });

  if (existsSync(distEntry)) {
    const registryJson = join(dir, 'dist', 'gateway', 'metadata_config_params.json');
    results.push({
      ok: existsSync(registryJson),
      detail: existsSync(registryJson)
        ? '数据文件 dist/gateway/metadata_config_params.json（param-registry 默认注册表）'
        : '数据文件缺失 dist/gateway/metadata_config_params.json——打包版 ConfigParamService 必然静默失败',
    });
    const dataDir = join(dir, 'dist', 'data');
    const dataOk = existsSync(dataDir) && readdirSync(dataDir).length > 0;
    results.push({
      ok: dataOk,
      detail: dataOk
        ? '数据目录 dist/data（tcvdb-text 词典/BM25 数据）'
        : '数据目录缺失或为空 dist/data——BM25 分词必然 ENOENT（#92 同类）',
    });
  }

  results.push({
    ok: existsSync(join(dir, 'node_modules')),
    detail: 'node_modules（引擎依赖）',
  });

  results.push({
    ok: !existsSync(join(dir, '.memory-hub-placeholder')),
    detail: '非占位目录（.memory-hub-placeholder 不存在）',
  });

  for (const dep of REQUIRED_ENGINE_DEPS) {
    results.push({
      ok: existsSync(join(dir, 'node_modules', dep)),
      detail: `关键依赖 ${dep}`,
    });
  }

  return results;
}

/** 当前平台对应的 unpacked 目录名前缀（判定"缺失是否算失败"） */
function currentPlatformDirPrefix(): string {
  if (process.platform === 'win32') return 'win-';
  if (process.platform === 'darwin') return 'mac';
  return 'linux-';
}

function main(): void {
  const unpackedDirs = findUnpackedDirs();
  if (unpackedDirs.length === 0) {
    console.error(
      '[check-packaged-engine] ❌ 未找到打包输出目录（release/*-unpacked 或 release/mac*）',
    );
    console.error('  请先执行打包（pnpm build:win / build:mac / build:linux）再运行本检查。');
    process.exit(1);
  }

  let failed = false;
  let checked = 0;
  const prefix = currentPlatformDirPrefix();
  const platformDirs = unpackedDirs.filter((p) => basename(p).startsWith(prefix));
  const skipped = unpackedDirs.filter((p) => !basename(p).startsWith(prefix));
  for (const p of skipped) {
    console.log(
      `[check-packaged-engine] ⏭ 跳过他平台产物 ${p.replace(ROOT, '.')}（当前平台前缀 ${prefix}）`,
    );
  }
  if (platformDirs.length === 0) {
    console.error(
      `[check-packaged-engine] ❌ 未找到当前平台（${process.platform}，前缀 ${prefix}）的 unpacked 目录`,
    );
    console.error(
      `  已发现：${unpackedDirs.map((p) => p.replace(ROOT, '.')).join(', ') || '(无)'}`,
    );
    process.exit(1);
  }

  for (const unpacked of platformDirs) {
    const engineDirs = resolveEngineDirs(unpacked);
    if (engineDirs.length === 0) {
      const resourcesPath = listResourcesCandidates(unpacked);
      console.error(`[check-packaged-engine] ❌ ${unpacked} 下未找到 resources/memory-hub`);
      console.error(`  候选路径探测：${resourcesPath.join(' | ') || '(未发现 resources 目录)'}`);
      failed = true;
      continue;
    }
    for (const engineDir of engineDirs) {
      checked += 1;
      const results = checkEngineDir(engineDir);
      const bad = results.filter((r) => !r.ok);
      if (bad.length === 0) {
        console.log(
          `[check-packaged-engine] ✅ ${engineDir.replace(ROOT, '.')}（${results.length} 项检查通过）`,
        );
      } else {
        failed = true;
        console.error(`[check-packaged-engine] ❌ ${engineDir.replace(ROOT, '.')}`);
        for (const item of bad) console.error(`   ✗ ${item.detail}`);
      }
    }
  }

  if (failed) {
    console.error(
      '\n[check-packaged-engine] 安装包缺少可运行的记忆引擎——' +
        '这类产物会让用户在运行时静默降级（记忆功能不可用）。',
    );
    console.error('  排查：prepare-memory-hub.mjs 是否成功、裁剪逻辑是否误删必需依赖。');
    process.exit(1);
  }
  console.log(`[check-packaged-engine] ✅ 全部通过（检查 ${checked} 个引擎目录）`);
}

main();
