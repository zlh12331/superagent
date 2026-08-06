// src/renderer/lib/diff/line-diff.ts
// 行级 diff 渲染数据（diff-match-patch 行编码，供 FileChangeCard 渲染）
// ──────────────────────────────────────────────────────────────
// 与 diff-stats.ts 的关系：
// - diff-stats：只统计增删行数（语义对齐，移动行不计）
// - 本文件：产出带类型的行列表（context/add/del），供 UI 逐行渲染
// 复用同一"行 → 字符编码"技巧（避免 checklines 短文本退化）
// ──────────────────────────────────────────────────────────────

import {
  DIFF_DELETE,
  DIFF_EQUAL,
  DIFF_INSERT,
  type Diff,
  diff_match_patch,
} from 'diff-match-patch';

/** diff 行类型 */
export type DiffLineType = 'context' | 'add' | 'del';

/** 行级 diff 结果行 */
export interface DiffLine {
  readonly type: DiffLineType;
  /** 行内容（不含 + / - 前缀） */
  readonly text: string;
}

/** 共享实例（diff_match_patch 无内部状态，可安全复用） */
const DMP = new diff_match_patch();

/**
 * 计算两段文本的行级 diff（LCS 语义对齐）
 *
 * @param oldText 变更前文本（空串 = 新建文件）
 * @param newText 变更后文本（空串 = 删除文件）
 * @returns 按顺序排列的行列表（context 在中间，add/del 围绕）
 *
 * @example
 * ```ts
 * computeLineDiff('a\nb', 'a\nc\nb')
 * // → [{ type: 'context', text: 'a' }, { type: 'add', text: 'c' }, { type: 'context', text: 'b' }]
 * ```
 */
export function computeLineDiff(oldText: string, newText: string): DiffLine[] {
  // 空文本边界：全量 add / 全量 del
  if (oldText === '') {
    return newText.split('\n').map((text) => ({ type: 'add' as const, text }));
  }
  if (newText === '') {
    return oldText.split('\n').map((text) => ({ type: 'del' as const, text }));
  }

  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');

  // 行 → 唯一字符编码（空间足够 65535 行）
  // lineMap：行内容 → 编码字符；charToLine：编码字符 → 行内容（decode 用反向映射）
  const lineMap = new Map<string, string>();
  const charToLine = new Map<string, string>();
  let code = 32;
  const encode = (lines: readonly string[]): string => {
    let out = '';
    for (const line of lines) {
      let c = lineMap.get(line);
      if (c === undefined) {
        c = String.fromCharCode(code);
        code += 1;
        lineMap.set(line, c);
        charToLine.set(c, line);
      }
      out += c;
    }
    return out;
  };

  const diffs: Diff[] = DMP.diff_main(encode(oldLines), encode(newLines), false);

  // 编码字符 → 原始行（反向映射保证 1:1）
  const decode = (chars: string): string[] => chars.split('').map((c) => charToLine.get(c) ?? '');

  const result: DiffLine[] = [];
  for (const [op, chars] of diffs) {
    if (op === DIFF_EQUAL) {
      for (const line of decode(chars)) {
        result.push({ type: 'context', text: line });
      }
    } else if (op === DIFF_INSERT) {
      for (const line of decode(chars)) {
        result.push({ type: 'add', text: line });
      }
    } else if (op === DIFF_DELETE) {
      for (const line of decode(chars)) {
        result.push({ type: 'del', text: line });
      }
    }
  }
  return result;
}

/** 统计 diff 行数（卡片头部徽标用） */
export function countDiffLines(lines: readonly DiffLine[]): {
  readonly additions: number;
  readonly deletions: number;
} {
  let additions = 0;
  let deletions = 0;
  for (const line of lines) {
    if (line.type === 'add') additions += 1;
    else if (line.type === 'del') deletions += 1;
  }
  return { additions, deletions };
}
