import { useEffect } from 'react';

import { unwrap } from '@/lib/ipc';
import { useUpdateStore } from '@/stores/transient/update-store';

/** 挂载更新事件桥（无返回值；随 AppShell 生命周期，卸载即退订） */
export function useUpdateBridge(): void {
  const applySnapshot = useUpdateStore((s) => s.applySnapshot);
  const applyLive = useUpdateStore((s) => s.applyLive);

  useEffect(() => {
    const api = window.api;
    if (api === undefined) {
      return;
    }
    let active = true;
    void api.update
      .getStatus()
      .then((res) => {
        const status = unwrap(res);
        if (active && status.snapshot !== null) {
          applySnapshot(status.snapshot, status.lastCheckAt);
        }
      })
      .catch(() => {});
    const unsubscribe = api.update.subscribeStatus(applyLive);
    return () => {
      active = false;
      unsubscribe();
    };
  }, [applySnapshot, applyLive]);
}
