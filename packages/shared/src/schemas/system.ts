// packages/shared/src/schemas/system.ts
// System 域 zod schema 单一真源（运行时可观测性）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 集中定义 System 域 zod schema，作为 IPC 入参运行时校验的单一真源
// - 当前提供 system:getStatus（运行时状态查询）+ logs:read（日志读取）
//
// 设计：
// - system:getStatus 无入参（void），返回 SystemStatus（内存/CPU/uptime/版本）
// - logs:read 入参为 { lines?, level? }（全可选），返回 ReadLogsRes
// - Res 类型直接 interface 定义（zod 推断 req，res 由 main 进程保证形状）
// ──────────────────────────────────────────────────────────────

import { z } from 'zod';

/** logs:read 入参最大行数（与 main 进程 system.handler.ts MAX_LINES 保持一致） */
const MAX_LOG_LINES = 2000;

/** logs:read 日志级别枚举 */
export const LogLevelSchema = z.enum(['info', 'warn', 'error', 'debug']);

/**
 * logs:read 请求 payload
 *
 * 全字段可选：
 * - lines：读取最近 N 行（默认 200，上限 2000）
 * - level：日志级别过滤（不传则返回全部级别）
 *
 * schema 用 `.optional()` 而非 `.nullable()`：undefined 时由 main 进程填默认值。
 */
export const ReadLogsReqSchema = z
  .object({
    lines: z.number().int().min(1).max(MAX_LOG_LINES).optional(),
    level: LogLevelSchema.optional(),
  })
  .optional();

/** logs:read 请求 payload TypeScript 类型 */
export type ReadLogsReq = z.infer<typeof ReadLogsReqSchema>;

/**
 * system:getStatus 响应 payload：运行时状态
 *
 * DevPanel Metrics tab 展示用：
 * - appVersion / electronVersion / nodeVersion / platform / arch / isPackaged：环境信息
 * - uptimeSeconds / pid：进程运行时长与标识
 * - memory：Node.js process.memoryUsage() 原生数据
 * - cpu：Node.js process.cpuUsage() 原生数据（微秒）
 * - timestamp：采集时间（ISO 字符串）
 */
export interface SystemStatusRes {
  /** 应用版本 */
  readonly appVersion: string;
  /** Electron 版本 */
  readonly electronVersion: string;
  /** Node.js 版本 */
  readonly nodeVersion: string;
  /** 运行平台（darwin / win32 / linux） */
  readonly platform: string;
  /** 进程架构（x64 / arm64） */
  readonly arch: string;
  /** 是否打包环境 */
  readonly isPackaged: boolean;
  /** 进程运行时长（秒） */
  readonly uptimeSeconds: number;
  /** 进程 PID */
  readonly pid: number;
  /** 内存使用（字节） */
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
  /** CPU 使用（微秒，进程级累计值） */
  readonly cpu: {
    /** 用户态 CPU 时间 */
    readonly user: number;
    /** 系统态 CPU 时间 */
    readonly system: number;
  };
  /** 上次采集时间戳（ISO 字符串） */
  readonly timestamp: string;
}

/**
 * logs:read 响应 payload：日志读取结果
 */
export interface ReadLogsRes {
  /** 日志行数组（按时间正序，最近的在数组末尾） */
  readonly lines: readonly string[];
  /** 实际读取行数（可能小于请求的 lines，若日志文件不够长） */
  readonly total: number;
  /** 日志文件路径（便于用户定位） */
  readonly filePath: string;
  /** 是否被截断（达到上限 2000） */
  readonly truncated: boolean;
}
