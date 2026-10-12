// scripts/lib/changelog-polish.ts
// CHANGELOG 润色判定（纯逻辑，check-changelog-polish / changelog-draft 共用）。
// 背景：release-please 按 commit 粒度产出 CHANGELOG，squash 合并后 PR 内的子提交
// 明细全部丢失（只留标题）⇒「合并 Release PR 前人工润色为面向用户文案」是必需
// 步骤（RELEASING.md），但此前无机制看守、漏做无人发现——放行标记 + 分段判定成闸

/** 显式放行标记：写在版本段内即视为已确认（GitHub 渲染不可见） */
export const POLISH_MARKER = '<!-- changelog:polished -->';

/** 版本段：`## [x.y.z]` 标题行起，至下一个 `## ` 标题行之前 */
export interface VersionSection {
  readonly version: string;
  /** 段起始行号（0 基，指向 `## ` 标题行） */
  readonly startLine: number;
  /** 段结束行号（0 基，不含该行） */
  readonly endLine: number;
}

/** 版本标题：`## [1.2.3](…)` 或 `## 1.2.3 (2026-01-01)`（含 prerelease 后缀） */
const VERSION_HEADING = /^##\s+\[?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\]?/;

/** 机器原文的 bullet 结尾：`([abc1234](…/commit/abc1234))` */
const MACHINE_BULLET_TAIL = /\(\[[0-9a-f]{7,40}\]\([^)]*\/commit\/[0-9a-f]{7,40}\)\)\s*$/;

/** bullet 行（允许缩进，`-` 或 `*` 起头） */
const BULLET = /^\s*[-*]\s+\S/;

/**
 * 解析 Markdown 中全部版本段及其行区间
 *
 * 行号用于让调用方按需截取原文（含标题行），也便于定位报错位置。
 */
export function parseVersionSections(markdown: string): VersionSection[] {
  const lines = markdown.split('\n');
  const heads: Array<{ readonly version: string; readonly line: number }> = [];
  for (let index = 0; index < lines.length; index += 1) {
    const matched = (lines[index] ?? '').match(VERSION_HEADING);
    if (matched?.[1] !== undefined) {
      heads.push({ version: matched[1], line: index });
    }
  }
  return heads.map((head, index) => {
    const next = heads[index + 1];
    return {
      version: head.version,
      startLine: head.line,
      endLine: next === undefined ? lines.length : next.line,
    };
  });
}

/** 取出某版本段的原文（含标题行，不含下一段的标题行） */
export function sectionText(markdown: string, section: VersionSection): string {
  return markdown.split('\n').slice(section.startLine, section.endLine).join('\n');
}

/**
 * 该版本段是否仍是机器原文
 *
 * 无 bullet 的段返回 false（没有可判定内容，不误报为「未润色」）。
 */
export function isMachineGenerated(sectionBody: string): boolean {
  const bullets = sectionBody.split('\n').filter((line) => BULLET.test(line));
  if (bullets.length === 0) {
    return false;
  }
  return bullets.every((line) => MACHINE_BULLET_TAIL.test(line));
}

/** 段内是否写了显式放行标记 */
export function hasPolishedMarker(sectionBody: string): boolean {
  return sectionBody.includes(POLISH_MARKER);
}

/** 该版本段是否仍需润色（机器原文且未标注放行） */
export function needsPolish(sectionBody: string): boolean {
  if (hasPolishedMarker(sectionBody)) {
    return false;
  }
  return isMachineGenerated(sectionBody);
}
