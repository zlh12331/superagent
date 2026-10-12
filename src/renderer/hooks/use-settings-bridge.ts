import { useEffect } from 'react';

import { useSettingsStore } from '@/stores/persistent/settings-store';

/** 挂载设置变更事件桥（无返回值；随 AppShell 生命周期，卸载即退订） */
export function useSettingsBridge(): void {
  const applyMainSettingChange = useSettingsStore((s) => s.applyMainSettingChange);

  useEffect(() => {
    const api = window.api;
    if (api === undefined) {
      return;
    }
    const unsubscribe = api.settings.subscribeChanged((payload) => {
      applyMainSettingChange(payload.key, payload.value);
    });
    return () => {
      unsubscribe();
    };
  }, [applyMainSettingChange]);
}
