// scripts/check-packaged-engine.ts
// 安装包记忆引擎断言（防"发布缺引擎的包"事故复发）
// ──────────────────────────────────────────────────────────────
// 背景（2026-09-12 发现的事故）：记忆引擎源码先前未入仓，CI 构建拿不到上游 →
//   prepare-memory-hub.mjs 生成**占位目录**并 exit 0 → 打包"成功"但产物不含引擎，
//   而 README 承诺了该功能。用户下载到的安装包运行时静默降级为空实现。
//
// 本脚本把"最终打包产物里真的有可运行的引擎"变成机器闸，检查 electron-builder
//   输出目录（win-unpacked / linux-unpacked / mac*/**.app）下的 resources/memory-hub：
//   1. 目录存在（不是完全缺失）
//   2. 引擎入口 src/gateway/server.ts（或 dist/gateway/server.js）在位
//   3. node_modules 已安装（engine 以 tsx 直跑源码，依赖必须随包）
//   4. 无占位标记文件（历史占位目录的识别物）
//   5. 关键运行依赖存在（防裁剪逻辑误删必需包——此前可达性分析曾误判）
//
// 产物不存在时**失败**（在 CI 打包后运行；本地产物缺失说明未先打包）。
// ──────────────────────────────────────────────────────────────

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const RELEASE_DIR = join(ROOT, 'release');

/** 引擎运行必需的关键依赖（裁掉任一即启动失败；作为裁剪误伤的哨兵） */
const REQUIRED_ENGINE_DEPS: readonly string[] = [
  '@node-rs/jieba', // 中文分词（FTS5 索引依赖）
  '@tencentdb-agent-memory/tcvdb-text', // 引擎自有包
  'tsx', // TS 直跑 loader（打包产物为 JS 后可由 dist 分支取代）
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

/** 在 unpacked 目录下解析 resources/memory-hub 的实际路径（macOS 在 .app 内） */
function resolveEngineDirs(unpackedDir: string): string[] {
  const direct = join(unpackedDir, 'resources', 'memory-hub');
  const found: string[] = [];
  if (existsSync(direct)) found.push(direct);
  // macOS：<dir>/<Product>.app/Contents/Resources/memory-hub
  try {
    for (const entry of readdirSync(unpackedDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.endsWith('.app')) continue;
      const macPath = join(unpackedDir, entry.name, 'Contents', 'Resources', 'memory-hub');
      if (existsSync(macPath)) found.push(macPath);
    }
  } catch {
    // 忽略读取失败（无 .app 属正常）
  }
  return found;
}

interface CheckResult {
  readonly ok: boolean;
  readonly detail: string;
}

/** 校验单个引擎目录 */
function checkEngineDir(dir: string): CheckResult[] {
  const results: CheckResult[] = [];

  // 1. 入口文件（优先 dist，回退 TS 源码——与 MemoryHubService.resolveEntry 一致）
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

  // 2. node_modules 已安装
  results.push({
    ok: existsSync(join(dir, 'node_modules')),
    detail: 'node_modules（引擎依赖）',
  });

  // 3. 无占位标记（历史占位目录的识别物）
  results.push({
    ok: !existsSync(join(dir, '.memory-hub-placeholder')),
    detail: '非占位目录（.memory-hub-placeholder 不存在）',
  });

  // 4. 关键运行依赖（裁剪误伤哨兵）
  for (const dep of REQUIRED_ENGINE_DEPS) {
    results.push({
      ok: existsSync(join(dir, 'node_modules', dep)),
      detail: `关键依赖 ${dep}`,
    });
  }

  return results;
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

  for (const unpacked of unpackedDirs) {
    const engineDirs = resolveEngineDirs(unpacked);
    if (engineDirs.length === 0) {
      console.error(`[check-packaged-engine] ❌ ${unpacked} 下未找到 resources/memory-hub`);
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
