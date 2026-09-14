// scripts/check-memory-engine-integrity.mjs
// 记忆引擎 vendored 源码完整性校验（接 check:static）
// ──────────────────────────────────────────────────────────────
// 目的：packages/memory-engine/MemoryCore 是第三方源码（vendored 上游），
//   任何直接修改都会让"上游改了什么"与"我们改了什么"混在一起。
//   本脚本比对源码树与 versions.json 锚点记录，发现手改即失败，
//   强制走 patches/ 补丁通道（见 packages/memory-engine/patches/README.md）。
//
// 校验方式：对源码树（MemoryCore/src + package.json + pnpm-lock.yaml）
//   计算聚合 sha256，与 memory-engine.lock.json 中记录比对。
//
// 用法：
//   node scripts/check-memory-engine-integrity.mjs
//   node scripts/check-memory-engine-integrity.mjs --update   # 重新生成记录（仅 sync 后使用）
// ──────────────────────────────────────────────────────────────

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = process.cwd();
const ENGINE_DIR = join(ROOT, 'packages', 'memory-engine');
const SOURCE_DIR = join(ENGINE_DIR, 'MemoryCore');
const VERSIONS_PATH = join(ENGINE_DIR, 'versions.json');
const LOCK_PATH = join(ENGINE_DIR, 'integrity.lock.json');

/** 参与校验的路径（相对 MemoryCore）：运行必需的源码与依赖声明 */
const TRACKED = ['src', 'package.json', 'pnpm-lock.yaml'];

/** 这些文件由构建脚本主动改写/精简，不参与校验（内容随构建变化） */
const IGNORED_BASENAMES = new Set(['pnpm-workspace.yaml']);

/** 递归收集文件（相对路径，正斜杠归一，排序保证确定性） */
function collectFiles(absDir) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
      } else if (entry.isFile() && !IGNORED_BASENAMES.has(entry.name)) {
        out.push(abs);
      }
    }
  };
  if (existsSync(absDir)) walk(absDir);
  return out;
}

/** 计算聚合哈希：逐文件 sha256 汇总（路径 + 内容，排序后），避免单文件拼接口径歧义 */
function computeTreeHash() {
  const files = [];
  for (const rel of TRACKED) {
    const abs = join(SOURCE_DIR, rel);
    if (!existsSync(abs)) continue;
    if (statSync(abs).isDirectory()) {
      files.push(...collectFiles(abs));
    } else {
      files.push(abs);
    }
  }
  files.sort((a, b) => relative(SOURCE_DIR, a).localeCompare(relative(SOURCE_DIR, b)));
  const agg = createHash('sha256');
  for (const file of files) {
    const rel = relative(SOURCE_DIR, file).split(sep).join('/');
    const fileHash = createHash('sha256').update(readFileSync(file)).digest('hex');
    agg.update(`${rel}:${fileHash}\n`);
  }
  return { hash: agg.digest('hex'), fileCount: files.length };
}

function main() {
  const update = process.argv.includes('--update');

  if (!existsSync(SOURCE_DIR)) {
    console.error(`[memory-engine:integrity] 源码目录不存在：${SOURCE_DIR}`);
    process.exit(1);
  }
  if (!existsSync(VERSIONS_PATH)) {
    console.error(`[memory-engine:integrity] 版本锚点缺失：${VERSIONS_PATH}`);
    process.exit(1);
  }

  const versions = JSON.parse(readFileSync(VERSIONS_PATH, 'utf8'));
  const { hash, fileCount } = computeTreeHash();

  if (update) {
    const payload = {
      $comment:
        '记忆引擎源码树完整性记录（由 memory-engine:integrity --update 生成）。' +
        '手改 MemoryCore/ 下任何文件都会使校验失败——要改请走 patches/ 补丁通道。',
      repoTag: versions.repoTag,
      commit: versions.commit,
      treeHash: hash,
      fileCount,
    };
    writeFileSync(LOCK_PATH, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    console.log(
      `[memory-engine:integrity] 记录已更新：${fileCount} 个文件 / ${hash.slice(0, 16)}…（tag ${versions.repoTag}）`,
    );
    return;
  }

  if (!existsSync(LOCK_PATH)) {
    console.error('[memory-engine:integrity] ❌ 缺少完整性记录 integrity.lock.json');
    console.error('  首次建立或同步上游后，请运行：pnpm memory-engine:integrity --update');
    process.exit(1);
  }

  const lock = JSON.parse(readFileSync(LOCK_PATH, 'utf8'));
  if (lock.treeHash !== hash) {
    console.error('[memory-engine:integrity] ❌ vendored 源码与记录不一致（疑似被直接修改）');
    console.error(`  记录：${lock.treeHash}（${lock.fileCount} 文件，tag ${lock.repoTag}）`);
    console.error(`  实际：${hash}（${fileCount} 文件）`);
    console.error('  MemoryCore/ 是第三方源码，禁止直接修改。');
    console.error('  需要改动时请走补丁通道：packages/memory-engine/patches/README.md');
    console.error('  若是刚同步完上游，请运行：pnpm memory-engine:integrity --update');
    process.exit(1);
  }
  if (lock.repoTag !== versions.repoTag || lock.commit !== versions.commit) {
    console.error('[memory-engine:integrity] ❌ 完整性记录与 versions.json 的版本锚点不一致');
    console.error(`  versions.json: ${versions.repoTag} @ ${versions.commit}`);
    console.error(`  integrity.lock: ${lock.repoTag} @ ${lock.commit}`);
    console.error('  同步上游后请重新生成：pnpm memory-engine:integrity --update');
    process.exit(1);
  }

  console.log(
    `[memory-engine:integrity] ✅ 通过：${fileCount} 个文件与记录一致（tag ${versions.repoTag}）`,
  );
}

main();
