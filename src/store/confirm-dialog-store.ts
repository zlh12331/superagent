/**
 * @file 命令式确认/输入对话框 store
 *
 * 对齐原型 `showConfirmDialog` / `showPromptDialog`（prototype.html L9383-9472）。
 * 原型使用命令式调用（弹出对话框 + 回调），React 版改为 Promise 返回值，
 * 调用方可使用 await 等待用户选择，代码结构与原 window.confirm 一致：
 *
 * ```ts
 * // 旧代码（window.confirm）
 * if (!window.confirm('确定删除？')) return
 *
 * // 新代码（本 store 提供的 confirm）
 * if (!await confirm({ title: '确认删除', message: '确定删除？', danger: true })) return
 * ```
 *
 * 设计要点（低耦合高内聚）：
 *  - store 只保存"当前请求"和"resolver"，不关心 UI 渲染
 *  - DialogHost 组件订阅 store 变化，负责实际渲染 AlertDialog
 *  - 调用方只导入 `confirm` / `prompt` 函数，无需引入任何 React 组件
 *  - 同时只允许一个 confirm/prompt 请求（后到的会排队等待前一个 resolve）
 *
 * 非持久化：重启后清空，避免遗留 resolver 导致 Promise 永远 pending。
 */

import { create, type StateCreator } from 'zustand'
import { devtools } from 'zustand/middleware'

// ===== 请求类型 =====

/**
 * 确认对话框请求参数
 *
 * 对齐原型 showConfirmDialog(title, message, onConfirm, opts) 的参数：
 *  - title: 对话框标题
 *  - message: 正文描述
 *  - confirmText: 确认按钮文案（默认"确认"）
 *  - cancelText: 取消按钮文案（默认"取消"）
 *  - danger: 是否为破坏性操作（true 时确认按钮为红色 danger 样式）
 */
export interface ConfirmOptions {
  /** 对话框标题（对齐原型 modal-title） */
  title: string
  /** 正文描述（对齐原型 modal-body 文本） */
  message: string
  /** 确认按钮文案，默认"确认" */
  confirmText?: string
  /** 取消按钮文案，默认"取消" */
  cancelText?: string
  /**
   * 是否为破坏性操作。
   * true → 确认按钮使用 danger 红色样式（对齐原型 btn danger）
   * false → 确认按钮使用 accent 样式（对齐原型 btn accent）
   */
  danger?: boolean
}

/**
 * 输入对话框请求参数
 *
 * 对齐原型 showPromptDialog(title, label, defaultValue, onConfirm) 的参数。
 */
export interface PromptOptions {
  /** 对话框标题 */
  title: string
  /** 输入框上方标签（对齐原型 label） */
  label: string
  /** 输入框默认值（对齐原型 defaultValue） */
  defaultValue?: string
  /** 确认按钮文案，默认"确认" */
  confirmText?: string
  /** 取消按钮文案，默认"取消" */
  cancelText?: string
  /** 输入框 placeholder（原型无此字段，React 扩展） */
  placeholder?: string
}

/**
 * 内部请求结构 — 统一表示一次 confirm 或 prompt 请求
 *
 * `resolver` 字段持有外层 Promise 的 resolve 函数，
 * DialogHost 在用户点击按钮后调用 resolver 传递结果。
 */
interface DialogRequest {
  /** 请求类型：confirm 或 prompt */
  kind: 'confirm' | 'prompt'
  /** confirm 请求的参数（kind='confirm' 时存在） */
  confirmOptions?: ConfirmOptions
  /** prompt 请求的参数（kind='prompt' 时存在） */
  promptOptions?: PromptOptions
  /** 外层 Promise 的 resolve 函数 — DialogHost 调用后结束 await */
  resolver: (result: boolean | string | null) => void
}

// ===== Store 接口 =====

/**
 * 命令式对话框 store 状态接口
 */
export interface ConfirmDialogState {
  /** 当前待处理的请求（null 表示无弹窗显示） */
  currentRequest: DialogRequest | null
  /** 排队等待的请求队列（同时只显示一个弹窗，后到的排队） */
  queue: DialogRequest[]

  /**
   * 内部方法：将请求推入队列。
   * 若当前无弹窗显示则立即激活，否则排队等待。
   * 返回 Promise，在 DialogHost 调用 resolver 后 resolve。
   */
  _enqueue: (request: Omit<DialogRequest, 'resolver'>) => Promise<boolean | string | null>
  /**
   * 内部方法：DialogHost 在用户做出选择后调用。
   * 调用 resolver 传递结果，然后从队列取出下一个请求激活。
   */
  _resolve: (result: boolean | string | null) => void
}

// ===== Store 实现 =====

const confirmDialogStoreCreator: StateCreator<
  ConfirmDialogState,
  [['zustand/devtools', never]]
> = (set, get) => ({
  currentRequest: null,
  queue: [],

  _enqueue: (request) => {
    return new Promise<boolean | string | null>((resolve) => {
      const fullRequest: DialogRequest = { ...request, resolver: resolve }
      const state = get()
      // 当前无弹窗 → 立即激活；否则排队
      if (state.currentRequest === null) {
        set({ currentRequest: fullRequest }, undefined, '_enqueue/activate')
      } else {
        set(
          (s: ConfirmDialogState) => ({ queue: [...s.queue, fullRequest] }),
          undefined,
          '_enqueue/queue'
        )
      }
    })
  },

  _resolve: (result) => {
    const state = get()
    if (state.currentRequest === null) return

    // 先调用 resolver 结束外层 Promise
    state.currentRequest.resolver(result)

    // 从队列取下一个请求激活（FIFO）
    const nextRequest = state.queue[0] ?? null
    set(
      (s: ConfirmDialogState) => ({
        currentRequest: nextRequest,
        queue: nextRequest ? s.queue.slice(1) : s.queue,
      }),
      undefined,
      '_resolve/next'
    )
  },
})

/**
 * 命令式对话框 store 单例。
 *
 * 调用方不直接使用此 store，而是使用下方导出的 `confirm` / `prompt` 便捷函数。
 * DialogHost 组件通过 `useConfirmDialogStore` 订阅状态变化渲染弹窗。
 */
export const useConfirmDialogStore = create<ConfirmDialogState>()(
  devtools(confirmDialogStoreCreator, {
    name: 'confirm-dialog-store',
  })
)

// ===== 公共便捷函数 =====

/**
 * 弹出确认对话框，返回 Promise<boolean>。
 *
 * - 用户点击"确认" → resolve(true)
 * - 用户点击"取消" / 关闭按钮 / Esc / 点击遮罩 → resolve(false)
 *
 * @example
 * ```ts
 * if (!await confirm({ title: '确认删除', message: '此操作不可撤销', danger: true })) {
 *   return // 用户取消
 * }
 * // 执行删除...
 * ```
 *
 * @param options 确认对话框参数
 * @returns 用户是否确认
 */
export function confirm(options: ConfirmOptions): Promise<boolean> {
  return useConfirmDialogStore
    .getState()
    ._enqueue({ kind: 'confirm', confirmOptions: options })
    .then((result) => result === true)
}

/**
 * 弹出输入对话框，返回 Promise<string | null>。
 *
 * - 用户点击"确认" → resolve(输入值 trim 后的字符串，可能为空串)
 * - 用户点击"取消" / 关闭按钮 / Esc / 点击遮罩 → resolve(null)
 *
 * @example
 * ```ts
 * const name = await prompt({ title: '重命名', label: '新名称', defaultValue: 'old.txt' })
 * if (name === null) return // 用户取消
 * // 执行重命名...
 * ```
 *
 * @param options 输入对话框参数
 * @returns 用户输入的字符串（trim 后），或 null 表示取消
 */
export function prompt(options: PromptOptions): Promise<string | null> {
  return useConfirmDialogStore
    .getState()
    ._enqueue({ kind: 'prompt', promptOptions: options })
    .then((result) => (typeof result === 'string' ? result : null))
}
