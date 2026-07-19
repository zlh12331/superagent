// src/renderer/stores/ui.store.ts
// UI 客户端状态（Zustand 5）
// 设计文档 §4.10 Zustand 选择性订阅
//
// 职责：
// - 侧栏折叠状态
// - 活跃项目 ID（最近打开的项目）
// - 活跃路由 tab
//
// 不持久化（next-themes 已处理主题持久化，UI 偏好 Phase 8 视情况引入 persist 中间件）

import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';

/**
 * UI 客户端状态接口
 *
 * 仅保存与 UI 偏好相关的客户端状态，不涉及业务数据持久化。
 * 组件通过 selector 选择性订阅单个字段，避免无关状态变更触发重渲染。
 */
export interface UiState {
  /** 侧栏是否折叠 */
  sidebarCollapsed: boolean;
  /** 当前活跃项目 ID（最近打开的项目；null 表示未打开任何项目） */
  activeProjectId: string | null;
  /** 当前活跃路由 tab（null 表示未选中任何 tab） */
  activeTab: 'chapters' | 'characters' | 'worldview' | 'chat' | 'rag' | null;
  /** 切换侧栏折叠状态 */
  toggleSidebar: () => void;
  /** 直接设置侧栏折叠状态 */
  setSidebarCollapsed: (collapsed: boolean) => void;
  /** 设置活跃项目 ID（传 null 清空） */
  setActiveProject: (id: string | null) => void;
  /** 设置活跃 tab（传 null 清空） */
  setActiveTab: (tab: UiState['activeTab']) => void;
}

/**
 * UI 状态 store
 *
 * 使用 subscribeWithSelector 中间件以支持选择性订阅（设计文档 §4.10）。
 * Zustand 5 的 create 签名为双层调用：create<T>()(middleware(...))。
 *
 * @example
 * // 只订阅 sidebarCollapsed，其他字段变更不会触发重渲染
 * const collapsed = useUiStore((s) => s.sidebarCollapsed);
 */
export const useUiStore = create<UiState>()(
  subscribeWithSelector((set) => ({
    sidebarCollapsed: false,
    activeProjectId: null,
    activeTab: null,
    toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
    setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),
    setActiveProject: (id) => set({ activeProjectId: id }),
    setActiveTab: (tab) => set({ activeTab: tab }),
  })),
);
