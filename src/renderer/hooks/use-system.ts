// src/renderer/hooks/use-system.ts
// System 域数据查询 hook（运行时可观测性）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 通过 TanStack Query 调用 system:getStatus / logs:read IPC
// - system:getStatus 用于 DevPanel Metrics tab（内存/CPU/uptime 实时展示）
// - logs:read 用于 DevPanel Logs tab（最近 N 行日志查看）
//
// 设计：
// - system:getStatus staleTime 5s（指标变化较快，但避免过频拉取拖慢渲染层）
// - logs:read staleTime 0（日志查看器每次都需要最新数据，用户手动刷新触发 refetch）
// - logs:read placeholderData: keepPreviousData（级别/行数切换是同一日志文件的
//   不同切片，旧切片驻留作占位，isPlaceholderData=true 供消费方降透明过渡）
// - enabled 参数：面板折叠时不查询，节省 IPC 调用
// ──────────────────────────────────────────────────────────────

import type { ReadLogsRes, SystemStatusRes } from '@code-agent/shared/renderer';
import { keepPreviousData, useQuery } from '@tanstack/react-query';

import { hasIpcBridge, unwrap } from '@/lib/ipc';

/** system:getStatus Query key */
export const SYSTEM_STATUS_QUERY_KEY = ['system', 'getStatus'] as const;

/** logs:read Query key（带行数与级别参数） */
export const LOGS_READ_QUERY_KEY = (lines?: number, level?: string) =>
  ['logs', 'read', { lines, level }] as const;

/** system:getStatus 默认 staleTime：5 秒 */
const SYSTEM_STATUS_STALE_TIME = 5_000;

/**
 * system:getStatus 查询 hook
 *
 * 调用 system:getStatus IPC 获取运行时状态（内存/CPU/uptime/版本）。
 * DevPanel Metrics tab 使用此 hook 自动刷新指标。
 *
 * @param enabled 是否启用查询（面板折叠时可禁用，节省 IPC）
 * @param refetchInterval 自动刷新间隔（默认 10s，可由调用方覆盖）
 */
export function useSystemStatusQuery(enabled = true, refetchInterval = 10_000) {
  return useQuery({
    queryKey: SYSTEM_STATUS_QUERY_KEY,
    queryFn: async (): Promise<SystemStatusRes> => {
      if (!hasIpcBridge()) {
        return {
          appVersion: '0.0.0',
          electronVersion: '0.0.0',
          nodeVersion: '0.0.0',
          platform: 'browser',
          arch: 'unknown',
          isPackaged: false,
          uptimeSeconds: 0,
          pid: 0,
          memory: { rss: 0, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0 },
          cpu: { user: 0, system: 0 },
          timestamp: new Date().toISOString(),
        } satisfies SystemStatusRes;
      }
      const response = await window.api.system.getStatus();
      return unwrap(response);
    },
    enabled,
    refetchInterval: enabled ? refetchInterval : false,
    staleTime: SYSTEM_STATUS_STALE_TIME,
  });
}

/**
 * logs:read 查询 hook
 *
 * 调用 logs:read IPC 从 main.log 文件尾部读取最近 N 行日志。
 * DevPanel Logs tab 使用此 hook 展示日志。
 *
 * 级别/行数切换是同一日志文件的不同切片，接 keepPreviousData 让旧切片
 * 驻留作占位（isPlaceholderData=true），消费方据此降透明过渡防闪空屏；
 * 首次加载与同 key 手动刷新无驻留数据，不受影响。
 *
 * @param lines 读取行数（默认 200）
 * @param level 级别过滤（不传则返回全部）
 * @param enabled 是否启用查询
 */
export function useLogsReadQuery(
  lines = 200,
  level?: 'info' | 'warn' | 'error' | 'debug',
  enabled = true,
) {
  return useQuery({
    queryKey: LOGS_READ_QUERY_KEY(lines, level),
    queryFn: async (): Promise<ReadLogsRes> => {
      if (!hasIpcBridge()) {
        return { lines: [], total: 0, filePath: '', truncated: false } satisfies ReadLogsRes;
      }
      const input = level !== undefined ? { lines, level } : { lines };
      const response = await window.api.logs.read(input);
      return unwrap(response);
    },
    enabled,
    staleTime: 0, // 日志查看器每次都需要最新数据
    // 过滤切换防闪空屏：见函数 JSDoc 与文件头设计注释
    placeholderData: keepPreviousData,
  });
}
