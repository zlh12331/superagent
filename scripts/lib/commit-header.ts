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
  if (trimmed.startsWith('Merge ') || trimmed.startsWith('Revert "')) {
    return { ok: true };
  }
  if (/^(fixup|squash|amend)! /.test(trimmed)) {
    return { ok: true };
  }

  if (STRICT_HEADER_PATTERN.test(trimmed)) {
    return { ok: true };
  }

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
