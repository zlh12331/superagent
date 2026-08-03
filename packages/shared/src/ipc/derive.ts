// packages/shared/src/ipc/derive.ts
// 从 IPC 定义表推导类型与运行时产物的工具
// ──────────────────────────────────────────────────────────────
// 职责：
// 1. deriveChannels(defs)：运行时遍历定义表生成 IPC_CHANNELS 常量对象
//    （key 命名：{DOMAIN}_{METHOD} SCREAMING_SNAKE_CASE，如 app.getStatus → APP_GET_STATUS）
// 2. InferIpcApi<D>：推导 window.api 接口形状（替代手写 api.ts）
// 3. InferRequestMap<D> / InferEventMap<D>：推导 payloads.ts 的类型映射
//
// 设计：
// - 无入参方法（schema=null）推导为 () => Promise<IpcResponse<R>>
// - 事件方法推导为 (callback) => unsubscribe
// - 所有类型从定义表单一真源派生，杜绝手写漂移
// ──────────────────────────────────────────────────────────────

import type { z } from 'zod';

import type { IpcResponse } from './response';

/** 请求-响应定义形状 */
interface RequestDefLike {
  readonly kind: 'request';
  readonly channel: string;
  readonly schema: z.ZodType | null;
  readonly res: unknown;
}

/** 事件定义形状 */
interface EventDefLike {
  readonly kind: 'event';
  readonly channel: string;
  readonly payload: unknown;
}

/** 元数据条目形状（channel + kind，无 schema） */
interface MetaEntryLike {
  readonly kind: 'request' | 'event';
  readonly channel: string;
}

/** camelCase + ':' → snake_case（类型层面：listRecentDirs → list_recent_dirs；stream:part → stream_part） */
type SnakeCase<S extends string> = S extends `${infer Head}${infer Rest}`
  ? Head extends ':'
    ? `_${SnakeCase<Rest>}`
    : Head extends Uppercase<Head>
      ? Head extends Lowercase<Head>
        ? `${Head}${SnakeCase<Rest>}`
        : `_${Lowercase<Head>}${SnakeCase<Rest>}`
      : `${Head}${SnakeCase<Rest>}`
  : '';

/** 生成器产出的 key 类型：从 channel 推导（app:getStatus → APP_GET_STATUS；chat:stream:part → CHAT_STREAM_PART） */
type ChannelKey<D, K extends keyof D, M extends keyof D[K]> = D[K][M] extends {
  readonly channel: infer C;
}
  ? C extends `${string & K}:${infer Rest}`
    ? Uppercase<`${string & K}_${SnakeCase<Rest>}`>
    : never
  : never;

/**
 * 从元数据表生成 IPC_CHANNELS 常量对象
 *
 * key 命名：{DOMAIN}_{METHOD}（SCREAMING_SNAKE_CASE）
 * 例如：app.getStatus → APP_GET_STATUS；session.listRecentDirs → SESSION_LIST_RECENT_DIRS
 *
 * @param meta IPC 元数据表（IPC_META，纯字符串零依赖）
 * @returns 与现有 IPC_CHANNELS 结构完全兼容的常量对象
 */
export function deriveChannels<D extends Record<string, Record<string, MetaEntryLike>>>(
  defs: D,
): {
  readonly [K in keyof D as ChannelKey<D, K, keyof D[K]>]: string;
} {
  const result: Record<string, string> = {};
  for (const methods of Object.values(defs)) {
    for (const def of Object.values(methods)) {
      // key 从 channel 推导（app:getStatus → APP_GET_STATUS），与既有 IPC_CHANNELS 完全兼容
      const key = toConstantKey(def.channel);
      result[key] = def.channel;
    }
  }
  return result as never;
}

/** channel → SCREAMING_SNAKE_CASE（app:getStatus → APP_GET_STATUS；chat:stream:part → CHAT_STREAM_PART） */
function toConstantKey(channel: string): string {
  // channel 格式 {domain}:{rest}，rest 可能含 ':'（如 stream:part / event:created）
  const [domain, ...rest] = channel.split(':');
  const restSnake = (rest ?? [])
    .map((seg) => seg.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`))
    .join('_');
  return `${domain}_${restSnake}`.toUpperCase();
}

// ─── 类型推导 ─────────────────────────────────────────────────

/** 提取域内所有 request 方法名 */
type RequestMethods<D, Domain extends keyof D> = {
  [M in keyof D[Domain]]: D[Domain][M] extends RequestDefLike ? M : never;
}[keyof D[Domain]];

/** 入参类型：schema=null → void；否则取 zod input 类型 */
type ReqOf<S> = S extends null ? void : S extends z.ZodType ? z.input<S> : never;

/** 单个 request 方法的调用签名（无入参时不生成 input 参数） */
type RequestSignature<Def> = Def extends {
  readonly kind: 'request';
  readonly schema: infer S;
  readonly res: infer R;
}
  ? ReqOf<S> extends void
    ? () => Promise<IpcResponse<R>>
    : (input: ReqOf<S>) => Promise<IpcResponse<R>>
  : never;

/** 单个 event 方法的订阅签名 */
type EventSignature<Def> = Def extends { readonly kind: 'event'; readonly payload: infer P }
  ? (callback: (payload: P) => void) => () => void
  : never;

/**
 * 从定义表推导 IpcApi 接口（替代手写 api.ts）
 *
 * @example
 * ```ts
 * export type IpcApi = InferIpcApi<typeof IPC_DEFINITIONS>;
 * ```
 */
export type InferIpcApi<D extends Record<string, Record<string, RequestDefLike | EventDefLike>>> = {
  // -readonly：显式移除 as const 源的 readonly（保证测试可覆盖域属性）
  -readonly [Domain in keyof D]: {
    -readonly [M in keyof D[Domain]]: D[Domain][M] extends RequestDefLike
      ? RequestSignature<D[Domain][M]>
      : EventSignature<D[Domain][M]>;
  };
}; /** 定义表条目 → [channel, { req, res }] 元组（用于构造 IpcRequestMap） */
type RequestEntry<Def> = Def extends {
  readonly kind: 'request';
  readonly channel: infer C;
  readonly schema: infer S;
  readonly res: infer R;
}
  ? [C, { req: ReqOf<S>; res: R }]
  : never;

/**
 * 从定义表推导 IpcRequestMap（替代手写 payloads.ts 映射）
 */
export type InferRequestMap<
  D extends Record<string, Record<string, RequestDefLike | EventDefLike>>,
> = {
  [Domain in keyof D]: {
    [M in keyof D[Domain]]: RequestEntry<D[Domain][M]>;
  }[keyof D[Domain]];
}[keyof D] extends infer E
  ? E extends [infer C, infer V]
    ? C extends string
      ? { [K in C]: V }
      : never
    : never
  : never;

/** 定义表条目 → [channel, payload] 元组（用于构造 IpcEventMap） */
type EventEntry<Def> = Def extends {
  readonly kind: 'event';
  readonly channel: infer C;
  readonly payload: infer P;
}
  ? [C, P]
  : never;

/**
 * 从定义表推导 IpcEventMap（替代手写 payloads.ts 事件映射）
 */
export type InferEventMap<D extends Record<string, Record<string, RequestDefLike | EventDefLike>>> =
  {
    [Domain in keyof D]: {
      [M in keyof D[Domain]]: EventEntry<D[Domain][M]>;
    }[keyof D[Domain]];
  }[keyof D] extends infer E
    ? E extends [infer C, infer P]
      ? C extends string
        ? { [K in C]: P }
        : never
      : never
    : never;

/** 定义表 request 方法的处理器签名（供 registerIpcHandlers 推导 handler 对象） */
export type HandlerSignature<Def> = Def extends {
  readonly kind: 'request';
  readonly schema: infer S;
  readonly res: infer R;
}
  ? (input: ReqOf<S>, ctx: never) => Promise<R>
  : never;

/**
 * 从定义表推导 handler 实现对象形状
 *
 * 缺失任一 request 方法的 handler → 编译期报错（通道↔handler 一致性保证）
 */
export type InferHandlers<D extends Record<string, Record<string, RequestDefLike | EventDefLike>>> =
  {
    [Domain in keyof D]: {
      [M in RequestMethods<D, Domain>]: HandlerSignature<D[Domain][M]>;
    };
  };
