import { useEffect } from 'react';

import { useSettingsStore } from '@/stores/persistent/settings-store';

/** 订阅 store.editor.tabSize 并写入 --code-tab-size（AppShell 顶层挂载一次） */
export function useEditorCodeStyle(): void {
  const tabSize = useSettingsStore((s) => s.editor.tabSize);
  useEffect(() => {
    document.documentElement.style.setProperty('--code-tab-size', String(tabSize));
  }, [tabSize]);
}
