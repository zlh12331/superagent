import type { TelemetryLevel } from '@code-agent/shared/renderer';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useTranslation } from '@/i18n/use-translation';
import { unwrap } from '@/lib/ipc';

/** Query key */
export const TELEMETRY_LEVEL_QUERY_KEY = ['telemetry-level'] as const;

/** 浏览器模式（dev 预览）默认级别：不外发任何数据，与 off 语义一致 */
const FALLBACK_LEVEL: TelemetryLevel = 'off';

/** window.api 是否可用（浏览器模式 / preload 缺失时为 false） */
function hasBridge(): boolean {
  return typeof window !== 'undefined' && window.api !== undefined;
}

/**
 * 遥测级别查询 hook
 *
 * 调用 settings:getTelemetryLevel IPC 获取当前遥测级别。
 * 浏览器模式返回 off（本项目的既定降级语义：无桥即不外发遥测）。
 */
export function useTelemetryLevelQuery() {
  return useQuery({
    queryKey: TELEMETRY_LEVEL_QUERY_KEY,
    queryFn: async () => {
      if (!hasBridge()) return FALLBACK_LEVEL;
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
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (level: TelemetryLevel) => {
      if (!hasBridge()) throw new Error('window.api unavailable');
      const response = await window.api.settings.setTelemetryLevel({ level });
      return unwrap<{ ok: boolean; level: TelemetryLevel }>(response);
    },
    onSuccess: (_data, level) => {
      void queryClient.invalidateQueries({ queryKey: TELEMETRY_LEVEL_QUERY_KEY });
      toast.success(t('common.telemetryUpdated', { level }));
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : String(error);
      toast.error(t('common.telemetryUpdateFailed', { message }));
    },
  });
}
