// src/renderer/stores/transient/ui-store.ts
// 全局 UI 瞬态状态（L2 transient 子层）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 全局设置对话框开关：Topbar / CommandPalette / 错误码恢复动作（error-actions）
//   共享同一入口，修复此前「快捷键 Meta+, 无法打开设置」与多挂载点问题
// - 仅存 UI 开关，不持久化（重启即失）
// ──────────────────────────────────────────────────────────────

import { create } from 'zustand';

interface UiState {
  /** 设置对话框是否打开 */
  readonly settingsOpen: boolean;
  /** 打开设置对话框 */
  readonly openSettings: () => void;
  /** 关闭设置对话框 */
  readonly closeSettings: () => void;
  /** 命令面板是否打开（多入口：顶栏按钮 / Ctrl+P / Shift+/ / 错误动作；集中到 store 避免双模式） */
  readonly paletteOpen: boolean;
  /** 打开命令面板 */
  readonly openPalette: () => void;
  /** 关闭命令面板 */
  readonly closePalette: () => void;
  /** 侧栏视图（文件树为独立视图：对齐参考项目 codex.openFileTree 命令切换，不进头部 tab） */
  readonly sidebarView: 'threads' | 'fileTree';
  /** 切换侧栏视图 */
  readonly setSidebarView: (view: 'threads' | 'fileTree') => void;
}

export const useUiStore = create<UiState>()((set) => ({
  settingsOpen: false,
  openSettings: () => set({ settingsOpen: true }),
  closeSettings: () => set({ settingsOpen: false }),
  paletteOpen: false,
  openPalette: () => set({ paletteOpen: true }),
  closePalette: () => set({ paletteOpen: false }),
  sidebarView: 'threads',
  setSidebarView: (view) => set({ sidebarView: view }),
}));
