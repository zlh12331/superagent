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
