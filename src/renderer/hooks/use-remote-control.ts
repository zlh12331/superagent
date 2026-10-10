import type { RemoteBindScope, RemoteStatusRes } from '@code-agent/shared/renderer';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { hasIpcBridge, unwrap } from '@/lib/ipc';

import { useMutationOnError } from './use-mutation-error';

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
  bindScope: 'lan',
  addresses: [],
  activeCommands: 0,
  lastCommandAt: null,
};

async function fetchStatus(): Promise<RemoteStatusRes> {
  if (!hasIpcBridge()) {
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
  if (!hasIpcBridge()) {
    return IDLE_STATUS;
  }
  const res = action === 'start' ? await window.api.remote.start() : await window.api.remote.stop();
  return unwrap<RemoteStatusRes>(res);
}

/** 启动 mutation：成功后直接写入返回快照 */
export function useStartRemoteControl() {
  const queryClient = useQueryClient();
  const onError = useMutationOnError();
  return useMutation({
    mutationFn: () => requestChange('start'),
    onSuccess: (status) => {
      queryClient.setQueryData(REMOTE_STATUS_QUERY_KEY, status);
    },
    onError,
  });
}

/** 停止 mutation：成功后直接写入返回快照（配对凭据已清空） */
export function useStopRemoteControl() {
  const queryClient = useQueryClient();
  const onError = useMutationOnError();
  return useMutation({
    mutationFn: () => requestChange('stop'),
    onSuccess: (status) => {
      queryClient.setQueryData(REMOTE_STATUS_QUERY_KEY, status);
    },
    onError,
  });
}

/** 绑定范围切换 mutation：主进程先应用后落库，返回应用后快照（浏览器模式降级为回显） */
export function useSetRemoteBindScope() {
  const queryClient = useQueryClient();
  const onError = useMutationOnError();
  return useMutation({
    mutationFn: async (scope: RemoteBindScope): Promise<RemoteStatusRes> => {
      if (!hasIpcBridge()) {
        return { ...IDLE_STATUS, bindScope: scope };
      }
      return unwrap<RemoteStatusRes>(await window.api.remote.setBindScope({ scope }));
    },
    onSuccess: (status) => {
      queryClient.setQueryData(REMOTE_STATUS_QUERY_KEY, status);
    },
    onError,
  });
}
