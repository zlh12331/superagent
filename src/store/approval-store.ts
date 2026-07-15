import { create, type StateCreator } from 'zustand'
import { devtools } from 'zustand/middleware'

/**
 * Approval Store — 审批请求临时状态
 *
 * 状态管理决策树位置：
 *   event → store → modal
 *   (codex-rs ServerRequest 事件 → approval-store → ApprovalModal)
 *
 * 该 store 不持久化（审批请求是临时性的）。
 * 当 codex-rs 发出 ServerRequest（如命令执行审批）时，
 * bridge/event.rs 通过 Tauri emit 将请求发送到前端，
 * 前端监听事件后调用 setPendingApproval 更新 store，
 * UI 响应 store 变化弹出审批弹窗。
 *
 * @see src/features/approval/ — 审批 UI 组件
 * @see src/lib/codex/approval.ts — 审批 API stub
 */

/**
 * 审批请求类型 — 7种，与 ApprovalVariant 对齐
 *
 * 对齐 src/features/demo/approval-variants.ts 的 ApprovalVariant：
 *   command / patch / tool / mcp / perm / dyn / attest
 *
 * 旧版 'file_change' 已合并到 'patch'，'permissions' 已重命名为 'perm'。
 */
export type ApprovalType =
  | 'command' // 命令执行审批
  | 'patch' // 文件变更 / 补丁应用审批
  | 'tool' // 工具输入请求
  | 'mcp' // MCP Elicitation
  | 'perm' // 权限授予审批
  | 'dyn' // 动态工具调用
  | 'attest' // Attestation 生成

/** 审批请求状态 */
export type ApprovalStatus = 'pending' | 'approved' | 'denied'

/** 待审批请求 */
export interface PendingApproval {
  /**
   * RequestId 序列化后的 JSON 字符串。
   * 来自后端 emit 的 ApprovalEventData.requestIdJson，
   * 前端原样回传给 approval_respond/reject 命令。
   */
  id: string
  /** 用于 UI 显示的简短字符串（如 "42" 或 "abc"） */
  requestIdDisplay: string
  /** 审批类型 */
  type: ApprovalType
  /** 请求内容（命令文本/文件路径/补丁内容 JSON） */
  payload: string
  /** 审批状态 */
  status: ApprovalStatus
}

export interface ApprovalState {
  /** 当前待审批请求（一次只显示一个，避免并发审批造成用户混乱） */
  pendingApproval: PendingApproval | null
  /** 历史审批记录（本次会话内，仅内存保存，不持久化跨会话） */
  history: PendingApproval[]

  /**
   * 设置待审批请求（替换当前 pendingApproval）。
   * 由 Tauri 事件监听器在后端 emit `approval-request` 事件时调用。
   * 并发保护：若已有 pendingApproval，旧请求会先标记为 denied 推入 history，
   * 避免被静默覆盖导致后端 turn 永久阻塞。
   */
  setPendingApproval: (approval: PendingApproval) => void
  /**
   * 批准当前请求：将当前 pendingApproval 标记为 approved 并移入 history。
   * 不直接调用后端 API —— 实际的 approval_respond 命令调用由 ApprovalModal 完成。
   */
  approveCurrent: () => void
  /**
   * 拒绝当前请求：将当前 pendingApproval 标记为 denied 并移入 history。
   * 同 approveCurrent，后端 approval_reject 命令由 ApprovalModal 调用。
   */
  denyCurrent: () => void
  /**
   * 清除当前请求（不写入 history）。
   * 用于异常情况或测试场景下重置状态，正常流程应使用 approveCurrent / denyCurrent。
   */
  clearCurrent: () => void
}

/**
 * store 实现：未引入 persist 中间件（审批请求是一次性的，重启即失效）。
 * 所有 action 第三参数为 action 名，便于在 Redux DevTools 中追踪。
 */
const approvalStoreCreator: StateCreator<
  ApprovalState,
  [['zustand/devtools', never]]
> = set => ({
  pendingApproval: null,
  history: [],

  setPendingApproval: approval =>
    set(
      (state: ApprovalState) => {
        // 并发审批修复（P0）：若已有 pending approval，先将旧请求标记为 denied
        // 推入 history，再设置新请求。避免新请求直接覆盖旧请求，导致后端
        // 永远等不到旧请求的响应而 turn 卡死。
        if (state.pendingApproval) {
          const superseded: PendingApproval = {
            ...state.pendingApproval,
            status: 'denied',
          }
          return {
            pendingApproval: approval,
            history: [...state.history, superseded],
          }
        }
        return { pendingApproval: approval }
      },
      undefined,
      'setPendingApproval'
    ),

  // 函数式 set 读取最新 state，避免闭包陈旧值；
  // 无 pendingApproval 时返回原 state 保持引用不变，跳过不必要的渲染。
  approveCurrent: () =>
    set(
      (state: ApprovalState) => {
        if (!state.pendingApproval) return state
        const approved: PendingApproval = {
          ...state.pendingApproval,
          status: 'approved',
        }
        return {
          pendingApproval: null,
          history: [...state.history, approved],
        }
      },
      undefined,
      'approveCurrent'
    ),

  // 同 approveCurrent，仅 status 字段不同。
  denyCurrent: () =>
    set(
      (state: ApprovalState) => {
        if (!state.pendingApproval) return state
        const denied: PendingApproval = {
          ...state.pendingApproval,
          status: 'denied',
        }
        return {
          pendingApproval: null,
          history: [...state.history, denied],
        }
      },
      undefined,
      'denyCurrent'
    ),

  clearCurrent: () => set({ pendingApproval: null }, undefined, 'clearCurrent'),
})

/**
 * 全局审批状态 store 单例。
 *
 * 使用方式：
 *  - React 组件：`const approval = useApprovalStore(s => s.pendingApproval)`
 *  - 非 React 模块（事件监听器）：`useApprovalStore.getState().setPendingApproval(...)`
 *
 * @see src/features/approval/ApprovalModal.tsx — 审批弹窗组件，订阅 pendingApproval
 * @see src/hooks/useApprovalListener.ts — 监听 Tauri 事件并写入 store
 */
export const useApprovalStore = create<ApprovalState>()(
  devtools(approvalStoreCreator, {
    name: 'approval-store',
  })
)
