// scripts/changelog/lib/parse.ts
// Conventional Commits 解析（纯函数，供 changelog 生成器使用）
// ──────────────────────────────────────────────────────────────
// 格式：type(scope)!: subject
// 分组规则（与 CHANGELOG 生成一致）：
// - feat → 新增；fix → 修复；perf → 性能
// - 破坏性变更（! 或 BREAKING CHANGE）→ 破坏性变更分组
// - 排除：docs/chore/style/test/refactor/build/ci（含 Renovate 的 chore(deps)）
// ──────────────────────────────────────────────────────────────

/** 解析后的提交信息 */
export interface ParsedCommit {
  /** commit hash（幂等去重用） */
  readonly hash: string;
  /** 提交类型（feat/fix/perf/docs/...） */
  readonly type: string;
  /** 可选 scope（如 update/file） */
  readonly scope: string | null;
  /** 是否破坏性变更 */
  readonly breaking: boolean;
  /** 用户可读描述（subject 去掉 type(scope)!: 前缀） */
  readonly description: string;
  /** 完整 subject */
  readonly subject: string;
}

/** 不进 CHANGELOG 的提交类型（开发内部细节） */
const EXCLUDED_TYPES = new Set(['docs', 'chore', 'style', 'test', 'refactor', 'build', 'ci']);

/** subject 正则：type(scope)!: description */
const SUBJECT_RE = /^(\w+)(?:\(([^)]+)\))?(!)?: (.+)$/;

/**
 * 解析单条 commit（hash + 完整 message）
 *
 * @param hash commit hash
 * @param message 完整 commit message（含 body，\n 分隔）
 * @returns 解析结果；无法解析的提交返回 null（不进入 CHANGELOG）
 */
export function parseCommit(hash: string, message: string): ParsedCommit | null {
  const lines = message.split('\n');
  const subject = lines[0]?.trim() ?? '';
  const body = lines.slice(1).join('\n');

  const match = SUBJECT_RE.exec(subject);
  if (match === null) {
    return null;
  }
  const [, type, scope, bang, description] = match;
  const breaking = bang === '!' || /BREAKING CHANGE/i.test(body);

  return {
    hash,
    type: type ?? '',
    scope: scope ?? null,
    breaking,
    description: description ?? '',
    subject,
  };
}

/** 是否应进入 CHANGELOG（排除开发内部类型） */
export function shouldInclude(commit: ParsedCommit): boolean {
  return !EXCLUDED_TYPES.has(commit.type);
}

/** CHANGELOG 分组键（新增/修复/性能/破坏性变更） */
export type ChangeGroup = 'feat' | 'fix' | 'perf' | 'breaking';

/** 提交 → 分组（破坏性变更优先，其次按类型） */
export function groupOf(commit: ParsedCommit): ChangeGroup | null {
  if (commit.breaking) {
    return 'breaking';
  }
  switch (commit.type) {
    case 'feat':
      return 'feat';
    case 'fix':
      return 'fix';
    case 'perf':
      return 'perf';
    default:
      return null;
  }
}

/** CHANGELOG 条目文本（scope 保留便于溯源，如 `update`: 接入自动更新） */
export function entryText(commit: ParsedCommit): string {
  const scopePrefix = commit.scope !== null ? `\`${commit.scope}\`：` : '';
  return `${scopePrefix}${commit.description}`;
}
