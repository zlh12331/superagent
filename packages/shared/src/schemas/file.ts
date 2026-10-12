// file.ts：文件域 IPC 的形状契约单一真源——read / write / list / watch（start/stop/event）/ create /
// createDir / delete / rename 的请求与响应 schema 及类型
// 消费方：packages/shared/src/ipc/definitions.ts；主进程注册层据此校验入参与 handler 返回值
// （src/main/ipc/register.ts），file:watch:event 另在发送侧校验（src/main/utils/emit-event.ts）
// 边界：只管形状与值域（path 只约束非空字符串）——工作区收口（src/main/ipc/file.handler.ts 的
// guard/guardRead）、绝对路径断言、编码探测、读取字节上限、watch 忽略规则均由主进程执行

import { z } from 'zod';

/**
 * file:read 入参 zod schema
 *
 * 支持大文件分批读取：offset 起始行（0-based）、limit 读取行数。
 * 省略 offset/limit 时读取整个文件。
 *
 * offset/limit 尾部的 `.transform(v => v ?? undefined)` 与裸 `.optional()` 运行时等价（都让省略的键不出现），
 * 差异在类型：transform 使解析结果的键保持「必填、值 number | undefined」，可与主进程 FileReadOptions
 * 的声明形状（同样为键必填；file-service.ts 注明该风格是为兼容 exactOptionalPropertyTypes）互赋，
 * 裸 `.optional()` 产出的可选键则不行。
 */
export const FileReadReqSchema = z.object({
  path: z.string().min(1),
  offset: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .transform((v) => v ?? undefined),
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .transform((v) => v ?? undefined),
});

/** file:read 响应 payload */
export interface FileReadRes {
  /** 文件文本内容（已按检测到的编码解码为 JS 字符串，非原始字节） */
  readonly content: string;
  /** 整文件总行数（按换行切分计数；content 被 offset/limit 切片时该值不变） */
  readonly totalLines: number;
  /** 文件编码（chardet 自动检测：UTF-8 同族统一为 'utf-8'，其余为 iconv-lite 可解码的编码名） */
  readonly encoding: string;
}

/** file:read 响应 zod schema（响应契约校验：注册层用它核对 handler 返回值，不符即 INVALID_RESPONSE） */
export const FileReadResSchema = z.object({
  content: z.string(),
  totalLines: z.number().int().nonnegative(),
  encoding: z.string(),
});

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
  append: z.boolean().default(false),
  createDirs: z.boolean().default(true),
});

/** file:write 响应 payload */
export interface FileWriteRes {
  /** 实际写入的字节数（UTF-8 字节数，非字符串长度） */
  readonly bytesWritten: number;
}

/** file:write 响应 zod schema（响应契约校验） */
export const FileWriteResSchema = z.object({
  bytesWritten: z.number().int().nonnegative(),
});

/**
 * file:list 入参 zod schema
 *
 * depth 控制递归深度：
 * - 1（默认）：仅列出直接子项
 * - 2-10：递归列出多层子项（最大 10 层，避免大目录 OOM）
 *
 * includeHidden=false（默认）：跳过点开头的隐藏项（.git / .vscode 等）；
 * node_modules 另由 FileService 的内置忽略基线（src/main/infra/file/tree-ignore.ts）剔除。
 */
export const FileListReqSchema = z.object({
  path: z.string().min(1),
  depth: z.number().int().positive().max(10).default(1),
  includeHidden: z.boolean().default(false),
});

/**
 * 文件条目 zod schema（file:list 响应元素，渲染层文件树的存储形状）
 *
 * type 取值（由 readdir dirent 判定，不跟随符号链接）：
 * - 'file'：普通文件
 * - 'directory'：目录
 * - 'symlink'：符号链接
 *
 * size/modifiedAt 取自 fs.stat（跟随符号链接，取目标的值）。
 */
export const FileEntrySchema = z.object({
  name: z.string(),
  path: z.string(),
  type: z.enum(['file', 'directory', 'symlink']),
  size: z.number().int().nonnegative(),
  // Unix timestamp（毫秒；stats.mtimeMs 向下取整）
  modifiedAt: z.number().int().nonnegative(),
});

/** 文件条目类型 */
export type FileEntry = z.infer<typeof FileEntrySchema>;

/** file:list 响应 payload */
export interface FileListRes {
  /** 列出的条目（含 depth 递归层；未排序——渲染层在 file-tree-store 侧排序） */
  readonly entries: readonly FileEntry[];
}

/** file:list 响应 zod schema（响应契约校验） */
export const FileListResSchema = z.object({
  entries: z.array(FileEntrySchema),
});

// ───── 文件监听（start/stop 请求-响应 + event 流式推送） ─────

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
  /**
   * watcher 唯一 ID，渲染层用此 id 订阅 file:watch:event 并在停止时传给 file:watch:stop；
   * 同一 (path, webContents) 重复 start 会复用既有 id，不新建 watcher
   */
  readonly watcherId: string;
}

/** file:watch:start 响应 zod schema（响应契约校验） */
export const FileWatchStartResSchema = z.object({
  watcherId: z.string().min(1),
});

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

/** file:watch:stop 响应 zod schema（响应契约校验） */
export const FileWatchStopResSchema = z.object({
  stopped: z.boolean(),
});

/**
 * file:watch:event 事件 payload（流式事件，主进程 → 渲染层）
 *
 * chokidar 监听文件系统变更时推送。type 取值（括号内为 chokidar 原始事件）：
 * - 'create'：新建文件/目录（add / addDir）
 * - 'modify'：文件内容变更（change）
 * - 'delete'：删除文件/目录（unlink / unlinkDir）
 * - 'rename'：重命名（oldPath 为原路径，path 为新路径）；chokidar 不直接上报 rename，
 *   实际重命名以 delete + create 两条事件到达，当前主进程不会产出该值。
 */
export interface FileWatchEventPayload {
  /** 关联的 watcherId（用于渲染层过滤事件来源） */
  readonly watcherId: string;
  /** 变更类型 */
  readonly type: 'create' | 'modify' | 'delete' | 'rename';
  /** 变更路径（绝对路径） */
  readonly path: string;
  /** rename 时的原路径，其他 type 为 undefined；当前无生产者，实际推送恒为 undefined */
  readonly oldPath?: string;
}

/** file:watch:event payload schema（发送侧校验：非打包时每次推送前 safeParse，不符仅记日志、不阻断发送） */
export const FileWatchEventPayloadSchema = z.object({
  watcherId: z.string().min(1),
  type: z.enum(['create', 'modify', 'delete', 'rename']),
  path: z.string().min(1),
  oldPath: z.string().optional(),
});

// ───── 文件树编辑操作（新建文件/目录、删除、重命名） ─────

/**
 * file:create 入参 zod schema
 *
 * 创建新文件（空文件，若已存在则报错）。
 * 父目录不存在时自动创建（createDirs=true）。
 */
export const FileCreateReqSchema = z.object({
  path: z.string().min(1),
  createDirs: z.boolean().default(true),
});

/** file:create 响应 payload */
export interface FileCreateRes {
  /** 创建的文件绝对路径（标准化后） */
  readonly path: string;
}

/** file:create 响应 zod schema（响应契约校验） */
export const FileCreateResSchema = z.object({
  path: z.string().min(1),
});

/**
 * file:createDir 入参 zod schema
 *
 * 创建新目录（递归创建父目录，目录已存在时不报错）。
 */
export const FileCreateDirReqSchema = z.object({
  path: z.string().min(1),
});

/** file:createDir 响应 payload */
export interface FileCreateDirRes {
  /** 创建的目录绝对路径（标准化后） */
  readonly path: string;
}

/** file:createDir 响应 zod schema（响应契约校验） */
export const FileCreateDirResSchema = z.object({
  path: z.string().min(1),
});

/**
 * file:delete 入参 zod schema
 *
 * 删除文件或目录。recursive 必须显式声明（无默认值）：
 * 不做静默默认递归删除（rm -rf 语义），调用方必须明确选择
 * recursive=true（递归删除目录）或 false（仅空目录/文件，非空目录报 ENOTEMPTY）。
 */
export const FileDeleteReqSchema = z.object({
  path: z.string().min(1),
  /** 是否递归删除目录（必填：true 递归删除；false 仅空目录，非空抛 ENOTEMPTY） */
  recursive: z.boolean(),
});

/** file:delete 响应 payload */
export interface FileDeleteRes {
  /** 是否成功删除（失败经 AppError 抛出，成功响应恒为 true） */
  readonly deleted: boolean;
}

/** file:delete 响应 zod schema（响应契约校验） */
export const FileDeleteResSchema = z.object({
  deleted: z.boolean(),
});

/**
 * file:rename 入参 zod schema
 *
 * 重命名/移动文件或目录。
 */
export const FileRenameReqSchema = z.object({
  oldPath: z.string().min(1),
  newPath: z.string().min(1),
  /** 目标已存在时是否覆盖（默认 false：已存在即报 ALREADY_EXISTS，避免误覆盖） */
  overwrite: z.boolean().default(false),
});

/** file:rename 响应 payload */
export interface FileRenameRes {
  /** 重命名后的新路径（标准化后） */
  readonly path: string;
}

/** file:rename 响应 zod schema（响应契约校验） */
export const FileRenameResSchema = z.object({
  path: z.string().min(1),
});
