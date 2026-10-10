import type { TFunction } from 'i18next';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

/**
 * 相对时间格式化
 *
 * @param timestamp Unix 毫秒时间戳
 * @param t i18next 翻译函数（本地化「刚刚 / N 分钟前」等）
 * @param compact 紧凑模式：true 返回 `5m`/`3h`/`2d`（用于紧凑下拉），
 *                false（默认）返回本地化「N 分钟前」（用于侧边栏）
 * @returns 相对时间字符串；超过一周返回 `YYYY-MM-DD`
 */
export function formatRelativeTime(timestamp: number, t: TFunction, compact = false): string {
  const diff = Date.now() - timestamp;

  if (diff < MINUTE) {
    return t('home.justNow');
  }
  if (diff < HOUR) {
    const n = Math.floor(diff / MINUTE);
    return compact ? `${n}m` : t('home.minutesAgo', { count: n });
  }
  if (diff < DAY) {
    const n = Math.floor(diff / HOUR);
    return compact ? `${n}h` : t('home.hoursAgo', { count: n });
  }
  if (diff < WEEK) {
    const n = Math.floor(diff / DAY);
    return compact ? `${n}d` : t('home.daysAgo', { count: n });
  }
  return new Date(timestamp).toISOString().slice(0, 10);
}
