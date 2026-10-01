// src/renderer/lib/diff/unified-diff.ts
// unified diff 文本解析器（git:diff 输出 → 自研 diff 渲染行）
// ──────────────────────────────────────────────────────────────
// 背景：统一 diff 渲染为自研方案（DiffRowsTable + shiki 行高亮）。
// git:diff 返回 unified diff 原始文本（含 @@ hunk 头）。本解析器将 unified
// diff 拆解为 hunk 列表：每个 hunk 还原出语义化行序列（类型 + 双侧行号 +
// 内容，供双栏表格直接渲染），同时保留变更前后的文本片段（oldLines/newLines）。
//
// 已知限制（诚实标注）：hunk 之间未出现在 diff 中的文件行无法从 unified
// diff 还原（git 默认仅输出上下文行），因此渲染为分 hunk 视图
// （GitHub 风格的变更块展示），而非完整文件视图。
// ──────────────────────────────────────────────────────────────

import type { DiffLineType } from './line-diff';

/** hunk 内单行（语义化：类型 + 双侧行号 + 内容，双栏渲染的原子单元） */
export interface DiffHunkLine {
  /** 行类型（context / add / del，与 line-diff 的行类型同义） */
  readonly type: DiffLineType;
  /** 变更前行号（1-based，来自 @@ 头推算；add 行为 null） */
  readonly oldNumber: number | null;
  /** 变更后行号（1-based，来自 @@ 头推算；del 行为 null） */
  readonly newNumber: number | null;
  /** 行内容（不含 + / - / 空格前缀） */
  readonly text: string;
}

/** 单个 hunk 的还原结果 */
export interface UnifiedDiffHunk {
  /** 变更前起始行号（1-based，来自 @@ 头；新增文件为 0） */
  readonly oldStart: number;
  /** 变更前文本行（上下文 + 删除行） */
  readonly oldLines: readonly string[];
  /** 变更后起始行号（1-based，来自 @@ 头） */
  readonly newStart: number;
  /** 变更后文本行（上下文 + 新增行） */
  readonly newLines: readonly string[];
  /** 语义化行序列（按 diff 出现顺序，双侧行号已推算） */
  readonly lines: readonly DiffHunkLine[];
}

/** 构建中的可变 hunk（接口字段为 readonly，内部构建用可变结构） */
interface MutableHunk {
  readonly oldStart: number;
  readonly oldLines: string[];
  readonly newStart: number;
  readonly newLines: string[];
  readonly lines: DiffHunkLine[];
}

/** 行号推算游标（context 双侧递进，del 只进 old，add 只进 new） */
interface NumberingCursor {
  oldNumber: number;
  newNumber: number;
}

/** 按行类型推算双侧行号并推进游标（add 行 oldNumber 为 null，del 行反之） */
function toNumberedLine(type: DiffLineType, text: string, cursor: NumberingCursor): DiffHunkLine {
  if (type === 'add') {
    return { type, oldNumber: null, newNumber: cursor.newNumber++, text };
  }
  if (type === 'del') {
    return { type, oldNumber: cursor.oldNumber++, newNumber: null, text };
  }
  return { type, oldNumber: cursor.oldNumber++, newNumber: cursor.newNumber++, text };
}

/**
 * 解析 unified diff 文本为 hunk 列表
 *
 * 输入示例（git:diff 输出）：
 * ```
 * diff --git a/foo.ts b/foo.ts
 * index 123..456 100644
 * --- a/foo.ts
 * +++ b/foo.ts
 * @@ -1,3 +1,4 @@
 *  const a = 1;
 * -const b = 2;
 * +const b = 3;
 * +const c = 4;
 *  const d = 5;
 * ```
 *
 * 规则：
 * - `@@ -oldStart[,oldCount] +newStart[,newCount] @@`：新 hunk 开始
 * - `+` 行：仅进入 newLines；`-` 行：仅进入 oldLines
 * - 空格行（上下文）：同时进入两侧
 * - `\ No newline...`：忽略
 * - hunk 之外的行（diff --git / index / --- / +++ 头）：忽略
 *
 * @param diff unified diff 原始文本
 * @returns hunk 列表（空 diff / 无 hunk 时为空数组）
 */
export function parseUnifiedDiff(diff: string): readonly UnifiedDiffHunk[] {
  const hunks: MutableHunk[] = [];
  let current: MutableHunk | null = null;
  // 行号游标随 hunk 重置（@@ 头携带两侧起始行号）
  let cursor: NumberingCursor = { oldNumber: 1, newNumber: 1 };

  for (const rawLine of diff.split('\n')) {
    // CRLF 行尾归一化（git 在 Windows 输出 \r\n）
    const line = rawLine.replace(/\r$/, '');
    const hunkHeader = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (hunkHeader !== null) {
      current = {
        oldStart: Number(hunkHeader[1]),
        oldLines: [],
        newStart: Number(hunkHeader[3]),
        newLines: [],
        lines: [],
      };
      hunks.push(current);
      cursor = { oldNumber: current.oldStart, newNumber: current.newStart };
      continue;
    }
    if (current === null) {
      continue;
    }
    if (line.startsWith('+')) {
      const text = line.slice(1);
      current.newLines.push(text);
      current.lines.push(toNumberedLine('add', text, cursor));
    } else if (line.startsWith('-')) {
      const text = line.slice(1);
      current.oldLines.push(text);
      current.lines.push(toNumberedLine('del', text, cursor));
    } else if (line.startsWith(' ')) {
      const context = line.slice(1);
      current.oldLines.push(context);
      current.newLines.push(context);
      current.lines.push(toNumberedLine('context', context, cursor));
    }
    // `\ No newline at end of file` 与空行：忽略（不进入内容）
  }

  return hunks;
}

/**
 * hunk 总数（用于 UI 提示多 hunk 文件）
 *
 * 注（2026-09-08 死代码核实）：当前无生产消费方，但 unified-diff.test.ts
 * 有覆盖——按「测试专用导出」保留（删除会破坏测试且无收益）。
 */
export function countHunks(diff: string): number {
  return parseUnifiedDiff(diff).length;
}

/**
 * 提取 diff 的目标文件路径（+++ 行，供语法高亮语言检测）
 *
 * 规则：
 * - 只看首个 hunk 前的 `+++ ` 头（git:diff 恒为单文件输出）
 * - `/dev/null`（纯删除文件）与缺失 → null
 * - 剥离 git 约定的 `b/` 前缀与 `\t` 分隔的时间戳（外部工具可能附加）
 *
 * @param diff unified diff 原始文本
 * @returns 目标文件路径；无法确定时为 null
 */
export function extractDiffTargetPath(diff: string): string | null {
  for (const rawLine of diff.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (line.startsWith('@@')) break; // 进入 hunk 体即止（+++ 头只出现在头部）
    if (!line.startsWith('+++ ')) continue;
    const field = line.slice(4).split('\t')[0]?.trim() ?? '';
    if (field === '' || field === '/dev/null') continue;
    return field.replace(/^b\//, '');
  }
  return null;
}
