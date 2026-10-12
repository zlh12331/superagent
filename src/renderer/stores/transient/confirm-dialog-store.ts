import { create } from 'zustand';

/** 确认对话框请求参数 */
export interface ConfirmOptions {
  /** 对话框标题 */
  title: string;
  /** 正文描述 */
  message: string;
  /** 确认按钮文案（默认 i18n common.confirm） */
  confirmText?: string;
  /** 取消按钮文案（默认 i18n common.cancel） */
  cancelText?: string;
  /** 是否为破坏性操作（true → 确认按钮红色 danger 样式） */
  danger?: boolean;
}

/** 输入对话框请求参数 */
export interface PromptOptions {
  /** 对话框标题 */
  title: string;
  /** 输入框上方标签 */
  label: string;
  /** 输入框默认值 */
  defaultValue?: string;
  /** 确认按钮文案（默认 i18n common.confirm） */
  confirmText?: string;
  /** 取消按钮文案（默认 i18n common.cancel） */
  cancelText?: string;
  /** 输入框 placeholder */
  placeholder?: string;
}

/** 内部请求结构：resolver 持有外层 Promise 的 resolve 函数，DialogHost 调用后结束 await */
interface DialogRequest {
  readonly kind: 'confirm' | 'prompt';
  readonly confirmOptions?: ConfirmOptions;
  readonly promptOptions?: PromptOptions;
  readonly resolver: (result: boolean | string | null) => void;
}

interface ConfirmDialogState {
  /** 当前待处理的请求（null 表示无弹窗显示） */
  readonly currentRequest: DialogRequest | null;
  /** 排队等待的请求队列（同时只显示一个弹窗） */
  readonly queue: readonly DialogRequest[];

  /** 内部方法：推入队列；无弹窗时立即激活，否则排队。返回 Promise */
  readonly _enqueue: (request: Omit<DialogRequest, 'resolver'>) => Promise<boolean | string | null>;
  /** 内部方法：DialogHost 在用户做出选择后调用；先 resolve 再从队列取下一个激活 */
  readonly _resolve: (result: boolean | string | null) => void;
}

export const useConfirmDialogStore = create<ConfirmDialogState>()((set, get) => ({
  currentRequest: null,
  queue: [],

  _enqueue: (request) => {
    return new Promise<boolean | string | null>((resolve) => {
      const fullRequest: DialogRequest = { ...request, resolver: resolve };
      const state = get();
      if (state.currentRequest === null) {
        set({ currentRequest: fullRequest });
      } else {
        set((s) => ({ queue: [...s.queue, fullRequest] }));
      }
    });
  },

  _resolve: (result) => {
    const state = get();
    if (state.currentRequest === null) return;

    state.currentRequest.resolver(result);

    const nextRequest = state.queue[0] ?? null;
    set((s) => ({
      currentRequest: nextRequest,
      queue: nextRequest ? s.queue.slice(1) : s.queue,
    }));
  },
}));

/**
 * 弹出确认对话框，返回 Promise<boolean>。
 * 确认 → true；取消/关闭/Esc/遮罩 → false。
 */
export function confirm(options: ConfirmOptions): Promise<boolean> {
  return useConfirmDialogStore
    .getState()
    ._enqueue({ kind: 'confirm', confirmOptions: options })
    .then((result) => result === true);
}

/**
 * 弹出输入对话框，返回 Promise<string | null>。
 * 确认 → trim 后的字符串（可能为空串）；取消/关闭/Esc/遮罩 → null。
 */
export function prompt(options: PromptOptions): Promise<string | null> {
  return useConfirmDialogStore
    .getState()
    ._enqueue({ kind: 'prompt', promptOptions: options })
    .then((result) => (typeof result === 'string' ? result : null));
}
