// scripts/check-schema-drift.ts
// schema.ts ↔ drizzle/ 迁移一致性闸：① 漂移（改了 schema 没跑 drizzle-kit generate）
// ② 快照链完整性（drizzle-kit check）
// 判据与提交状态无关：跑 generate 前后对比 drizzle/ 文件集合，出新文件即漂移。
// 不用 `git diff --quiet -- drizzle/`（原 CI 实现）——本地「已 generate 未提交」必然
// 误报；且 git diff 只看已跟踪文件、漏检新增迁移（CI 生效全靠 _journal.json 恰好
// 被改的间接信号）。漂移时保留已生成的迁移文件（它们就是修复物），提示提交

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
