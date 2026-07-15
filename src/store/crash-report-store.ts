/**
 * @file 崩溃报告对话框的 Zustand store。
 *
 * 职责：保存待展示的崩溃报告数据，并控制对话框开关状态。
 *
 * 架构位置：
 *  - 后端在重启后通过 Tauri 命令查询上次崩溃数据 → 写入此 store；
 *  - CrashReportDialog 组件订阅 store 状态以决定是否显示。
 *
 * 不持久化：崩溃数据由 Rust 侧负责落盘，前端只做展示，重启后由后端重新拉取。
 */

import { create, type StateCreator } from 'zustand'
import { devtools } from 'zustand/middleware'
import type { CrashReportData } from '@/lib/tauri-bindings'

/**
 * CrashReport store 状态接口。
 *
 * 字段说明：
 *  - crashReportDialogOpen  对话框是否打开
 *  - pendingCrashReport    待展示的崩溃数据；为 null 表示无崩溃需要展示
 *
 * @see CrashReportData — Tauri 后端通过 src-tauri 生成的绑定类型
 */
export interface CrashReportState {
  /** 崩溃报告对话框是否打开（true 时显示 CrashReportDialog） */
  crashReportDialogOpen: boolean
  /** 待展示的崩溃数据；为 null 表示无崩溃需要展示 */
  pendingCrashReport: CrashReportData | null

  /**
   * 设置崩溃报告对话框开关。
   * 通常在用户关闭对话框或新崩溃数据到达时调用。
   */
  setCrashReportDialogOpen: (open: boolean) => void
  /**
   * 设置待展示的崩溃报告数据，传 null 清空。
   * 由应用启动时的崩溃检测逻辑调用：若检测到上次崩溃，写入数据并打开对话框。
   */
  setPendingCrashReport: (data: CrashReportData | null) => void
}

/**
 * store 实现：使用 devtools 中间件以便在 Redux DevTools 中查看变更历史。
 * 每次 set 调用第三参数为 action 名，便于 DevTools 中识别。
 */
const crashReportStoreCreator: StateCreator<
  CrashReportState,
  [['zustand/devtools', never]]
> = set => ({
  crashReportDialogOpen: false,
  pendingCrashReport: null,

  setCrashReportDialogOpen: (open: boolean) =>
    set({ crashReportDialogOpen: open }, undefined, 'setCrashReportDialogOpen'),

  setPendingCrashReport: (data: CrashReportData | null) =>
    set({ pendingCrashReport: data }, undefined, 'setPendingCrashReport'),
})

/**
 * 全局崩溃报告 store 单例。
 *
 * 使用方式：
 *  - React 组件：`const open = useCrashReportStore(s => s.crashReportDialogOpen)`
 *  - 非 React 模块：`useCrashReportStore.getState().setCrashReportDialogOpen(true)`
 */
export const useCrashReportStore = create<CrashReportState>()(
  devtools(crashReportStoreCreator, {
    name: 'crash-report-store',
  })
)
