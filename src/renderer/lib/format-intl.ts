// src/renderer/lib/format-intl.ts
// Intl 本地化格式化工具（渲染层共用；S6 国际化审计落地）
// ──────────────────────────────────────────────────────────────
// 设计动机：
// - 此前日期/时间/数字全为硬编码拼接（HH:MM:SS 手写 padStart、
//   k/M 英文缩写），不随 i18n 语言变化。
// - 统一走 Intl API + locale 参数（纯函数，组件从 i18n.language 传入）：
//   时钟跟随 12/24 小时制；compact 数字跟随本地单位（zh 万 / en K）。
//
// 边界（数据契约格式不本地化）：
// - yyyy-MM-dd 等作为数据 key 的格式（日历热力图 byDay、会话日期）
//   跨语言必须稳定，保持 ISO 原样，不在此层处理。
// ──────────────────────────────────────────────────────────────

/**
 * 时钟时间（HH:MM:SS，12/24 小时制跟随 locale）
 *
 * @param value ISO 字符串 / 时间戳 / Date
 * @param locale i18n 语言（如 zh-CN / en-US）
 */
export function formatClockTime(value: string | number | Date, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(value));
}

/**
 * compact 数字（跟随 locale 本地单位：zh 显示「1.2万」/ en 显示「1.2K」）
 *
 * 未达本地 compact 阈值时返回原值（zh 下 1500 → 「1500」，en 下 → 「1.5K」）。
 *
 * @param n 数值
 * @param locale i18n 语言
 */
export function formatCompactNumber(n: number, locale: string): string {
  return new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }).format(n);
}
