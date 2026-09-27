// src/renderer/stores/persistent/sidebar-pref-store.test.ts
// 侧栏偏好 store 行为测试：orderOverrides 增/删 + collapsedFolders 切换

import { beforeEach, describe, expect, it } from 'vitest';

import { useSidebarPrefStore } from './sidebar-pref-store';

describe('useSidebarPrefStore', () => {
  beforeEach(() => {
    useSidebarPrefStore.setState({ orderOverrides: {}, collapsedFolders: [] });
    localStorage.clear();
  });

  it('初始为空覆盖 / 空折叠集合', () => {
    const state = useSidebarPrefStore.getState();
    expect(state.orderOverrides).toEqual({});
    expect(state.collapsedFolders).toEqual([]);
  });

  it('setOrderOverride 非空列表 → 写入指定文件夹顺序', () => {
    useSidebarPrefStore.getState().setOrderOverride('work', ['s2', 's1']);
    expect(useSidebarPrefStore.getState().orderOverrides).toEqual({ work: ['s2', 's1'] });
  });

  it('setOrderOverride 空数组 → 清除该文件夹覆盖（不影响其他文件夹）', () => {
    useSidebarPrefStore.getState().setOrderOverride('work', ['s2', 's1']);
    useSidebarPrefStore.getState().setOrderOverride('life', ['s9']);
    useSidebarPrefStore.getState().setOrderOverride('work', []);
    expect(useSidebarPrefStore.getState().orderOverrides).toEqual({ life: ['s9'] });
  });

  it('toggleFolder 未折叠 → 加入集合', () => {
    useSidebarPrefStore.getState().toggleFolder('work');
    expect(useSidebarPrefStore.getState().collapsedFolders).toEqual(['work']);
  });

  it('toggleFolder 已折叠 → 移出集合', () => {
    useSidebarPrefStore.getState().toggleFolder('work');
    useSidebarPrefStore.getState().toggleFolder('life');
    useSidebarPrefStore.getState().toggleFolder('work');
    expect(useSidebarPrefStore.getState().collapsedFolders).toEqual(['life']);
  });

  it('persist 到 localStorage（跨重启生效）', () => {
    useSidebarPrefStore.getState().setOrderOverride('work', ['s1']);
    useSidebarPrefStore.getState().toggleFolder('work');
    const raw = localStorage.getItem('code-agent:sidebar-prefs');
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw ?? '{}') as {
      state: { orderOverrides: Record<string, string[]>; collapsedFolders: string[] };
    };
    expect(parsed.state.orderOverrides).toEqual({ work: ['s1'] });
    expect(parsed.state.collapsedFolders).toEqual(['work']);
  });
});
