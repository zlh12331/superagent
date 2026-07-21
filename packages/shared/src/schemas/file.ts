// packages/shared/src/schemas/file.ts
// 文件域 zod schema 单一真源
// ──────────────────────────────────────────────────────────────
// 职责：
// - 定义 file:read / file:write / file:list / file:watch:start / file:watch:stop 请求-响应 zod schema
// - 定义 file:watch:event 流式事件 payload 类型
// - 供主进程 IPC handler 校验入参
//
// 设计：
// - 路径校验由 zod 完成基础形状校验（非空字符串），实际路径安全检查
//   （防越权访问 workingDir 之外）由 FileService 在执行时校验
// - offset/limit 用 `.optional().transform(v => v ?? undefined)` 兼容 exactOptionalPropertyTypes
// - 文件条目用 FileEntrySchema 复用，list 与 watch 都可能用到
// - file:watch 拆分为 start/stop/event 三种 channel：
//   · start（请求-响应）：渲染层发起监听，返回 watcherId
//   · stop（请求-响应）：渲染层停止指定 watcher
//   · event（流式事件）：主进程推送变更事件（携带 watcherId 关联）
// ──────────────────────────────────────────────────────────────

import { z } from 'zod';

/**
 * file:read 入参 zod schema
 *
 * 支持大文件分批读取：offset 起始行（0-based）、limit 读取行数。
 * 省略 offset/limit 时读取整个文件。
 */
export const FileReadReqSchema = z.object({
  path: z.string().min(1),
  // 起始行（0-based），省略时从第 0 行开始
  offset: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .transform((v) => v ?? undefined),
  // 读取行数，省略时读到文件末尾
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .transform((v) => v ?? undefined),
});

/** file:read 响应 payload */
export interface FileReadRes {
  /** 文件文本内容（UTF-8 解码后） */
  readonly content: string;
  /** 文件总行数（用于渲染层判断是否分批读取） */
  readonly totalLines: number;
  /** 文件编码（当前仅支持 utf-8，二进制文件由工具拒绝） */
  readonly encoding: 'utf-8';
}

/**
 * file:write 入参 zod schema
 *
 * append=false（默认）：覆盖写入（覆盖已有文件）
 * append=true：追加写入（在文件末尾追加内容）
 *
 * createDirs=true（默认）：自动创建父目录（避免 ENOENT）
 */
export const FileWriteReqSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
  // 是否追加（默认 false 覆盖）
  append: z.boolean().default(false),
  // 是否自动创建父目录（默认 true）
  createDirs: z.boolean().default(true),
});

/** file:write 响应 payload */
export interface FileWriteRes {
  /** 实际写入的字节数 */
  readonly bytesWritten: number;
}

/**
 * file:list 入参 zod schema
 *
 * depth 控制递归深度：
 * - 1（默认）：仅列出直接子项
 * - 2-10：递归列出多层子项（最大 10 层，避免大目录 OOM）
 *
 * includeHidden=false（默认）：跳过 .gitignore / 隐藏文件
 */
export const FileListReqSchema = z.object({
  path: z.string().min(1),
  depth: z.number().int().positive().max(10).default(1),
  includeHidden: z.boolean().default(false),
});

/**
 * 文件条目 zod schema（list 与 watch 复用）
 *
 * type 取值：
 * - 'file'：普通文件
 * - 'directory'：目录
 * - 'symlink'：符号链接（不解析目标）
 */
export const FileEntrySchema = z.object({
  name: z.string(),
  path: z.string(),
  type: z.enum(['file', 'directory', 'symlink']),
  size: z.number().int().nonnegative(),
  // Unix timestamp（毫秒）
  modifiedAt: z.number().int().nonnegative(),
});

/** 文件条目类型 */
export type FileEntry = z.infer<typeof FileEntrySchema>;

/** file:list 响应 payload */
export interface FileListRes {
  readonly entries: readonly FileEntry[];
}

/**
 * file:watch:start 入参 zod schema
 *
 * 渲染层发起文件监听，主进程返回 watcherId 用于后续停止监听。
 * 后续文件变更通过 file:watch:event 流式事件推送（携带 watcherId 关联）。
 */
export const FileWatchStartReqSchema = z.object({
  // 监听根目录（绝对路径）
  path: z.string().min(1),
});

/** file:watch:start 响应 payload */
export interface FileWatchStartRes {
  /** watcher 唯一 ID，渲染层用此 id 订阅 file:watch:event 并在停止时传给 file:watch:stop */
  readonly watcherId: string;
}

/**
 * file:watch:stop 入参 zod schema
 *
 * 渲染层停止指定 watcherId 的文件监听。
 */
export const FileWatchStopReqSchema = z.object({
  // 要停止的 watcher id（来自 file:watch:start 返回值）
  watcherId: z.string().min(1),
});

/** file:watch:stop 响应 payload */
export interface FileWatchStopRes {
  /** 是否成功停止（watcherId 不存在时返回 false） */
  readonly stopped: boolean;
}

/**
 * file:watch:event 事件 payload（流式事件）
 *
 * chokidar 监听文件系统变更时推送。type 取值：
 * - 'create'：新建文件/目录
 * - 'modify'：文件内容变更
 * - 'delete'：删除文件/目录
 * - 'rename'：重命名（oldPath 为原路径，path 为新路径）
 */
export interface FileWatchEventPayload {
  /** 关联的 watcherId（用于渲染层过滤事件来源） */
  readonly watcherId: string;
  /** 变更类型 */
  readonly type: 'create' | 'modify' | 'delete' | 'rename';
  /** 变更路径（绝对路径） */
  readonly path: string;
  /** rename 时的原路径，其他 type 为 undefined */
  readonly oldPath?: string;
}
