// src/renderer/lib/diff/unified-diff.ts
// unified diff 文本解析器（git:diff 输出 → ReactDiffViewer 输入）
// ──────────────────────────────────────────────────────────────
// 背景：统一 diff 渲染方案为 react-diff-viewer-continued。
// 该库输入为 oldValue/newValue 原始文本对，而 git:diff 返回 unified diff
// 原始文本（含 @@ hunk 头）。本解析器将 unified diff 拆解为 hunk 列表，
// 每个 hunk 还原出变更前后的文本片段（上下文行同时进入两侧）。
//
// 已知限制（诚实标注）：hunk 之间未出现在 diff 中的文件行无法从 unified
// diff 还原（git 默认仅输出上下文行），因此渲染为分 hunk 视图
// （GitHub 风格的变更块展示），而非完整文件视图。
// ──────────────────────────────────────────────────────────────

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
}

/** 构建中的可变 hunk（接口字段为 readonly，内部构建用可变结构） */
interface MutableHunk {
  readonly oldStart: number;
  readonly oldLines: string[];
  readonly newStart: number;
  readonly newLines: string[];
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
      };
      hunks.push(current);
      continue;
    }
    if (current === null) {
      continue;
    }
    if (line.startsWith('+')) {
      current.newLines.push(line.slice(1));
    } else if (line.startsWith('-')) {
      current.oldLines.push(line.slice(1));
    } else if (line.startsWith(' ')) {
      const context = line.slice(1);
      current.oldLines.push(context);
      current.newLines.push(context);
    }
    // `\ No newline at end of file` 与空行：忽略（不进入内容）
  }

  return hunks;
}

/**
 * hunk 总数（用于 UI 提示多 hunk 文件）
 */
export function countHunks(diff: string): number {
  return parseUnifiedDiff(diff).length;
}
