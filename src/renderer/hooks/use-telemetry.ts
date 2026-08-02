// src/renderer/hooks/use-telemetry.ts
// 遥测级别 hook（L3 服务端请求状态层）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 通过 TanStack Query 调用 settings:getTelemetryLevel / setTelemetryLevel IPC
// - 主进程通过 telemetry-pref.json 持久化（非加密，明文 JSON）
// - 提供查询 / 设置 mutation，自动失效缓存
//
// 注意：
// - 修改遥测级别后需重启应用生效（Sentry 在启动时初始化，无法动态修改）
// - UI 应在设置成功后提示用户重启
// ──────────────────────────────────────────────────────────────

import type { TelemetryLevel } from '@code-agent/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

/** Query key */
export const TELEMETRY_LEVEL_QUERY_KEY = ['telemetry-level'] as const;

/**
 * 解包 IpcResponse（与 use-api-key.ts 共用逻辑，复制以避免循环依赖）
 */
function unwrap<T>(response: {
  readonly data?: T;
  readonly error?: { readonly code: string; readonly message: string };
}): T {
  if ('error' in response && response.error !== undefined) {
    throw new Error(`[${response.error.code}] ${response.error.message}`);
  }
  if ('data' in response && response.data !== undefined) {
    return response.data;
  }
  throw new Error('Unexpected response: missing data and error');
}

/**
 * 遥测级别查询 hook
 *
 * 调用 settings:getTelemetryLevel IPC 获取当前遥测级别。
 */
export function useTelemetryLevelQuery() {
  return useQuery({
    queryKey: TELEMETRY_LEVEL_QUERY_KEY,
    queryFn: async () => {
      const response = await window.api.settings.getTelemetryLevel();
      return unwrap<{ level: TelemetryLevel }>(response).level;
    },
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
  });
}

/**
 * 设置遥测级别 mutation hook
 *
 * 调用 settings:setTelemetryLevel IPC，写入 telemetry-pref.json。
 * 成功后提示用户重启应用以生效。
 */
export function useSetTelemetryLevel() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (level: TelemetryLevel) => {
      const response = await window.api.settings.setTelemetryLevel({ level });
      return unwrap<{ ok: boolean; level: TelemetryLevel }>(response);
    },
    onSuccess: (_data, level) => {
      void queryClient.invalidateQueries({ queryKey: TELEMETRY_LEVEL_QUERY_KEY });
      toast.success(`遥测级别已设为「${level}」，重启后生效`);
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : String(error);
      toast.error(`遥测级别设置失败：${message}`);
    },
  });
}
