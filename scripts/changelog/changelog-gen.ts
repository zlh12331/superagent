// scripts/changelog/changelog-gen.ts
// CHANGELOG 自动生成器：从 Conventional Commits 生成 [Unreleased] 段
// ──────────────────────────────────────────────────────────────
// 用法：pnpm changelog
//
// 数据源：git log（自最近 v*.*.* tag 到 HEAD 的提交）
// - 幂等：Unreleased 段整段覆盖式生成（数据源是固定提交集合，重复运行结果一致）
// - 发版打 tag 后，下次生成自动从新 tag 开始（天然不重复）
//
// 分组规则（与 lib/parse.ts 一致）：
// - feat → 新增；fix → 修复；perf → 性能；breaking → 破坏性变更
// - 排除 docs/chore/style/test/refactor/build/ci（开发内部细节）
//
// 注意：Unreleased 段由本脚本全量生成，手动补充的条目会被覆盖；
// 需要手动补充的内容请写入版本段（如 [1.1.0]）或改用规范 commit 记录。
// ──────────────────────────────────────────────────────────────

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { type ChangeGroup, entryText, groupOf, parseCommit } from './lib/parse';

/** 仓库根（scripts/changelog/ → 根） */
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
/** CHANGELOG 文件路径 */
const CHANGELOG_PATH = path.join(REPO_ROOT, 'CHANGELOG.md');

/** 分组标题（Keep a Changelog 惯例） */
const GROUP_TITLES: Readonly<Record<ChangeGroup, string>> = {
  feat: '新增',
  fix: '修复',
  perf: '性能',
  breaking: '破坏性变更',
};

/** 执行 git 命令并返回 stdout（失败抛错；抑制 stderr 泄露） */
function git(args: readonly string[]): string {
  return execFileSync('git', args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

/** 获取最近版本 tag（无 tag 返回 null） */
function getLatestTag(): string | null {
  try {
    const tag = git(['describe', '--tags', '--abbrev=0']).trim();
    return tag.length > 0 ? tag : null;
  } catch {
    return null;
  }
}

/** 获取待解析提交（hash + 完整 message；%H%x00%B%x00 交替输出，成对消费） */
function getCommits(fromTag: string | null): ReadonlyArray<{ hash: string; message: string }> {
  const range = fromTag !== null ? `${fromTag}..HEAD` : 'HEAD';
  const raw = git(['log', '--format=%H%x00%B%x00', range]);
  const parts = raw.split('\x00');
  const records: Array<{ hash: string; message: string }> = [];
  // 交替结构：hash, message, hash, message, ...
  for (let i = 0; i < parts.length - 1; i += 2) {
    const hash = parts[i]?.trim();
    const message = parts[i + 1] ?? '';
    if (hash === undefined || hash === '') {
      continue;
    }
    records.push({ hash, message: message.trimEnd() });
  }
  return records;
}

/** 生成 [Unreleased] 段（Keep a Changelog 格式，空分组不输出） */
function buildUnreleasedSection(commits: ReadonlyArray<{ hash: string; message: string }>): string {
  const groups = new Map<ChangeGroup, string[]>();
  for (const record of commits) {
    const parsed = parseCommit(record.hash, record.message);
    if (parsed === null) {
      continue;
    }
    const group = groupOf(parsed);
    if (group === null) {
      continue;
    }
    const entries = groups.get(group) ?? [];
    entries.push(entryText(parsed));
    groups.set(group, entries);
  }

  const lines: string[] = ['## [Unreleased]'];
  for (const group of ['feat', 'fix', 'perf', 'breaking'] as const) {
    const entries = groups.get(group);
    if (entries === undefined || entries.length === 0) {
      continue;
    }
    lines.push('', `### ${GROUP_TITLES[group]}`, '');
    for (const entry of entries) {
      lines.push(`- ${entry}`);
    }
  }
  return lines.join('\n');
}

/** 替换 CHANGELOG 中的 [Unreleased] 段（无则插入文件头后） */
function updateChangelog(section: string): void {
  if (!existsSync(CHANGELOG_PATH)) {
    writeFileSync(CHANGELOG_PATH, `${section}\n`, 'utf8');
    return;
  }
  const source = readFileSync(CHANGELOG_PATH, 'utf8');
  // 匹配 ## [Unreleased] 段（到下一个 ## 标题或文件尾）
  const pattern = /^## \[Unreleased\][\s\S]*?(?=^## |z)/m;
  const updated = pattern.test(source)
    ? source.replace(pattern, `${section}\n\n`)
    : source.replace(/^(# .+\n)/, `$1\n${section}\n\n`);
  writeFileSync(CHANGELOG_PATH, updated, 'utf8');
}

/** 主流程 */
function main(): void {
  const tag = getLatestTag();
  const commits = getCommits(tag);
  if (commits.length === 0) {
    console.log(`[changelog] 无新提交（自 ${tag ?? '初始'}），跳过生成`);
    return;
  }
  const section = buildUnreleasedSection(commits);
  updateChangelog(section);
  const included = commits.filter((c) => {
    const parsed = parseCommit(c.hash, c.message);
    return parsed !== null && groupOf(parsed) !== null;
  }).length;
  console.log(
    `[changelog] 已生成 [Unreleased] 段：${commits.length} 个提交，${included} 条进入 CHANGELOG（${
      tag ?? '无 tag，全量'
    }）`,
  );
}

try {
  main();
} catch (error: unknown) {
  console.error(`[changelog] 失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
