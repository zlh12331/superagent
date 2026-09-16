// src/renderer/components/dev/metrics-format.ts
// 运行时指标的数值格式化（纯函数，从 MetricsPanel 外提以便单测边界）
// ──────────────────────────────────────────────────────────────

/**
 * 字节 → 人类可读（B / KB / MB / GB）
 *
 * 档位必须逐级递进：此前 B 直接跳 MB，导致 1024 B 显示为「0.0 MB」
 * （1 KB 区间的信息被抹平）。
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

/** 微秒 → 毫秒 / 秒 */
export function formatMs(microseconds: number): string {
  const ms = microseconds / 1000;
  if (ms < 1000) return `${ms.toFixed(0)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

/** 秒 → 人类可读 uptime（如 1h 23m 45s） */
export function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}
