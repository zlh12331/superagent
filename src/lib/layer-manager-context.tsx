/**
 * @file 层级管理器（LayerManager）Context 与 Hooks。
 *
 * 对齐 prototype.html 行 9474-9575 的 LayerManager 单例，在 React 中以
 * Context + Hook 的方式等价实现"弹窗/抽屉层级栈"管理能力。
 *
 * 核心职责：
 *  1. 栈式管理模态层（后进先出），记录每个层级的关闭回调；
 *  2. closeTop()：关闭栈顶层级（供 Esc 兜底场景调用）；
 *  3. closeAll()：从栈顶到栈底依次关闭所有层级（含抽屉）；
 *  4. isTopLayer(id)：判断某层级是否处于栈顶（用于决定是否响应快捷键）。
 *
 * 设计说明（与原型 / 现有代码的差异）：
 *  - 不在此处实现 Tab 焦点陷阱（focus trap）：Radix UI Dialog 已内置；
 *  - 不在此处实现全局 Esc 监听：MainWindow 的 Esc 协调器仍负责 Radix 弹窗
 *    的优先级链关闭，本 hook 仅暴露 closeTop() / closeAll() 供需要时调用；
 *  - 不在此处管理 mainEl.inert：MainWindow 已通过 anyDialogOpen + ref
 *    统一管理主内容区 inert 属性，避免重复设置造成冲突；
 *  - 主要补充能力：统一的层级栈记录（多弹窗嵌套时知道谁在上面）+ closeAll
 *    涵盖抽屉（dialog-store.closeAllDialogs 不含抽屉，抽屉是 MainWindow 本地状态）。
 *
 * 消费方式：
 *  - 应用根节点包裹 <LayerManagerProvider>；
 *  - 弹窗 / 抽屉组件调用 useLayerRegistration(id, isOpen, close, isDrawer?) 注册；
 *  - 需要批量关闭时调用 useLayerManager()?.closeAll()。
 *
 * 当前消费状态（J1 修复时确认）：
 *  - LayerManagerProvider：已被 App.tsx 使用，包裹在应用根节点 ✅
 *  - useLayerRegistration：API 已就绪，暂无外部弹窗组件接入 ⚠️
 *  - useLayerManager：仅被 useLayerRegistration 内部调用 ⚠️
 *
 * 保留策略：
 *  此文件为基础设施层代码，Provider 已接入应用根节点。
 *  useLayerRegistration 虽暂无外部消费方，但其 API 稳定、实现完整、
 *  注释充分，后续弹窗组件（如 PreferencesDialog、AccountDialog 等）
 *  可按需接入以获得 closeAll / isTopLayer 能力。
 *  按"最安全方案"保留全部代码，不删除导出，避免破坏 App.tsx 依赖。
 */

/* eslint-disable react-refresh/only-export-components -- 任务要求 Provider 与 hooks 同文件存放，Fast Refresh 开发态偶发全量刷新可接受 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'

/**
 * 层级条目：记录单个弹窗 / 抽屉的元信息。
 *
 * 每个条目对应栈中的一层；close 被调用时该层级应执行自身的关闭逻辑
 * （如 setState(false)），关闭后由注册方的 effect cleanup 触发注销。
 */
interface LayerEntry {
  /** 唯一标识（建议稳定，如 'preferences-dialog'） */
  id: string
  /** 关闭函数：调用后该层级应从打开状态变为关闭 */
  close: () => void
  /**
   * 是否为抽屉（非 Radix Dialog 的浮层）。
   * 抽屉通常由 MainWindow 本地状态控制，closeAll 需要一并覆盖。
   * 未提供时视为普通 Radix 弹窗。
   */
  isDrawer?: boolean
}

/**
 * LayerManager Context 暴露给消费方的接口。
 */
export interface LayerManagerContextValue {
  /** 注册一个层级（弹窗打开时由 useLayerRegistration 自动调用） */
  registerLayer: (entry: LayerEntry) => void
  /** 注销一个层级（弹窗关闭时由 useLayerRegistration 自动调用） */
  unregisterLayer: (id: string) => void
  /** 关闭栈顶层级（调用栈顶 entry 的 close） */
  closeTop: () => void
  /** 关闭所有层级（从栈顶到栈底依次调用 close，含抽屉） */
  closeAll: () => void
  /** 判断指定 id 是否为当前栈顶（用于决定是否响应快捷键） */
  isTopLayer: (id: string) => boolean
  /** 当前栈深度（仅用于触发消费方 re-render，使 isTopLayer 返回值刷新） */
  depth: number
}

// Context 默认值为 null，消费方通过 useLayerManager() 获取并做空值检查
const LayerManagerContext = createContext<LayerManagerContextValue | null>(
  null
)

/**
 * LayerManager Provider 组件。
 *
 * 包裹在应用根节点，为子树提供层级栈管理能力。内部使用 ref 存储真实栈数据
 * （避免每次 push / pop 触发全量 re-render），仅用 depth state 在栈深度变化时
 * 通知消费方刷新（使 useLayerRegistration 返回的"是否栈顶"保持准确）。
 *
 * @param children - 子节点
 */
export function LayerManagerProvider({ children }: { children: ReactNode }) {
  // 真实层级栈数据（ref，不直接驱动渲染）
  const stackRef = useRef<LayerEntry[]>([])
  // 栈深度 state（仅用于触发消费方 re-render）
  const [depth, setDepth] = useState(0)

  /**
   * 注册层级：推入栈顶并刷新 depth。
   * 使用 useCallback 保证引用稳定，避免消费方 effect 因函数引用变化而重复执行。
   */
  const registerLayer = useCallback((entry: LayerEntry) => {
    stackRef.current.push(entry)
    setDepth(stackRef.current.length)
  }, [])

  /**
   * 注销层级：按 id 移除并刷新 depth。若 id 不存在则忽略（幂等）。
   */
  const unregisterLayer = useCallback((id: string) => {
    const stack = stackRef.current
    const idx = stack.findIndex(entry => entry.id === id)
    if (idx !== -1) {
      stack.splice(idx, 1)
      setDepth(stack.length)
    }
  }, [])

  /**
   * 关闭栈顶层级：调用栈顶 entry 的 close()。
   * close() 会触发注册方的 effect cleanup → unregisterLayer，完成出栈。
   * 栈为空时为空操作。
   */
  const closeTop = useCallback(() => {
    const stack = stackRef.current
    const top = stack[stack.length - 1]
    top?.close()
  }, [])

  /**
   * 关闭所有层级：从栈顶到栈底依次调用 close()。
   * 先复制一份快照，避免遍历过程中 close() 触发的出栈修改原数组导致漏关。
   */
  const closeAll = useCallback(() => {
    const snapshot = [...stackRef.current]
    // 从栈顶（末尾）向栈底（开头）依次关闭
    for (let i = snapshot.length - 1; i >= 0; i--) {
      snapshot[i]?.close()
    }
  }, [])

  /**
   * 判断指定 id 是否为栈顶层级，供 useLayerRegistration 返回"是否响应 Esc"使用。
   */
  const isTopLayer = useCallback((id: string) => {
    const stack = stackRef.current
    const top = stack[stack.length - 1]
    return top?.id === id
  }, [])

  // 组装 context value，仅在 depth 变化时产生新引用（其余方法均 useCallback 稳定）
  const value = useMemo<LayerManagerContextValue>(
    () => ({
      registerLayer,
      unregisterLayer,
      closeTop,
      closeAll,
      isTopLayer,
      depth,
    }),
    [registerLayer, unregisterLayer, closeTop, closeAll, isTopLayer, depth]
  )

  return (
    <LayerManagerContext.Provider value={value}>
      {children}
    </LayerManagerContext.Provider>
  )
}

/**
 * 消费 LayerManager Context 的 hook。
 *
 * @returns context value；未包裹 Provider 时返回 null（调用方需做空值检查）
 */
export function useLayerManager(): LayerManagerContextValue | null {
  return useContext(LayerManagerContext)
}

/**
 * 便捷 hook：注册 / 注销一个弹窗或抽屉层级。
 *
 * 工作原理：
 *  - isOpen 由 false→true 时，调用 registerLayer 将当前层级推入栈；
 *  - isOpen 由 true→false 或组件卸载时，通过 effect cleanup 调用
 *    unregisterLayer 出栈；
 *  - close 回调用 ref 保存最新引用，避免 close 函数身份变化导致重复注册。
 *
 * @param id       - 层级唯一标识（建议稳定，如 'preferences-dialog'）
 * @param isOpen   - 当前层级是否打开
 * @param close    - 关闭函数（调用后使 isOpen 变为 false）
 * @param isDrawer - 是否为抽屉（可选，true 时 closeAll 会一并覆盖）
 * @returns 当前是否为栈顶层级（isOpen 为 false 或无 Provider 时返回 false）
 */
export function useLayerRegistration(
  id: string,
  isOpen: boolean,
  close: () => void,
  isDrawer?: boolean
): boolean {
  const ctx = useLayerManager()
  // 提取稳定的函数引用，避免整个 ctx 对象变化（depth 变化时）触发 effect 重跑
  const registerLayer = ctx?.registerLayer
  const unregisterLayer = ctx?.unregisterLayer

  // 用 ref 保存最新的 close，注册时通过 ref 间接调用，避免 close 引用变化导致重复注册
  const closeRef = useRef(close)
  useEffect(() => {
    closeRef.current = close
  }, [close])

  useEffect(() => {
    // 无 Provider 或未打开时不注册
    if (!registerLayer || !isOpen) return
    // 构造层级条目：isDrawer 为 true 时才写入该字段
    // （exactOptionalPropertyTypes 模式下可选属性不可显式赋值为 undefined）
    const entry: LayerEntry = isDrawer
      ? { id, close: () => closeRef.current(), isDrawer: true }
      : { id, close: () => closeRef.current() }
    registerLayer(entry)
    // cleanup：层级关闭或组件卸载时注销
    return () => {
      unregisterLayer?.(id)
    }
  }, [registerLayer, unregisterLayer, isOpen, id, isDrawer])

  // 返回是否为栈顶：ctx 变化（depth 变化）触发 re-render 使本值刷新
  if (!ctx || !isOpen) return false
  return ctx.isTopLayer(id)
}
