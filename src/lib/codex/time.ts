/**
 * SuperAgent 的时间格式化工具。
 *
 * 提供相对时间格式化（如 "2m"、"3h"、"2周前"），
 * 与原型的展示约定保持一致。
 */

/** 毫秒/分钟 —— 用于相对时间换算的常量，避免魔法数字 */
const MIN = 60_000
/** 毫秒/小时 */
const HOUR = 3_600_000
/** 毫秒/天 */
const DAY = 86_400_000
/** 毫秒/周（由 DAY 推导，避免重复字面量） */
const WEEK = 7 * DAY

/**
 * 格式化相对时间简写形式（如 "2m"、"3h"、"2d"）。
 * 用于侧边栏 thread 元信息。
 */
export function formatRelativeShort(timestamp: number): string {
  const diff = Date.now() - timestamp
  if (diff < MIN) return '刚刚'
  if (diff < HOUR) return `${Math.floor(diff / MIN)}m`
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h`
  if (diff < WEEK) return `${Math.floor(diff / DAY)}d`
  return `${Math.floor(diff / WEEK)}w`
}

/**
 * 格式化相对时间完整形式（如 "2分钟前"、"3小时前"、"2周前"）。
 * 用于 tooltip 和详情视图。
 */
export function formatRelativeLong(timestamp: number): string {
  const diff = Date.now() - timestamp
  if (diff < MIN) return '刚刚'
  if (diff < HOUR) return `${Math.floor(diff / MIN)}分钟前`
  if (diff < DAY) return `${Math.floor(diff / HOUR)}小时前`
  if (diff < WEEK) return `${Math.floor(diff / DAY)}天前`
  return `${Math.floor(diff / WEEK)}周前`
}

/**
 * 格式化绝对时间戳（如 "2026-07-10 14:30"）。
 */
export function formatAbsolute(timestamp: number): string {
  const d = new Date(timestamp)
  const pad = (n: number) => n.toString().padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
