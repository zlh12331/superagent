import { useEffect } from 'react';

import { applyZoom } from '@/lib/zoom';
import { useSettingsStore } from '@/stores/persistent/settings-store';

/** 订阅 store.appearance.zoom 并应用（AppShell 顶层挂载一次） */
export function useZoomEffect(): void {
  const zoom = useSettingsStore((s) => s.appearance.zoom);
  useEffect(() => {
    void applyZoom(zoom);
  }, [zoom]);
}
