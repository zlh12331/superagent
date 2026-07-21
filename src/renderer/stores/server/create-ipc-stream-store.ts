// src/renderer/stores/server/create-ipc-stream-store.ts
// IPC 流式推送 Store 工厂（L4 流式推送状态层）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 统一封装「主进程持续推送 → 渲染层响应式状态」的订阅模式
// - 处理 IPC on 事件的订阅 / 取消订阅 / 累积 / 替换策略
// - 与 TanStack Query 的差异：TanStack Query 擅长请求-响应 + cache invalidation，
//   但 IPC on 是持续推送（如 chat part 逐 token / file-tree 变更 / tool 进度），
//   不适合用 invalidate 重取，应该用 Zustand 直接 set
//
// 设计要点：
// - 工厂返回 { useStore, subscribe, unsubscribe } 三件套
// - 订阅在 useEffect 中自动管理生命周期（mount 时订阅，unmount 时取消）
// - 提供 accumulate / replace 两种事件处理策略：
//   - accumulate：把新事件累积到数组（如 chat part 流）
//   - replace：用新事件整体替换状态（如 file-tree 全量推送）
// - 业务 store 通过传入 reducer 自定义事件 → state 的映射逻辑
// ──────────────────────────────────────────────────────────────

import { create, type StoreApi, type UseBoundStore } from 'zustand';

/**
 * IPC 事件订阅器接口
 *
 * 抽象出 ipcRenderer.on / off 的最小接口，便于测试 mock。
 * 业务方传入 window.api.on 的实现。
 */
export interface IpcSubscriber<TPayload> {
  /**
   * 订阅 IPC 事件
   *
   * @param channel IPC channel 名
   * @param listener 事件回调（接收 payload）
   * @returns 取消订阅函数（用于 useEffect cleanup）
   */
  subscribe: (channel: string, listener: (payload: TPayload) => void) => () => void;
}

/**
 * 事件 → state 的 reducer 函数
 *
 * 业务方传入此函数定义事件如何更新 state。
 *
 * @param prev 上一次的 state（未变更前）
 * @param payload IPC 事件推送的 payload
 * @returns 新的 state（不可变更新）
 */
export type StreamReducer<TState, TPayload> = (prev: TState, payload: TPayload) => TState;

/**
 * 创建 IPC 流式推送 Store
 *
 * @param initialState 初始状态
 * @param reducer 事件 → state 的 reducer
 * @param subscriber IPC 订阅器（通常为 window.api 的子集）
 * @param channel 订阅的 IPC channel
 *
 * @returns 包含 useStore hook 和 subscribe / unsubscribe 控制函数的对象
 *
 * @example
 * ```ts
 * // 1. 定义 state 与 payload 类型
 * interface FileTreeState { tree: FileNode | null }
 * interface FileTreeChangedPayload { tree: FileNode }
 *
 * // 2. 创建 store
 * const { useStore, subscribe, unsubscribe } = createIpcStreamStore<FileTreeState, FileTreeChangedPayload>(
 *   { tree: null },
 *   (prev, payload) => ({ tree: payload.tree }),  // replace 策略
 *   window.api.fileTree,  // 实现 IpcSubscriber
 *   'file-tree:changed',
 * );
 *
 * // 3. 在组件树顶层 useEffect 中订阅
 * useEffect(() => {
 *   subscribe();
 *   return unsubscribe;
 * }, []);
 *
 * // 4. 业务组件消费
 * const tree = useStore((s) => s.tree);
 * ```
 */
export function createIpcStreamStore<TState extends object, TPayload>(
  initialState: TState,
  reducer: StreamReducer<TState, TPayload>,
  subscriber: IpcSubscriber<TPayload>,
  channel: string,
): {
  /** Zustand store hook（业务组件消费状态） */
  readonly useStore: UseBoundStore<StoreApi<TState>>;
  /** 开始订阅 IPC 事件（在根组件 useEffect 中调用） */
  readonly subscribe: () => void;
  /** 取消订阅 IPC 事件（在根组件 useEffect cleanup 中调用） */
  readonly unsubscribe: () => void;
} {
  const useStore = create<TState>()(() => initialState);
  let unsubscribeFn: (() => void) | null = null;

  const subscribe = () => {
    if (unsubscribeFn !== null) {
      return;
    }
    unsubscribeFn = subscriber.subscribe(channel, (payload) => {
      useStore.setState((prev) => reducer(prev, payload));
    });
  };

  const unsubscribe = () => {
    if (unsubscribeFn !== null) {
      unsubscribeFn();
      unsubscribeFn = null;
    }
  };

  return { useStore, subscribe, unsubscribe };
}

/**
 * 常用 reducer：累积策略
 *
 * 把新事件 payload 追加到数组的末尾。
 * 适用于 chat part 流、tool 执行进度等需要保留历史的事件。
 *
 * @example
 * ```ts
 * createIpcStreamStore<{ parts: Part[] }, Part>(
 *   { parts: [] },
 *   accumulateReducer('parts'),
 *   subscriber,
 *   'chat:stream:part',
 * );
 * ```
 */
export function accumulateReducer<TState extends object, TPayload>(
  field: keyof TState,
): StreamReducer<TState, TPayload> {
  return (prev, payload) => {
    const arr = prev[field];
    if (!Array.isArray(arr)) {
      return prev;
    }
    return { ...prev, [field]: [...arr, payload] };
  };
}

/**
 * 常用 reducer：替换策略
 *
 * 用新事件 payload 整体替换指定字段。
 * 适用于 file-tree 全量推送、MCP 连接状态等事件。
 *
 * @example
 * ```ts
 * createIpcStreamStore<{ tree: FileNode | null }, { tree: FileNode }>(
 *   { tree: null },
 *   replaceReducer('tree'),
 *   subscriber,
 *   'file-tree:changed',
 * );
 * ```
 */
export function replaceReducer<TState extends object, TPayload>(
  field: keyof TState,
): StreamReducer<TState, TPayload> {
  return (prev, payload) => ({ ...prev, [field]: payload });
}
