// derive.ts：IPC 定义表（单一真源）→ 通道常量 + 类型映射的推导器
// 边界：只做形状推导，不含 zod 校验（校验在主进程 wrap 层）。两条产线——
// deriveChannels 运行时折叠 IPC_META 生成 IPC_CHANNELS；Infer* 系列在类型层
// 推导 IpcApi / 请求·事件映射 / handler 形状，消费方一律从定义表派生，杜绝手写漂移。

import type { z } from 'zod';

import type { IpcResponse } from './response';

// ─── 定义表条目形状 + 通道常量生成器 ───────────────────────────

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

/**
 * 生成器产出的 key 类型：从 channel 推导（app:getStatus → APP_GET_STATUS；chat:stream:part → CHAT_STREAM_PART）
 *
 * 折叠规则是运行时 toConstantKey 的类型层复刻，改一处必须同步另一处。
 */
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
 * @param defs IPC 元数据表（IPC_META，纯字符串零依赖）
 * @returns 与现有 IPC_CHANNELS 结构完全兼容的常量对象
 */
export function deriveChannels<D extends Record<string, Record<string, MetaEntryLike>>>(
  defs: D,
): {
  readonly [K in keyof D as ChannelKey<D, K, keyof D[K]>]: string;
} {
  const result: Record<string, string> = {};
  for (const [domain, methods] of Object.entries(defs)) {
    for (const def of Object.values(methods)) {
      // fail-fast：类型层 ChannelKey 与运行时 toConstantKey 是两套独立实现，域键与
      // channel 前缀不一致时，类型层产出 never（该常量从联合里静默消失）而运行时
      // 照常生成——两套真源静默分叉，故此处直接抛错而非放过
      if (!def.channel.startsWith(`${domain}:`)) {
        throw new Error(
          `IPC_META channel "${def.channel}" 与域键 "${domain}" 不匹配（channel 必须以 "${domain}:" 开头）`,
        );
      }
      // key 由 channel 折叠而来，理论上可撞名并被 result[key] 静默覆盖（丢通道不报错）；
      // 「键数 = 通道数」由契约测试兜底（packages/shared/src/__tests__/shared-gaps.test.ts）
      const key = toConstantKey(def.channel);
      result[key] = def.channel;
    }
  }
  // 循环只写得出 Record<string, string>，无法自动收窄到按 ChannelKey 推导的映射类型，
  // 出口断言是必要步骤；形状由上方循环与类型层共同保证
  return result as unknown as {
    readonly [K in keyof D as ChannelKey<D, K, keyof D[K]>]: string;
  };
}

/** channel → SCREAMING_SNAKE_CASE（app:getStatus → APP_GET_STATUS；chat:stream:part → CHAT_STREAM_PART） */
function toConstantKey(channel: string): string {
  // rest 可能含多段（stream:part / event:created），故按段切开逐段转 snake 后拼接
  const [domain, ...rest] = channel.split(':');
  const restSnake = (rest ?? [])
    .map((seg) => seg.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`))
    .join('_');
  return `${domain}_${restSnake}`.toUpperCase();
}

// ─── 类型层推导：IpcApi / RequestMap / EventMap / Handlers ─────

/** 提取域内所有 request 方法名 */
type RequestMethods<D, Domain extends keyof D> = {
  [M in keyof D[Domain]]: D[Domain][M] extends RequestDefLike ? M : never;
}[keyof D[Domain]];

/**
 * 渲染层发送的入参类型：schema=null → undefined（无参）；否则取 zod **input** 类型。
 *
 * 必须用 z.input 而非 z.output：invoke 发出的就是调用方填的原始入参，而 output 是
 * 校验后形状（.default() 已填充、.transform() 已应用）——用 output 会迫使渲染层
 * 按"填充默认值后"的形状传参。
 */
type ReqOf<S> = S extends null ? undefined : S extends z.ZodType ? z.input<S> : never;

/**
 * 主进程 handler 收到的入参类型：zod **output**（wrap 校验后的 parsed.data）。
 * 与 ReqOf 语义分离：默认值已填充、transform 已应用。
 */
type HandlerInputOf<S> = S extends null ? undefined : S extends z.ZodType ? z.output<S> : never;

/** 单个 request 方法的调用签名（无入参时不生成 input 参数） */
type RequestSignature<Def> = Def extends {
  readonly kind: 'request';
  readonly schema: infer S;
  readonly res: infer R;
}
  ? ReqOf<S> extends undefined
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
  // -readonly 显式剥离 as const 源带上的只读（不改则测试无法覆写域属性）
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
 * 从定义表推导 IpcRequestMap：channel 字面量 → { req, res }（替代手写 payloads.ts 映射）
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
 * 从定义表推导 IpcEventMap：channel 字面量 → payload（替代手写 payloads.ts 事件映射）
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
export type HandlerSignature<Def, C> = Def extends {
  readonly kind: 'request';
  readonly schema: infer S;
  readonly res: infer R;
}
  ? (input: HandlerInputOf<S>, ctx: C) => Promise<R>
  : never;

/**
 * 从定义表推导 handler 实现对象形状（ctx 泛型由调用方指定，如主进程 IpcHandlerContext）
 *
 * 缺失任一 request 方法的 handler → 编译期报错（通道↔handler 一致性保证）。
 * 仅含 event 方法的域（如 invalidation）经 key remapping 整域免除——事件由主进程
 * 推送侧广播，无 handler 可注册（docs/implementation/31-invalidation-automation-spec.md §2.1）。
 */
export type InferHandlers<
  D extends Record<string, Record<string, RequestDefLike | EventDefLike>>,
  C,
> = {
  [Domain in keyof D as RequestMethods<D, Domain> extends never ? never : Domain]: {
    [M in RequestMethods<D, Domain>]: HandlerSignature<D[Domain][M], C>;
  };
};
