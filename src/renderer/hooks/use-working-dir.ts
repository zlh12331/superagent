import { resolveWorkingDir } from '@/lib/working-dir';
import { useActiveSessionStore } from '@/stores/persistent/sessions-store';

import { useSessionsFlat } from './use-sessions';

/** 会话 id → workingDir 索引（平铺无限分页的全部已加载会话） */
export function useWorkingDirIndex(): ReadonlyMap<string, string> {
  const { data: sessions } = useSessionsFlat();
  const index = new Map<string, string>();
  for (const session of sessions ?? []) {
    index.set(session.id, session.workingDir);
  }
  return index;
}

/**
 * 指定会话的工作目录
 *
 * @param sessionId 目标会话 id
 * @param knownDir 调用方已持有的权威目录（如路由层已从会话详情拿到），优先于索引
 */
export function useWorkingDir(sessionId: string | null, knownDir?: string): string | null {
  const dirBySession = useWorkingDirIndex();
  return resolveWorkingDir({ knownDir, dirBySession, sessionId });
}

/** 当前激活会话的工作目录（无激活会话 / 目录未知 → null） */
export function useActiveWorkingDir(): string | null {
  const activeSessionId = useActiveSessionStore((state) => state.activeSessionId);
  return useWorkingDir(activeSessionId);
}
