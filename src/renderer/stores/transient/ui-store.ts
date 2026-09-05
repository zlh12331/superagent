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
  /** 命令面板是否打开（多入口：顶栏按钮 / Ctrl+P / Ctrl+K / 错误动作；集中到 store 避免双模式） */
  readonly paletteOpen: boolean;
  /** 打开命令面板 */
  readonly openPalette: () => void;
  /** 关闭命令面板 */
  readonly closePalette: () => void;
  /** 快捷键帮助对话框是否打开（多入口：Topbar 快捷键 / /help 命令；集中到 store，
   *  收敛此前 AppShell + ChatPanel 双份 state 双份挂载——单一 lazy 实例服务多入口） */
  readonly shortcutHelpOpen: boolean;
  /** 打开快捷键帮助对话框 */
  readonly openShortcutHelp: () => void;
  /** 关闭快捷键帮助对话框 */
  readonly closeShortcutHelp: () => void;
  /** 侧栏视图（文件树为独立视图：对齐参考项目 codex.openFileTree 命令切换，不进头部 tab） */
  readonly sidebarView: 'threads' | 'fileTree';
  /** 切换侧栏视图 */
  readonly setSidebarView: (view: 'threads' | 'fileTree') => void;

  // ── 面板折叠状态（多入口统一状态源：快捷键 / 命令面板 / Topbar / 断点联动）──
  // 对齐参考项目：状态在 store，命令系统操作 store（toggle-left/right-sidebar 命令）
  /** 左侧栏是否折叠 */
  readonly sidebarCollapsed: boolean;
  /** 右侧栏是否折叠 */
  readonly rightPanelCollapsed: boolean;
  /** 用户是否手动操作过侧栏（断点自动折叠不再覆盖手动意图） */
  readonly sidebarManual: boolean;
  /** 用户是否手动操作过右面板 */
  readonly rightPanelManual: boolean;
  /** 设置侧栏折叠态 */
  readonly setSidebarCollapsed: (collapsed: boolean) => void;
  /** 设置右面板折叠态 */
  readonly setRightPanelCollapsed: (collapsed: boolean) => void;
  /** 切换侧栏折叠（置位 manual，断点不再覆盖） */
  readonly toggleSidebar: () => void;
  /** 切换右面板折叠（置位 manual，断点不再覆盖） */
  readonly toggleRightPanel: () => void;

  // ── DevPanel 激活 tab（命令面板「打开终端」等入口跨组件控制）──
  /** 右面板当前激活的 tab（对齐参考项目 codex.openTerminal 命令切换） */
  readonly devPanelTab: 'info' | 'diff' | 'file' | 'browser' | 'terminal' | 'dev';
  /** 设置右面板激活 tab */
  readonly setDevPanelTab: (tab: 'info' | 'diff' | 'file' | 'browser' | 'terminal' | 'dev') => void;
}

export const useUiStore = create<UiState>()((set) => ({
  settingsOpen: false,
  openSettings: () => set({ settingsOpen: true }),
  closeSettings: () => set({ settingsOpen: false }),
  paletteOpen: false,
  openPalette: () => set({ paletteOpen: true }),
  closePalette: () => set({ paletteOpen: false }),
  shortcutHelpOpen: false,
  openShortcutHelp: () => set({ shortcutHelpOpen: true }),
  closeShortcutHelp: () => set({ shortcutHelpOpen: false }),
  sidebarView: 'threads',
  setSidebarView: (view) => set({ sidebarView: view }),

  sidebarCollapsed: false,
  rightPanelCollapsed: false,
  sidebarManual: false,
  rightPanelManual: false,
  setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),
  setRightPanelCollapsed: (collapsed) => set({ rightPanelCollapsed: collapsed }),
  toggleSidebar: () =>
    set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed, sidebarManual: true })),
  toggleRightPanel: () =>
    set((state) => ({
      rightPanelCollapsed: !state.rightPanelCollapsed,
      rightPanelManual: true,
    })),

  devPanelTab: 'info',
  setDevPanelTab: (tab) => set({ devPanelTab: tab }),
}));
