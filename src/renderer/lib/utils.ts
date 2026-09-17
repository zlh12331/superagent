// src/renderer/lib/utils.ts
// 渲染层通用工具函数
// 设计文档 §3 目录结构：lib/utils.ts 含 cn() + 其他工具

import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * 合并 Tailwind CSS 类名
 *
 * 结合 clsx（条件类名）与 tailwind-merge（去重冲突类）：
 * - clsx 处理 `cn('p-2', condition && 'p-4')` 这种条件拼接
 * - tailwind-merge 处理 `cn('p-2 p-4')` → `'p-4'` 这种冲突覆盖
 *
 * @example
 * cn('px-2 py-1', isActive && 'bg-primary', 'px-4')
 * // → 'py-1 bg-primary px-4'
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/**
 * 取路径最后一段（basename），兼容 Windows 反斜杠与 POSIX 正斜杠
 *
 * 收敛动机：此前渲染层存在 **4 份** 重复实现（routes/home、file-viewer-utils、
 * FileTreePanel、fuzzy-search-dialog），且对「尾部分隔符」处理不一致——
 * 有的返回空串（文件树根标签会显示空白）、有的回退整条路径。
 * 现统一为：先剥掉尾部分隔符，再取最后一段。
 * 纯分隔符路径（'/'、'\'）与空串原样返回（对齐 POSIX basename 语义）。
 *
 * 渲染层无 Node API，故不复用 node:path。
 *
 * @example
 * ```ts
 * basename('C:\\proj\\src\\a.ts') // 'a.ts'
 * basename('/proj/src/')          // 'src'（尾部斜杠不产生空串）
 * basename('/')                   // '/'
 * ```
 */
export function basename(path: string): string {
  const stripped = path.replace(/[\\/]+$/, '');
  // 纯分隔符（'/'、'\'）或空串：原样返回，避免剥成空串
  if (stripped === '') return path;
  const idx = Math.max(stripped.lastIndexOf('/'), stripped.lastIndexOf('\\'));
  return idx === -1 ? stripped : stripped.slice(idx + 1);
}

/**
 * 取扩展名（不含点，已转小写），无点返回空串
 *
 * 收敛动机：渲染层有 2 份相同实现——`file-viewer-utils.detectLangFromPath`
 * （决定拿什么语言高亮）与 `file-icon`（决定用什么图标配色），两处各自的
 * 「取最后一个点之后、转小写」口径必须一致，否则同一个文件会出现
 * 「高亮按 typescript、图标按 text」这类不对称。
 *
 * 入参可以是文件名或完整路径：本函数**只按最后一个点切分，不剥目录**
 * （与两处原实现逐位一致）。目录名含点时返回的片段会横跨目录与文件两部分，
 * 后果可控——该片段必然不是受支持语言/图标扩展名，下游回落默认值。
 *
 * 语义示例：
 * - `'a.ts'` → `'ts'`；`'A.TS'` → `'ts'`（大小写不敏感）
 * - `'Makefile'` → `''`（无点）
 * - `'.env'` → `'env'`（点文件按「点在位置 0」切分）
 * - `'a.'` → `''`（尾点后为空）
 * - `''` → `''`
 */
export function fileExtension(fileName: string): string {
  const lower = fileName.toLowerCase();
  const dotIndex = lower.lastIndexOf('.');
  return dotIndex >= 0 ? lower.slice(dotIndex + 1) : '';
}
