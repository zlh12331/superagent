import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

interface SidebarPrefState {
  /** 拖拽排序覆盖：folderName → 会话 id 顺序（未覆盖的文件夹用服务端默认序） */
  readonly orderOverrides: Readonly<Record<string, readonly string[]>>;
  /** 折叠的文件夹名集合 */
  readonly collapsedFolders: readonly string[];
  /** 覆盖指定文件夹的会话顺序（空数组 = 清除覆盖） */
  readonly setOrderOverride: (folderName: string, sessionIds: readonly string[]) => void;
  /** 切换文件夹折叠态 */
  readonly toggleFolder: (folderName: string) => void;
}

export const useSidebarPrefStore = create<SidebarPrefState>()(
  persist(
    (set) => ({
      orderOverrides: {},
      collapsedFolders: [],
      setOrderOverride: (folderName, sessionIds) =>
        set((state) => {
          const next = { ...state.orderOverrides };
          if (sessionIds.length === 0) {
            delete next[folderName];
          } else {
            next[folderName] = sessionIds;
          }
          return { orderOverrides: next };
        }),
      toggleFolder: (folderName) =>
        set((state) => ({
          collapsedFolders: state.collapsedFolders.includes(folderName)
            ? state.collapsedFolders.filter((name) => name !== folderName)
            : [...state.collapsedFolders, folderName],
        })),
    }),
    {
      name: 'code-agent:sidebar-prefs',
      storage: createJSONStorage(() => localStorage),
    },
  ),
);
