import { useEffect } from 'react';

import { applyDomainInvalidation, noteInvalidationEvent } from '@/lib/invalidation/invalidation';
import { hasIpcBridge } from '@/lib/ipc';

/** 挂载失效域事件桥（无返回值；随 AppShell 生命周期，卸载即退订） */
export function useInvalidationBridge(): void {
  useEffect(() => {
    if (!hasIpcBridge()) {
      return;
    }
    const unsubscribe = window.api.invalidation.subscribeDomains((payload) => {
      noteInvalidationEvent(payload.domains, payload.sessionId);
      applyDomainInvalidation(payload.domains);
    });
    return () => {
      unsubscribe();
    };
  }, []);
}
