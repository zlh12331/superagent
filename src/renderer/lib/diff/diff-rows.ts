// src/renderer/lib/diff/diff-rows.ts
// diff 渲染行模型桥（自研 DiffRowsTable 的数据装配层）
// ──────────────────────────────────────────────────────────────
// 职责：
// - rowsFromTextPair：oldText/newText 原始文本对（审批预览的 write_file /
//   edit_file 输入形态）→ 编号渲染行。复用 line-diff 的 dmp 行级对齐，
//   行号按行类型推进（与 unified-diff 的 hunk 行号推算同构）。
// - computeWordSegments：行内词级差异片段（dmp diff_main 直跑），
//   供 wordDiff 模式在配对的 del/add 行内高亮变更词。
// ──────────────────────────────────────────────────────────────

import { DIFF_DELETE, DIFF_INSERT, type Diff, diff_match_patch } from 'diff-match-patch';

import { computeLineDiff, type DiffLine } from './line-diff';
import type { DiffHunkLine } from './unified-diff';

/** 渲染行（与解析器语义行同构：文本对来源经行号补全） */
export type DiffRow = DiffHunkLine;

/** 行内词级差异片段 */
export interface WordSegment {
  readonly text: string;
  readonly type: 'equal' | 'add' | 'del';
}

/**
 * 文本对 → 编号渲染行（审批预览用）
 *
 * computeLineDiff 的输出是全量对齐（非 hunk 截断），行号可精确推进：
 * context 双侧递进，del 只进 old，add 只进 new（起始均为 1）。
 *
 * @param oldText 变更前文本（空串 = 新建文件）
 * @param newText 变更后文本（空串 = 删除文件）
 */
export function rowsFromTextPair(oldText: string, newText: string): readonly DiffRow[] {
  const rows: DiffRow[] = [];
  let oldNumber = 1;
  let newNumber = 1;
  const push = (line: DiffLine): void => {
    if (line.type === 'add') {
      rows.push({ type: line.type, oldNumber: null, newNumber: newNumber++, text: line.text });
    } else if (line.type === 'del') {
      rows.push({ type: line.type, oldNumber: oldNumber++, newNumber: null, text: line.text });
    } else {
      rows.push({
        type: line.type,
        oldNumber: oldNumber++,
        newNumber: newNumber++,
        text: line.text,
      });
    }
  };
  for (const line of computeLineDiff(oldText, newText)) {
    push(line);
  }
  return rows;
}

/**
 * 词级差异规模上限（单行字符数）
 *
 * dmp diff_main 对超长串（如压缩后的单行文件）耗时不可控；
 * 超限直接放弃词级高亮，退化为整行底色（不丢内容）。
 */
const MAX_WORD_DIFF_CHARS = 2000;

/** 共享实例（dmp 无内部状态，可安全复用）；超时收紧以约束大行开销 */
const WORD_DMP = new diff_match_patch();
WORD_DMP.Diff_Timeout = 0.2;

/** dmp op → 片段类型（未知 op 防御性归为 equal，保持渲染完整） */
function opToSegmentType(op: number): WordSegment['type'] {
  if (op === DIFF_INSERT) return 'add';
  if (op === DIFF_DELETE) return 'del';
  return 'equal';
}

/**
 * 计算两行的行内词级差异片段（wordDiff 模式）
 *
 * del 行取（equal + del）片段、配对的 add 行取（equal + add）片段渲染，
 * 片段顺序即 dmp 输出顺序（两侧对齐）。
 *
 * @param oldLine 变更前行文本
 * @param newLine 变更后行文本
 * @returns 片段序列；任一行超长时返回空数组（调用方退化为整行渲染）
 */
export function computeWordSegments(oldLine: string, newLine: string): readonly WordSegment[] {
  if (oldLine.length > MAX_WORD_DIFF_CHARS || newLine.length > MAX_WORD_DIFF_CHARS) {
    return [];
  }
  const diffs: Diff[] = WORD_DMP.diff_main(oldLine, newLine);
  return diffs.map(([op, text]) => ({ text, type: opToSegmentType(op) }));
}
