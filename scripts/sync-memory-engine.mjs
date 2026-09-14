// scripts/sync-memory-engine.mjs
// 记忆引擎上游同步（vendored 源码刷新）
// ──────────────────────────────────────────────────────────────
// 用途：把 packages/memory-engine/MemoryCore 更新到上游指定版本。
//
// ⚠️ 网络说明：本脚本**不直接访问 GitHub**。上游源码归档由人工/CI 预先取得
//   （本项目实测 codeload.github.com 在部分环境不可达），通过 --from 指定本地目录。
//   这样同步流程离线可用、可复现，且与"构建不依赖网络"的设计一致。
//
// 用法：
//   node scripts/sync-memory-engine.mjs --from <解压目录> --tag <tag> [--commit <sha>] [--dry-run]
//
// 参数：
//   --from    上游解压根目录（其下应有 MemoryCore/）
//   --tag     目标版本 tag（写入 versions.json）
//   --commit  目标 commit（可选；省略则保留现值并提示）
//   --dry-run 只显示将要发生的变更，不落盘
//
// 流程：
//   1. 校验来源目录含 MemoryCore/src/gateway/server.ts
//   2. 计算新旧源码差异摘要（文件数 / 变更文件数）
//   3. 检测本地是否有未登记的改动（integrity 校验）——有则拒绝同步并提示走 patches
//   4. 替换 MemoryCore/ → 更新 versions.json → 重放 patches/
//   5. 重新生成 integrity.lock.json
// ──────────────────────────────────────────────────────────────

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const ENGINE_DIR = join(ROOT, 'packages', 'memory-engine');
const CORE_TARGET = join(ENGINE_DIR, 'MemoryCore');
const PATCH_DIR = join(ENGINE_DIR, 'patches');
const VERSIONS_PATH = join(ENGINE_DIR, 'versions.json');

/** 解析命令行参数 */
function parseArgs(argv) {
  const out = { from: undefined, tag: undefined, commit: undefined, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--from') out.from = argv[++i];
    else if (a === '--tag') out.tag = argv[++i];
    else if (a === '--commit') out.commit = argv[++i];
  }
  return out;
}

function fail(msg) {
  console.error(`[memory-engine:sync] ❌ ${msg}`);
  process.exit(1);
}

/** 递归收集文件（相对路径） */
function listFiles(dir, base = dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) listFiles(p, base, acc);
    else if (e.isFile()) acc.push(p.slice(base.length + 1).replace(/\\/g, '/'));
  }
  return acc;
}

const args = parseArgs(process.argv.slice(2));
if (args.from === undefined || args.tag === undefined) {
  fail(
    '用法：node scripts/sync-memory-engine.mjs --from <解压目录> --tag <tag> [--commit <sha>] [--dry-run]',
  );
}

const sourceCore = join(args.from, 'MemoryCore');
if (!existsSync(join(sourceCore, 'src', 'gateway', 'server.ts'))) {
  fail(`来源目录不含 MemoryCore/src/gateway/server.ts：${sourceCore}`);
}

// 同步前校验：本地若已有未登记改动，先处理（否则会被本次覆盖而丢失）
const integrityCheck = spawnSync(
  process.execPath,
  [join(ROOT, 'scripts', 'check-memory-engine-integrity.mjs')],
  { encoding: 'utf8' },
);
if (integrityCheck.status !== 0) {
  console.error(integrityCheck.stdout);
  console.error(integrityCheck.stderr);
  fail(
    '当前 vendored 源码与完整性记录不一致——请先处理（若是有意改动，走 patches/ 通道；' +
      '若是同步残留，运行 pnpm memory-engine:integrity --update）',
  );
}

const currentVersions = JSON.parse(readFileSync(VERSIONS_PATH, 'utf8'));

// 差异摘要
const oldFiles = listFiles(CORE_TARGET);
const newFiles = listFiles(sourceCore);
const oldSet = new Set(oldFiles);
const newSet = new Set(newFiles);
const added = newFiles.filter((f) => !oldSet.has(f));
const removed = oldFiles.filter((f) => !newSet.has(f));

console.log('[memory-engine:sync] 版本变更');
console.log(`  当前：${currentVersions.repoTag} @ ${currentVersions.commit.slice(0, 12)}`);
console.log(`  目标：${args.tag}${args.commit ? ` @ ${args.commit.slice(0, 12)}` : ''}`);
console.log('[memory-engine:sync] 源码差异');
console.log(`  文件数：${oldFiles.length} → ${newFiles.length}`);
console.log(
  `  新增：${added.length} 个${added.length ? `（如 ${added.slice(0, 5).join(', ')}）` : ''}`,
);
console.log(
  `  移除：${removed.length} 个${removed.length ? `（如 ${removed.slice(0, 5).join(', ')}）` : ''}`,
);

// 补丁预告
const patches = existsSync(PATCH_DIR)
  ? readdirSync(PATCH_DIR)
      .filter((f) => f.endsWith('.patch'))
      .sort()
  : [];
console.log(
  `[memory-engine:sync] 待重放补丁：${patches.length} 个${patches.length ? `（${patches.join(', ')}）` : ''}`,
);

if (args.dryRun) {
  console.log('\n[memory-engine:sync] --dry-run：未做任何修改');
  process.exit(0);
}

// 执行替换（事务性：先复制到临时目录，成功后再切换，避免失败留下空目录）
// 注：Node 的 cpSync 在部分 Windows 环境复制大型源码树时会静默崩溃
//   （实测：复制上游 src/adapters 时进程无异常退出，文件数为 0），
//   因此改用平台原生复制工具（Windows robocopy / POSIX cp -R）。
console.log('\n[memory-engine:sync] 替换 MemoryCore …');
const staging = `${CORE_TARGET}.staging`;
rmSync(staging, { recursive: true, force: true });

const copyRes =
  process.platform === 'win32'
    ? spawnSync(
        'robocopy',
        [sourceCore, staging, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/R:2', '/W:1'],
        { encoding: 'utf8' },
      )
    : spawnSync('cp', ['-R', sourceCore, staging], { encoding: 'utf8' });

// robocopy 退出码：0-7 为成功（1=有复制, 2=有额外项, 4=有不匹配…）；>=8 为失败
const copyOk = process.platform === 'win32' ? (copyRes.status ?? 99) < 8 : copyRes.status === 0;
if (!copyOk) {
  console.error(copyRes.stdout ?? '');
  console.error(copyRes.stderr ?? '');
  rmSync(staging, { recursive: true, force: true });
  fail(`复制失败（退出码 ${copyRes.status}）——原目录未改动`);
}
const stagedCount = listFiles(staging).length;
if (stagedCount === 0) {
  rmSync(staging, { recursive: true, force: true });
  fail('暂存目录为空——复制未生效，原目录未改动');
}
console.log(`  暂存完成：${stagedCount} 个文件`);

// 切换（同卷 rename 是原子操作：先移走原目录，再把暂存目录改名就位；失败可回滚）
const backup = `${CORE_TARGET}.backup`;
rmSync(backup, { recursive: true, force: true });
const hadOriginal = existsSync(CORE_TARGET);
try {
  if (hadOriginal) {
    renameSync(CORE_TARGET, backup);
  }
  renameSync(staging, CORE_TARGET);
} catch (err) {
  // 回滚：把原目录放回
  if (hadOriginal && existsSync(backup) && !existsSync(CORE_TARGET)) {
    renameSync(backup, CORE_TARGET);
  }
  rmSync(staging, { recursive: true, force: true });
  fail(`目录切换失败（${err.code}）——已回滚至原版本`);
}
rmSync(backup, { recursive: true, force: true });

// 更新版本锚点（保留来源/许可等既有字段）
const corePkg = JSON.parse(readFileSync(join(CORE_TARGET, 'package.json'), 'utf8'));
const nextVersions = {
  ...currentVersions,
  repoTag: args.tag,
  commit: args.commit ?? currentVersions.commit,
  corePackageName: corePkg.name,
  corePackageVersion: corePkg.version,
  syncedAt: new Date().toISOString().slice(0, 10),
  ...(args.commit === undefined
    ? {
        $commitNote:
          '本次同步未提供 --commit，commit 字段保留旧值——请核对上游 tag 对应 commit 后手动更新',
      }
    : {}),
};
writeFileSync(VERSIONS_PATH, `${JSON.stringify(nextVersions, null, 2)}\n`, 'utf8');
console.log(
  `[memory-engine:sync] versions.json 已更新：${nextVersions.repoTag}（子包 ${nextVersions.corePackageVersion}）`,
);

// 重放补丁
if (patches.length > 0) {
  console.log('[memory-engine:sync] 重放补丁 …');
  for (const p of patches) {
    const res = spawnSync('git', ['apply', '--3way', join(PATCH_DIR, p)], {
      cwd: CORE_TARGET,
      encoding: 'utf8',
    });
    if (res.status !== 0) {
      console.error(res.stdout);
      console.error(res.stderr);
      fail(`补丁重放失败：${p}——上游可能改了同一处代码，请人工处理（补丁保留在原位）`);
    }
    console.log(`  ✓ ${p}`);
  }
}

// 重新生成完整性记录
const upd = spawnSync(
  process.execPath,
  [join(ROOT, 'scripts', 'check-memory-engine-integrity.mjs'), '--update'],
  { encoding: 'utf8' },
);
process.stdout.write(upd.stdout);

console.log(`
[memory-engine:sync] ✅ 同步完成

后续步骤：
  1. 核对配置兼容性：gateway.yaml 字段（server/data/llm/memory.recall/bm25）与
     adapter.ts 消费的端点（/health /capture /recall /search/* /v2/conversation/delete）
  2. 跑契约测试：MEMORY_HUB_ROOT=… pnpm test:main
  3. 复核差异：git diff --stat packages/memory-engine
  4. 提交：git commit -m "chore(memory): 同步上游 ${currentVersions.repoTag} → ${args.tag}"
`);
