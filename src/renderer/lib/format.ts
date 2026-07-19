// src/renderer/lib/format.ts
// 格式化工具函数
// 设计文档 §7.10 用户友好提示
//
// 职责：
// - 格式化时间戳为相对/绝对时间字符串
// - 格式化字数（k/w 单位）
// - 格式化大数字（千分位分隔）
//
// 注意：所有函数均为纯函数，无副作用，便于测试与复用。

/**
 * 格式化时间为相对时间字符串
 *
 * @param dateStr - ISO 8601 时间字符串
 * @returns 相对时间字符串，如 "刚刚" / "3 分钟前" / "2 小时前" / "1 天前" / "2026-01-01"
 *
 * @example
 * formatRelativeTime('2026-07-19T10:00:00Z') // → "刚刚"（当前时间是 10:01）
 * formatRelativeTime('2026-07-19T08:00:00Z') // → "2 小时前"
 */
export function formatRelativeTime(dateStr: string): string {
  const date = new Date(dateStr);
  const now = Date.now();
  const diffMs = now - date.getTime();

  // 未来时间或异常值，回退到绝对时间
  if (diffMs < 0) {
    return formatAbsoluteDate(dateStr);
  }

  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  if (diffSec < 60) return '刚刚';
  if (diffMin < 60) return `${diffMin} 分钟前`;
  if (diffHour < 24) return `${diffHour} 小时前`;
  if (diffDay < 7) return `${diffDay} 天前`;
  return formatAbsoluteDate(dateStr);
}

/**
 * 格式化为绝对日期字符串
 *
 * @param dateStr - ISO 8601 时间字符串
 * @returns YYYY-MM-DD 格式字符串
 *
 * @example
 * formatAbsoluteDate('2026-07-19T10:00:00Z') // → "2026-07-19"
 */
export function formatAbsoluteDate(dateStr: string): string {
  const date = new Date(dateStr);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * 格式化字数
 *
 * 字数小于 10000 显示原值；大于等于 10000 显示万单位（保留 1 位小数）。
 *
 * @param wordCount - 字数
 * @returns 带单位的字数字符串
 *
 * @example
 * formatWordCount(0)       // → "0 字"
 * formatWordCount(3500)    // → "3500 字"
 * formatWordCount(12345)   // → "1.2 万字"
 */
export function formatWordCount(wordCount: number): string {
  if (wordCount < 10000) {
    return `${wordCount} 字`;
  }
  // 保留 1 位小数（向下取整避免显示 1.0）
  const wanCount = Math.floor((wordCount / 10000) * 10) / 10;
  return `${wanCount} 万字`;
}

/**
 * 格式化大数字（千分位分隔）
 *
 * @param num - 数字
 * @returns 带千分位分隔的字符串
 *
 * @example
 * formatNumber(1234567) // → "1,234,567"
 */
export function formatNumber(num: number): string {
  return num.toLocaleString('zh-CN');
}
