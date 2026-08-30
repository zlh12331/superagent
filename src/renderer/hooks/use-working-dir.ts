// src/renderer/hooks/use-working-dir.ts
// 会话工作目录的唯一读取入口（L3 派生态）
// ──────────────────────────────────────────────────────────────
// 规则：任何需要 workingDir 的组件都经本 hook 取，不再读 fileTreeStore.rootPath
// 之类的镜像（详见 lib/working-dir.ts 顶部说明）。
// 数据来自 ['sessions'] 列表缓存（侧栏已加载），不额外拉会话详情——详情里带全量
// 消息，仅为拿一个目录字符串去拉详情是净负收益。
// ──────────────────────────────────────────────────────────────

import { useMemo } from 'react';

import { resolveWorkingDir } from '@/lib/working-dir';
import { useActiveSessionStore } from '@/stores/persistent/sessions-store';

import { useSessionsQuery } from './use-sessions';

/** 会话 id → workingDir 索引（平铺无限分页的全部已加载会话） */
export function useWorkingDirIndex(): ReadonlyMap<string, string> {
  const { data } = useSessionsQuery();
  return useMemo(() => {
    const index = new Map<string, string>();
    for (const page of data?.pages ?? []) {
      for (const session of page.sessions) {
        index.set(session.id, session.workingDir);
      }
    }
    return index;
  }, [data]);
}

/**
 * 指定会话的工作目录
 *
 * @param sessionId 目标会话 id
 * @param knownDir 调用方已持有的权威目录（如路由层已从会话详情拿到），优先于索引
 */
export function useWorkingDir(sessionId: string | null, knownDir?: string): string | null {
  const dirBySession = useWorkingDirIndex();
  return useMemo(
    () => resolveWorkingDir({ knownDir, dirBySession, sessionId }),
    [knownDir, dirBySession, sessionId],
  );
}

/** 当前激活会话的工作目录（无激活会话 / 目录未知 → null） */
export function useActiveWorkingDir(): string | null {
  const activeSessionId = useActiveSessionStore((state) => state.activeSessionId);
  return useWorkingDir(activeSessionId);
}
