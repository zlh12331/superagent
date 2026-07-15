/**
 * View Store — 视图切换与后退栈管理（Zustand）
 *
 * 对齐 prototype.html 的 switchView + viewHistory 功能。
 * 管理三视图切换：chat（对话）/ config（配置）/ remote（远程控制）
 * + 浏览器式后退栈（backBtn 行为）。
 *
 * 状态管理决策树位置：Zustand（纯 UI 状态，跨组件共享）
 *
 * 设计要点：
 *  - 不持久化（重启后回到默认对话视图，符合用户进入应用即对话的心智模型）；
 *  - 历史栈使用不可变更新（spread 复制），保证 Zustand 浅比较能感知变更触发重渲染；
 *  - canGoBack 派生字段：避免组件重复计算 viewHistory.length > 1；
 *  - 通过 devtools 中间件可在 Redux DevTools 中观察视图切换历史。
 */

import { create, type StateCreator } from 'zustand'
import { devtools } from 'zustand/middleware'

/** 视图类型：chat=对话 / config=配置 / remote=远程控制 */
export type AppView = 'chat' | 'config' | 'remote'

/** 默认视图：对话（应用启动后首屏） */
const DEFAULT_VIEW: AppView = 'chat'

/**
 * View store 状态接口。
 *
 * 字段说明：
 *  - activeView    当前激活的视图（决定 workspace 区域渲染哪个视图）
 *  - viewHistory   视图历史栈，最后一个元素为当前视图（用于后退导航）
 *  - canGoBack     是否可以后退（历史栈长度 > 1），派生字段，避免组件重复计算
 */
export interface ViewStoreState {
  /** 当前激活的视图 */
  activeView: AppView
  /** 视图历史栈（用于后退导航），最后一个元素为当前视图 */
  viewHistory: AppView[]
  /** 是否可以后退（历史栈长度 > 1） */
  canGoBack: boolean

  /**
   * 切换视图。
   * @param view        目标视图
   * @param pushHistory 是否推入历史栈：
   *                    - true（默认）：新增历史记录，用户可通过 goBack 回到上一个视图
   *                    - false：替换当前栈顶（用于后退等不希望再次入栈的场景）
   */
  switchView: (view: AppView, pushHistory?: boolean) => void
  /** 后退到上一个视图（对应原型的 backBtn 点击） */
  goBack: () => void
  /** 重置到默认视图（chat），清空历史栈 */
  resetView: () => void
}

/**
 * 根据历史栈计算 canGoBack 派生字段。
 * 抽出为工具函数，避免 switchView / goBack / resetView 三处重复逻辑。
 *
 * @param history 视图历史栈
 * @returns 历史栈长度 > 1 时返回 true（可以后退）
 */
function computeCanGoBack(history: AppView[]): boolean {
  return history.length > 1
}

/**
 * store 实现：初始视图为 chat，历史栈仅含 chat 一项，canGoBack=false。
 *
 * 所有 set 操作使用不可变更新（spread 复制数组），保证引用变更触发组件重渲染。
 */
const viewStoreCreator: StateCreator<
  ViewStoreState,
  [['zustand/devtools', never]]
> = set => ({
  activeView: DEFAULT_VIEW,
  viewHistory: [DEFAULT_VIEW],
  canGoBack: false,

  switchView: (view, pushHistory = true) =>
    set(
      state => {
        // 目标视图与当前一致：无操作，避免产生无效历史项
        if (view === state.activeView) {
          return state
        }

        let nextHistory: AppView[]
        if (pushHistory) {
          // 推入历史栈：保留所有历史项，追加新视图
          nextHistory = [...state.viewHistory, view]
        } else {
          // 替换栈顶：pop 当前视图后 push 新视图（保持栈长度不变）
          // 适用于后退等不希望再次入栈的场景
          nextHistory = [...state.viewHistory.slice(0, -1), view]
        }

        return {
          activeView: view,
          viewHistory: nextHistory,
          canGoBack: computeCanGoBack(nextHistory),
        }
      },
      undefined,
      'switchView'
    ),

  goBack: () =>
    set(
      state => {
        // 历史栈仅剩一项（已是初始视图）：无可后退目标，保持现状
        if (state.viewHistory.length <= 1) {
          return state
        }

        // pop 当前视图，activeView 回到栈顶（即新的最后一个元素）
        const nextHistory = state.viewHistory.slice(0, -1)
        // noUncheckedIndexedAccess: nextHistory 至少有 1 项（length > 1 后 slice 必非空），
        // 但 TS 无法推断，这里用 ?? 兜底确保类型安全
        const prevView = nextHistory[nextHistory.length - 1] ?? DEFAULT_VIEW

        return {
          activeView: prevView,
          viewHistory: nextHistory,
          canGoBack: computeCanGoBack(nextHistory),
        }
      },
      undefined,
      'goBack'
    ),

  resetView: () =>
    set(
      {
        activeView: DEFAULT_VIEW,
        viewHistory: [DEFAULT_VIEW],
        canGoBack: false,
      },
      undefined,
      'resetView'
    ),
})

/**
 * 全局视图状态 store 单例。
 *
 * 使用方式：
 *  - React 组件：`const activeView = useViewStore(s => s.activeView)`
 *  - 非 React 模块：`useViewStore.getState().switchView('config')`
 *
 * @see prototype.html switchView + viewHistory —— 原型实现，本 store 为其 React/TS 版本
 */
export const useViewStore = create<ViewStoreState>()(
  devtools(viewStoreCreator, {
    name: 'view-store',
  })
)
