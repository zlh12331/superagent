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
