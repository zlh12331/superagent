// src/renderer/hooks/use-agent-stop.ts
// 跨会话中断入口（D4A）：侧栏对「运行中」会话发起停止
// ──────────────────────────────────────────────────────────────
// agent:stop 本就按 sessionId 粒度中断——AgentStopReqSchema = { sessionId }，
// 主进程 agentService.abort → ActiveSessionRegistry.abort 精确命中该会话的
// AbortController（注册表支持多会话并发），不局限于「当前查看会话」，
// 故无需新增 interruptFor 通道（2026-09-27 读 agent.handler.ts:142 实证）。
//
// 列表收敛路径：
// - 成功：主进程推 stream:end（reason='aborted'）→ use-agent-bridge invalidate
// - 兜底：onSettled 无论成败都 invalidate sessions（对齐 usePinSession 的
//   「最终一致」先例），覆盖 stopped=false（回合已结束的竞态）与事件丢失
// ──────────────────────────────────────────────────────────────

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import { SESSIONS_QUERY_KEY } from '@/hooks/use-sessions';
import { useErrorMessage } from '@/i18n/use-translation';
import { unwrap, unwrapErrorMessage } from '@/lib/ipc';

/**
 * 停止指定会话的运行中回合（会话粒度，跨会话可用）
 *
 * @example
 * ```tsx
 * const { mutate: stopTurn, isPending } = useStopAgentTurn();
 * stopTurn(sessionId);
 * ```
 */
export function useStopAgentTurn() {
  const queryClient = useQueryClient();
  const { getErrorMessage } = useErrorMessage();

  return useMutation({
    mutationFn: async (sessionId: string) => {
      const response = await window.api.agent.stop({ sessionId });
      return unwrap(response);
    },
    onError: (error) => {
      toast.error(unwrapErrorMessage(error, getErrorMessage));
    },
    // 最终一致：见文件头「列表收敛路径」——成功路径由 stream:end 收敛，
    // 此处兜底对齐服务端 lastRunStatus 真值
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: SESSIONS_QUERY_KEY });
    },
  });
}
