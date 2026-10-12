import type { DeepLinkPayload } from '@code-agent/shared/renderer';
import { useEffect } from 'react';
import { useNavigate } from 'react-router';

import { ROUTES } from '@/lib/constants';
import { hasIpcBridge } from '@/lib/ipc';
import { useActiveSessionStore } from '@/stores/persistent/sessions-store';

/**
 * 深度链接桥接 Hook（AppShell 挂载一次）
 *
 * 收到 `code-agent://session/<id>` 唤起时跳转到对应会话；
 * 仅唤起（无 sessionId）时留驻当前页面（窗口已由主进程聚焦）。
 */
export function useDeepLink(): void {
  const navigate = useNavigate();
  const setActiveSession = useActiveSessionStore((s) => s.setActiveSession);

  useEffect(() => {
    if (!hasIpcBridge()) {
      return;
    }

    const unsubscribe = window.api.app.subscribeDeepLink((payload) => {
      const typedPayload = payload as DeepLinkPayload;
      if (typedPayload.sessionId === null || typedPayload.sessionId === '') {
        return;
      }
      setActiveSession(typedPayload.sessionId);
      navigate(ROUTES.chatPath(typedPayload.sessionId));
    });

    return () => {
      unsubscribe();
    };
  }, [navigate, setActiveSession]);
}
