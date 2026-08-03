// src/renderer/lib/diff/diff-stats.ts
// diff 行级语义统计（diff-match-patch 行级 diff）
// ──────────────────────────────────────────────────────────────
// 用途：
// - GitPanel 展示文件的语义增删行数（+N / -M 徽标）
// - 与 git diff 文本统计（正则数 +/- 行）的区别：
//   git 统计把"被移动的行"同时计入 + 和 -；
//   本工具用 diff-match-patch 的 diff_linesToChars + diff_cleanupSemantic
//   做语义对齐，移动的行不计入增删，数字更接近真实变更。
// ──────────────────────────────────────────────────────────────

import { DIFF_DELETE, DIFF_INSERT, type Diff, diff_match_patch } from 'diff-match-patch';

/** 行级语义 diff 统计结果 */
export interface SemanticDiffStats {
  /** 语义新增行数（移动的行不计） */
  readonly additions: number;
  /** 语义删除行数（移动的行不计） */
  readonly deletions: number;
}

/** 共享实例（diff_match_patch 无内部状态，可安全复用） */
const DMP = new diff_match_patch();

/**
 * 行 → 字符编码 + 行级 diff 统计
 *
 * 为什么不用 diff_main(checklines=true)：
 * - checklines 优化仅在文本长度超过内部阈值时启用，短文本退化为字符级 diff
 * - 字符级 diff 会把一行拆成半行，行数统计失真
 * 这里手动把每一行映射为一个唯一字符，再做字符级 diff——等价于强制行级粒度。
 */
function countLineDiffs(
  oldLines: readonly string[],
  newLines: readonly string[],
): SemanticDiffStats {
  const lineMap = new Map<string, string>();
  let code = 32; // 可打印字符起点（空间足够 65535 行）

  const encode = (lines: readonly string[]): string => {
    let out = '';
    for (const line of lines) {
      let c = lineMap.get(line);
      if (c === undefined) {
        c = String.fromCharCode(code);
        code += 1;
        lineMap.set(line, c);
      }
      out += c;
    }
    return out;
  };

  const chars1 = encode(oldLines);
  const chars2 = encode(newLines);
  const diffs: Diff[] = DMP.diff_main(chars1, chars2, false);

  let additions = 0;
  let deletions = 0;
  for (const [op, text] of diffs) {
    // 每个字符 = 一行
    if (op === DIFF_INSERT) {
      additions += text.length;
    } else if (op === DIFF_DELETE) {
      deletions += text.length;
    }
  }
  return { additions, deletions };
}

/**
 * 从 unified diff 文本计算语义增删行数
 *
 * @param diffText `git diff` 输出的 unified diff 文本
 * @returns 语义统计；无 +/- 行时返回 { additions: 0, deletions: 0 }
 */
export function countSemanticDiffLines(diffText: string): SemanticDiffStats {
  // 提取 +/- 行（跳过 +++/--- 文件头与 @@ hunk 头）
  const oldLines: string[] = [];
  const newLines: string[] = [];
  for (const line of diffText.split('\n')) {
    if (
      line.startsWith('+++') ||
      line.startsWith('---') ||
      line.startsWith('@@') ||
      line.startsWith('diff ') ||
      line.startsWith('index ')
    ) {
      continue;
    }
    if (line.startsWith('+')) {
      newLines.push(line.slice(1));
    } else if (line.startsWith('-')) {
      oldLines.push(line.slice(1));
    }
  }

  if (oldLines.length === 0 && newLines.length === 0) {
    return { additions: 0, deletions: 0 };
  }

  // 行级 diff（手动行→字符编码，避免 checklines 在短文本下退化为字符级）
  return countLineDiffs(oldLines, newLines);
}
