// src/renderer/hooks/use-remote-control.ts
// 远程控制 hook（L3 服务端请求状态层）
// ──────────────────────────────────────────────────────────────
// 职责：
// - remote:getStatus 查询（设置「移动端」面板数据源）；运行中轮询活动计数
// - remote:start / remote:stop mutation（成功后用返回快照直接写入缓存，
//   避免"开关刚点完又显示旧状态"的竞态）
// 说明：令牌只在服务运行期间由主进程下发，停止后快照置 null（不落渲染层缓存）
// ──────────────────────────────────────────────────────────────

import type { RemoteStatusRes } from '@code-agent/shared/renderer';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { unwrap } from '@/lib/ipc';

/** 远程控制状态查询 key */
export const REMOTE_STATUS_QUERY_KEY = ['remote', 'status'] as const;

/** 运行中轮询间隔（活动命令计数/最近命令时间需要准实时反映） */
const POLL_INTERVAL_MS = 3000;

/** 浏览器模式降级快照（无主进程可查） */
const IDLE_STATUS: RemoteStatusRes = {
  running: false,
  port: null,
  token: null,
  instanceName: '',
  addresses: [],
  activeCommands: 0,
  lastCommandAt: null,
};

async function fetchStatus(): Promise<RemoteStatusRes> {
  if (typeof window === 'undefined' || window.api === undefined) {
    return IDLE_STATUS;
  }
  return unwrap<RemoteStatusRes>(await window.api.remote.getStatus());
}

/** 远程控制状态查询（仅运行中轮询，停止后不占用 IPC 往返） */
export function useRemoteStatusQuery() {
  return useQuery({
    queryKey: REMOTE_STATUS_QUERY_KEY,
    queryFn: fetchStatus,
    refetchInterval: (query) => (query.state.data?.running === true ? POLL_INTERVAL_MS : false),
  });
}

/** 启停请求：主进程返回变更后快照（浏览器模式降级为已停止） */
async function requestChange(action: 'start' | 'stop'): Promise<RemoteStatusRes> {
  if (typeof window === 'undefined' || window.api === undefined) {
    return IDLE_STATUS;
  }
  const res = action === 'start' ? await window.api.remote.start() : await window.api.remote.stop();
  return unwrap<RemoteStatusRes>(res);
}

/** 启动 mutation：成功后直接写入返回快照 */
export function useStartRemoteControl() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => requestChange('start'),
    onSuccess: (status) => {
      queryClient.setQueryData(REMOTE_STATUS_QUERY_KEY, status);
    },
  });
}

/** 停止 mutation：成功后直接写入返回快照（配对凭据已清空） */
export function useStopRemoteControl() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => requestChange('stop'),
    onSuccess: (status) => {
      queryClient.setQueryData(REMOTE_STATUS_QUERY_KEY, status);
    },
  });
}
