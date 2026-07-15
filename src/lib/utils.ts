/**
 * @file 通用工具函数集中模块。
 *
 * 当前仅提供 `cn` —— shadcn/ui 标配的 className 合并工具。
 * 后续若新增跨模块通用的小函数，应放回此处而非散落在各 feature 中。
 */

import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/**
 * 合并多个 className 输入并解决 Tailwind 类名冲突。
 *
 * 工作流程：
 *  1. `clsx`：将对象/数组/布尔条件展平为空格分隔的类名字符串；
 *  2. `twMerge`：识别 Tailwind 中互斥的类（如 `px-2` vs `px-4`），
 *     保留最后一个，避免样式叠加不可预期。
 *
 * @example
 * ```tsx
 * <div className={cn('px-2 py-1', isActive && 'bg-primary', 'px-4')} />
 * // 最终 className: 'py-1 bg-primary px-4'
 * ```
 *
 * @param inputs 任意 ClassValue（字符串、对象、数组、布尔值等）
 * @returns 已合并去重的 className 字符串
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
