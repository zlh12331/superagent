// scripts/lib/commit-header.ts
// 提交标题的严格结构校验（Conventional Commits，无冗余字符）
// ──────────────────────────────────────────────────────────────
// 为什么自研（2026-09-20 实证缺口）：
//   commitlint 的 header 解析用**贪婪括号匹配**，`fix(autostart)+build(release): …`
//   会被解析成 type=fix、scope=`autostart)+build(release)`——于是只触发 scope-enum
//   （本仓库刻意设为 warning 级，不阻断）而放行。但 release-please 用严格
//   Conventional Commits 解析器，对该 header 直接抛 `unexpected token '+' at 1:15`
//   并**跳过该提交**；若它是版本区间内唯一提交 → 「0 commits」→ 不开 Release PR
//   （实测：PR #56 的 squash 标题写成双 type 后，v1.3.1 之后的发版通道静默阻断）。
//   且 commitlint 21.x **没有** header-pattern 规则（写入未知规则会直接抛错），
//   故以本模块 + commit-msg 钩子补齐这道闸门。
//
// 校验口径：header 必须**恰好**匹配 `type(scope)!: subject`
// - type ∈ 白名单（与 commitlint.config.js 的 type-enum 保持一致）
// - scope 可选，仅允许 [a-z0-9._-]（禁止括号、加号、空格等）
// - `!` 破坏性标记可选，必须紧贴 scope/type
// - 冒号后**必须**有一个空格，然后是非空 subject
// ──────────────────────────────────────────────────────────────

/** 允许的 type（须与 commitlint.config.js 的 type-enum 逐字一致） */
export const ALLOWED_TYPES = [
  'build',
  'chore',
  'ci',
  'docs',
  'feat',
  'fix',
  'perf',
  'refactor',
  'revert',
  'style',
  'test',
] as const;

/**
 * 严格 header 模式
 *
 * 与 commitlint 默认模式的差别：scope 用 `[a-z0-9._-]+` 而非 `.*`——
 * 后者会吞掉 `)+build(` 这类多余字符，使双 type 标题蒙混过关。
 */
export const STRICT_HEADER_PATTERN =
  /^(build|chore|ci|docs|feat|fix|perf|refactor|revert|style|test)(?:\(([a-z0-9][a-z0-9._-]*)\))?(!)?: (\S.*)$/;

/** 校验结果 */
export interface HeaderCheckResult {
  readonly ok: boolean;
  /** 失败原因（面向提交者的可执行提示） */
  readonly reason?: string;
}

/**
 * 校验提交标题（单行 header）
 *
 * @param header 提交信息首行（调用方已 trim 行尾空白）
 * @returns ok=false 时给出原因与修复指引
 */
export function checkCommitHeader(header: string): HeaderCheckResult {
  const trimmed = header.trim();
  if (trimmed === '') {
    return { ok: false, reason: '提交标题为空' };
  }
  // 合并提交（GitHub 的 "Merge branch ..."）不适用本规范：放行
  if (trimmed.startsWith('Merge ') || trimmed.startsWith('Revert "')) {
    return { ok: true };
  }
  // fixup!/squash! 等前缀由 git 生成，放行（rebase 中间态）
  if (/^(fixup|squash|amend)! /.test(trimmed)) {
    return { ok: true };
  }

  if (STRICT_HEADER_PATTERN.test(trimmed)) {
    return { ok: true };
  }

  // 给出针对性诊断：区分「双 type 拼接」这一最常见的真实事故
  if (/^[a-z]+\([^)]*\)\+\s*[a-z]+\(/i.test(trimmed)) {
    return {
      ok: false,
      reason:
        '标题含两个 type（形如 `fix(x)+build(y): …`）。' +
        'release-please 的严格解析器会拒绝该格式并跳过整个提交，导致发版通道阻断。' +
        '请只保留一个 type（其余改动写进正文）。',
    };
  }
  return {
    ok: false,
    reason:
      '标题不符合 Conventional Commits 严格格式：`type(scope)!: subject`。' +
      `type 须为 ${ALLOWED_TYPES.join(' / ')} 之一；scope 仅允许小写字母、数字与 ._-；` +
      '冒号后须有一个空格与内容。',
  };
}
