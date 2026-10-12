// system.ts：System / Logs 域 zod 契约单一真源（运行时可观测性）——system:getStatus（运行时状态）与
// logs:read（日志读取）的请求-响应 schema 与类型
// 消费方：IPC 定义表（packages/shared/src/ipc/definitions.ts）引用；主进程注册层
// （src/main/ipc/register.ts → src/main/utils/wrap.ts）在调用前后校验入参与 handler 返回值，
// resSchema 缺失时注册即抛错
// 边界：只定义形状与值域——状态采集、日志尾部读取与级别过滤在 src/main/ipc/system.handler.ts

import { z } from 'zod';

// ────────── 请求契约（渲染层 → 主进程）──────────

/**
 * logs:read 入参最大行数（防止大文件拖慢渲染层）
 *
 * 与 src/main/ipc/system.handler.ts 的 MAX_LINES 手工同步：本处管入参校验上限，
 * handler 那边管实际读取行数与 truncated 判定。
 */
const MAX_LOG_LINES = 2000;

/**
 * logs:read 日志级别枚举
 *
 * 取值须与日志行的 `[<level>]` 字面量一致（handler 按该子串过滤，格式由
 * src/main/utils/logger.ts 的文件 transport 写入）——增删级别而不改日志格式，过滤恒为空。
 * 另注意打包环境文件 transport 只收 info 及以上级别，选 'debug' 过滤时结果为空是预期行为。
 */
export const LogLevelSchema = z.enum(['info', 'warn', 'error', 'debug']);

/**
 * logs:read 请求 payload
 *
 * 整体可缺省（外层 `.optional()`）：渲染层传 `undefined` 与传 `{}` 等价，主进程一并按默认值处理
 * （注意调用签名仍是必填位置参数，需显式写 `read(undefined)` 而非 `read()`）。
 * - lines：读取最近 N 行（省略时主进程用默认值 200，上限见 MAX_LOG_LINES）
 * - level：日志级别过滤（省略即不过滤，返回全部级别）
 *
 * 字段用 `.optional()` 而非 `.nullable()`：缺省（undefined）由主进程填默认值
 * （见 src/main/ipc/system.handler.ts 的 DEFAULT_LINES 与 level 判空），调用方可直接省略键；
 * `.nullable()` 则要求「不填」时显式传 null，语义与调用方预期不符。
 */
export const ReadLogsReqSchema = z
  .object({
    lines: z.number().int().min(1).max(MAX_LOG_LINES).optional(),
    level: LogLevelSchema.optional(),
  })
  .optional();

/** logs:read 请求 payload TypeScript 类型（含整体缺省，即 `{ lines?, level? } | undefined`） */
export type ReadLogsReq = z.infer<typeof ReadLogsReqSchema>;

// ────────── 响应契约：类型接口（供渲染层消费，编译期形状）──────────

/**
 * system:getStatus 响应 payload：主进程运行时状态快照
 *
 * 数据源：环境类字段取自 Electron app（getVersion / isPackaged）与 process（versions / platform /
 * arch / pid / uptime），memory 与 cpu 为 Node.js process.memoryUsage() / process.cpuUsage() 原生输出。
 * 消费方是 DevPanel Metrics tab（src/renderer/hooks/use-system.ts 周期轮询），字段随 Node/Electron
 * 语义走，勿在此换算单位。
 * 该方法无入参（定义表 schema 为 null），故本文件没有对应的请求 schema。
 */
export interface SystemStatusRes {
  /** 应用版本（app.getVersion()，即 package.json version） */
  readonly appVersion: string;
  /** Electron 版本（取不到时为 'unknown'） */
  readonly electronVersion: string;
  /** Node.js 版本 */
  readonly nodeVersion: string;
  /** 运行平台（process.platform：darwin / win32 / linux） */
  readonly platform: string;
  /** 进程架构（process.arch：x64 / arm64） */
  readonly arch: string;
  /** 是否打包环境（app.isPackaged；false 表示 dev 直跑） */
  readonly isPackaged: boolean;
  /** 进程运行时长（秒，process.uptime() 取整） */
  readonly uptimeSeconds: number;
  /** 进程 PID */
  readonly pid: number;
  /** 内存使用（字节，process.memoryUsage() 原样透传） */
  readonly memory: {
    /** 常驻内存集（RSS），操作系统视角的进程内存占用 */
    readonly rss: number;
    /** V8 堆总量 */
    readonly heapTotal: number;
    /** V8 堆已用 */
    readonly heapUsed: number;
    /** V8 外部内存（C++ 对象，如 Buffer） */
    readonly external: number;
    /** ArrayBuffer 占用 */
    readonly arrayBuffers: number;
  };
  /**
   * CPU 使用（微秒）—— process.cpuUsage() 的**进程启动以来累计值**，非采样区间增量；
   * 想看占用率须由消费方对两次采样求差（MetricsPanel 目前只展示累计值）
   */
  readonly cpu: {
    /** 用户态 CPU 时间 */
    readonly user: number;
    /** 系统态 CPU 时间 */
    readonly system: number;
  };
  /** 本次采集时间戳（ISO 字符串） */
  readonly timestamp: string;
}

/**
 * logs:read 响应 payload：日志读取结果
 *
 * 读取失败（文件不存在等）不抛错，而是回空 `lines` + `total: 0`（见 src/main/ipc/system.handler.ts），
 * 消费方据空数组渲染空态即可，无需另行容错。
 */
export interface ReadLogsRes {
  /** 日志行数组（时间正序，最新的在末尾；级别过滤后的结果） */
  readonly lines: readonly string[];
  /** 返回的日志行数（恒等于 lines.length——级别过滤已生效，故可能小于请求的 lines） */
  readonly total: number;
  /** 日志文件路径（便于用户定位；见 src/main/utils/logger.ts 的落盘位置） */
  readonly filePath: string;
  /**
   * 请求行数超过上限（MAX_LOG_LINES）而被截断——为 true 时只返回了上限行数。
   * 注意：仅当绕过 IPC 直接调用 handler 时才可能为 true；经 IPC 的请求已被入参 schema 的
   * `.max(MAX_LOG_LINES)` 挡下（超限回 INVALID_INPUT），故正常链路上恒为 false。
   */
  readonly truncated: boolean;
}

// ────────── 响应契约：zod schema（运行时校验，注册层据 resSchema 核对 handler 返回值）──────────

/**
 * logs:read 响应 zod schema
 *
 * 与上方 ReadLogsRes 手工保持同构——Res 类型是手写 interface（不像 Req 由 z.infer 派生），
 * 两者无编译期交叉校验，改一处须同步另一处。运行时以本 schema 为准：注册层核对 handler
 * 返回值，不符即 INVALID_RESPONSE（见 src/main/utils/wrap.ts）。校验只到形状层——
 * `total` 与 `lines.length` 是否相等不校验，由 handler 保证。
 */
export const ReadLogsResSchema = z.object({
  lines: z.array(z.string()),
  total: z.number().int().nonnegative(),
  filePath: z.string(),
  truncated: z.boolean(),
});

/**
 * system:getStatus 响应 zod schema
 *
 * 与上方 SystemStatusRes 手工保持同构——Res 类型是手写 interface（不像 Req 由 z.infer 派生），
 * 两者无编译期交叉校验，改一处须同步另一处。运行时以本 schema 为准：注册层核对 handler
 * 返回值，不符即 INVALID_RESPONSE（见 src/main/utils/wrap.ts）。
 */
export const SystemStatusResSchema = z.object({
  appVersion: z.string(),
  electronVersion: z.string(),
  nodeVersion: z.string(),
  platform: z.string(),
  arch: z.string(),
  isPackaged: z.boolean(),
  uptimeSeconds: z.number().nonnegative(),
  pid: z.number().int().positive(),
  memory: z.object({
    rss: z.number(),
    heapTotal: z.number(),
    heapUsed: z.number(),
    external: z.number(),
    arrayBuffers: z.number(),
  }),
  cpu: z.object({
    user: z.number(),
    system: z.number(),
  }),
  timestamp: z.string(),
});
