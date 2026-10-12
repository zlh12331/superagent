// response.ts：IPC 跨进程契约原语 —— 统一响应联合体（IpcResponse）+ handler 上下文（IpcContext）+ 事件订阅器（StreamSubscriber）
// 边界：只定义类型形状，不含包装/生成逻辑（主进程 wrap 见 src/main/utils/wrap.ts；preload invoke/subscribe 见 src/preload/utils/ipc-bridge.ts）

import type { IpcError } from '../constants/errors';

/**
 * IPC 统一响应结构（业务失败也走返回值，不 reject）
 *
 * 成功：{ data: T }；失败：{ error: IpcError }——handler 抛出的异常由主进程 wrap() 归一为 IpcError
 * （src/main/utils/wrap.ts），调用方拿到的 Promise 不因业务失败而 reject
 *
 * 使用 discriminated union：渲染层取值统一经 src/renderer/lib/ipc.ts 的 unwrap()，
 * 勿手写 `'data' in resp` 判别（错误码解析与本地化文案也在该处收口）
 */
export type IpcResponse<T> = { readonly data: T } | { readonly error: IpcError };

/**
 * IPC handler 上下文：主进程 wrap() 构造后作为第二个参数注入 handler
 *
 * 与主进程专用的 IpcHandlerContext（src/main/utils/wrap.ts）是同一形状的两个视角——
 * 那边 sender 收窄为 WebContents、可直接调 webContents API；shared 包内没有 Electron
 * 类型，此处 sender 保持 unknown（透传引用，不做成员访问）
 */
export interface IpcContext {
  /** 一次调用的追踪 ID：preload invoke() 每次调用自动生成并随请求传入，主进程校验形状不合法时改为自行生成（贯穿规则见 docs/design/16-error-logging-spec.md §2.2） */
  readonly traceId: string;
  /** 调用方 WebContents（主进程用于反向推送流式事件） */
  readonly sender: unknown;
}

/**
 * 事件订阅器签名（渲染层用）：注册回调，返回 unsubscribe 函数
 *
 * 形状与定义表推出的事件方法一致（packages/shared/src/ipc/derive.ts 的 EventSignature）；
 * 调用方必须在组件卸载时调用 unsubscribe，否则监听器泄漏（preload subscribe 的实现约定）
 */
export type StreamSubscriber<TPayload> = (callback: (payload: TPayload) => void) => () => void;
