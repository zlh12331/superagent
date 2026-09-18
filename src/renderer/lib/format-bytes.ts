// src/renderer/lib/format-bytes.ts
// 字节 / 时长格式化（更新进度展示用；纯函数，无第三方依赖）
// ──────────────────────────────────────────────────────────────
// 设计：单位文案保持语言中立（数字 + 国际单位制），避免在工具层硬编码中文
// 文案——渲染层用 i18n 模板拼接（check:i18n 禁止硬编码文案）。
// ──────────────────────────────────────────────────────────────

/** 字节单位（1024 进制，与系统"文件大小"口径一致） */
const BYTE_UNITS: readonly string[] = ['B', 'KB', 'MB', 'GB', 'TB'];

/**
 * 格式化字节数
 *
 * @example
 * ```ts
 * formatBytes(0) // '0 B'
 * formatBytes(1024) // '1.0 KB'
 * formatBytes(12_345_678) // '11.8 MB'
 * ```
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 B';
  }
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < BYTE_UNITS.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const unit = BYTE_UNITS[unitIndex] ?? 'B';
  // 字节级不带小数（1023 B 比 1023.0 B 自然）
  return unitIndex === 0 ? `${Math.round(value)} ${unit}` : `${value.toFixed(1)} ${unit}`;
}

/**
 * 格式化时长（秒 → 时钟串，语言中立）
 *
 * @example
 * ```ts
 * formatClock(18) // '0:18'
 * formatClock(95) // '1:35'
 * formatClock(3_725) // '1:02:05'
 * ```
 */
export function formatClock(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) {
    return '0:00';
  }
  const seconds = Math.round(totalSeconds);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  const pad = (value: number): string => String(value).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(rest)}` : `${minutes}:${pad(rest)}`;
}

/**
 * 估算剩余下载时长（秒 → 时钟串）
 *
 * @returns 时钟串；速率无效或已下载完（无剩余）时返回 null（调用方用占位符）
 */
export function formatRemainingClock(
  transferred: number,
  total: number,
  bytesPerSecond: number,
): string | null {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0 || total <= transferred) {
    return null;
  }
  return formatClock((total - transferred) / bytesPerSecond);
}
