// scripts/check-schema-drift.ts
// schema.ts ↔ drizzle/ 迁移快照 一致性闸（数据层单一真源维度）
// ──────────────────────────────────────────────────────────────
// 校验两件事：
//   ① 漂移：schema.ts 改了但没跑 `drizzle-kit generate` 生成迁移
//   ② 快照链完整性：迁移快照自身的版本/父子 id 链无误（drizzle-kit check）
//
// 判据（与提交状态无关）：
//   先快照 drizzle/ 下的文件清单 → 跑 generate → 再快照 → 出现新文件即漂移。
//
// 为什么不用 `git diff --quiet -- drizzle/`（CI 原实现）：
//   1. **本地必然误报**：改了 schema.ts 并已 generate，只要还没提交就判定失败，
//      而本地开发中途跑 verify:local 正是这个状态。
//   2. **漏检未跟踪文件**：`git diff` 只看已跟踪文件，新增的迁移 `.sql` 与
//      `meta/*_snapshot.json` 都是未跟踪的。CI 上它之所以还能生效，靠的是
//      `meta/_journal.json`（已跟踪）被 generate 改动这一间接信号——一旦该文件
//      的写法变化，闸门就会静默失效。本实现直接看文件集合，不依赖这个巧合。
//
// 漂移时**保留**已生成的迁移文件（它们就是修复物），并提示提交。
// ──────────────────────────────────────────────────────────────

import { execSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/** 迁移目录（drizzle-kit 输出） */
export const DRIZZLE_DIR = 'drizzle';

/** 递归收集目录下所有文件的相对路径（POSIX 分隔符，排序） */
export function listFilesRecursive(root: string, dir: string = root): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listFilesRecursive(root, full));
    } else {
      out.push(relative(root, full).split(sep).join('/'));
    }
  }
  return out.sort();
}

function run(command: string): { ok: boolean; output: string } {
  try {
    return { ok: true, output: execSync(command, { stdio: 'pipe', encoding: 'utf8' }) };
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, output: `${e.stdout ?? ''}${e.stderr ?? ''}${e.message ?? ''}` };
  }
}

function main(): void {
  const before = new Set(listFilesRecursive(DRIZZLE_DIR));

  const gen = run('pnpm exec drizzle-kit generate');
  if (!gen.ok) {
    console.error('[check-schema-drift] ❌ drizzle-kit generate 执行失败：');
    console.error(gen.output.trim());
    process.exit(1);
  }

  const added = listFilesRecursive(DRIZZLE_DIR).filter((f) => !before.has(f));
  if (added.length > 0) {
    console.error('[check-schema-drift] ❌ schema.ts 与 drizzle/ 迁移不同步：');
    for (const f of added) {
      console.error(`  新增 ${f}`);
    }
    console.error('');
    console.error('  成因：改了 schema.ts 但没跑 generate（或 generate 产物未提交）。');
    console.error('  处置：检查上述新增迁移文件的内容，确认无误后一并提交。');
    console.error('  ⚠️ 生成物已保留在磁盘上，便于直接提交；不要手改其内容。');
    process.exit(1);
  }

  const check = run('pnpm exec drizzle-kit check');
  if (!check.ok) {
    console.error('[check-schema-drift] ❌ 迁移快照链校验失败（drizzle-kit check）：');
    console.error(check.output.trim());
    process.exit(1);
  }

  console.log('[check-schema-drift] ✅ 通过：schema.ts 与 drizzle/ 一致，快照链完整');
}

main();
