// update.ts：自动更新域 IPC 契约单一真源（electron-updater 状态桥接）——update:check 的请求/响应、
// 状态事件 payload、状态快照与更新缓存信息
// 关键流程：update:check 只回"检查已发起 / 发起失败"，结果与进度一律经 update:event:status 下发
// 边界：只定义形状与值域；接线在 packages/shared/src/ipc/definitions.ts 的 update 域，
// 检查调度、下载取消与错误归类在 src/main/infra/update/update-service.ts
// 设计依据：docs/design/27-auto-update-spec.md

import { z } from 'zod';

// ────────── update:check：触发检查（请求-响应）──────────

/** update:check 入参 */
export const UpdateCheckReqSchema = z.object({
  /**
   * 是否手动触发（缺省 false = 自动检查，见 src/main/ipc/update.handler.ts 的 `input.manual ?? false`）
   *
   * 两者只在失败面向上有别：手动检查失败会经 update:event:status 推送 error 事件
   * （用户要看到反馈），自动检查失败只记日志。
   */
  manual: z.boolean().optional(),
});

/**
 * update:check 响应
 *
 * 只表示"检查已发起 / 发起失败"：electron-updater 的 checkForUpdates 不返回检查结果
 * （有新版 / 已最新经 update:event:status 事件下发），故 status 不要再加
 * 'available' / 'up-to-date' 这类取值——它们永远置不上。
 */
export interface UpdateCheckRes {
  /**
   * 检查发起状态：'checking' 含"已有检查在途，本次直接复用、不重复发起"；
   * 'error' 为未能发起（开发模式不支持更新，或发起即失败）
   */
  readonly status: 'checking' | 'error';
  /** 错误信息（status='error' 时提供） */
  readonly message?: string;
}

/**
 * update:check 响应 zod schema
 *
 * 与上方 UpdateCheckRes 手工同构（interface 无运行时，schema 才是校验真源；不符即
 * INVALID_RESPONSE，见 src/main/utils/wrap.ts）
 */
export const UpdateCheckResSchema = z.object({
  status: z.enum(['checking', 'error']),
  message: z.string().optional(),
});

// ────────── update:event:status：状态推送（主进程 → 渲染层）──────────

/**
 * 更新状态推送阶段（update:event:status payload 的 phase）
 *
 * 典型时序：checking → available →（服务随即自动开始下载）→ downloading → downloaded；
 * not-available / cancelled / error 为终止态。同名值 'checking' 与 UpdateCheckRes.status
 * 的语义不同：那里是"请求已被受理"的应答，这里表示检查进行中。
 */
export type UpdatePhase =
  | 'checking' // 正在检查更新
  | 'available' // 发现新版本（服务随即自动开始下载，无需渲染层触发）
  | 'downloading' // 下载中（progress / transferred / total / bytesPerSecond 有效）
  | 'downloaded' // 下载完成，可安装重启（update:install，或退出时自动安装）
  | 'not-available' // 已是最新（检查成功结束）
  | 'cancelled' // 用户取消下载（取消只作用于下载阶段）
  | 'error'; // 检查或下载失败（附 errorKind / message）

/**
 * 更新错误分类（主进程按错误特征归类，渲染层映射本地化文案）
 *
 * 归类依据见 src/main/infra/update/update-service.ts 的 classifyUpdateError：
 * - network：网络不可达 / DNS / 连接失败 / 超时（含检查超时看门狗）
 * - rate-limited：被限流（HTTP 403/429）
 * - checksum：包校验失败（sha512 / checksum 描述文本）
 * - disk：磁盘空间不足（ENOSPC / EDQUOT）
 * - unknown：无法归类，保留原始 message 供排查
 *
 * 分类的意义：原始 message 是 electron-updater 的英文技术文本（含 net:: / sha512 /
 * ENOSPC 等），对用户不可操作；已知类映射本地化文案，unknown 才原样展示。
 */
export type UpdateErrorKind = 'network' | 'rate-limited' | 'checksum' | 'disk' | 'unknown';

/**
 * update:event:status 事件 payload
 *
 * 各字段按 phase 条件提供（缺失即该阶段不适用），详见各成员说明。
 */
export interface UpdateStatusPayload {
  /** 当前阶段（值域与语义见 UpdatePhase） */
  readonly phase: UpdatePhase;
  /** 新版本号（available / downloading / downloaded / cancelled 时提供） */
  readonly version?: string;
  /** 下载进度 0-100（downloading 时提供） */
  readonly progress?: number;
  /** 已下载字节（downloading 时提供） */
  readonly transferred?: number;
  /** 本次下载总字节（downloading 时提供；差分下载时为差分包大小） */
  readonly total?: number;
  /** 平均下载速率（字节/秒，downloading 时提供） */
  readonly bytesPerSecond?: number;
  /** 错误分类（error 时提供） */
  readonly errorKind?: UpdateErrorKind;
  /** 更新说明（available/downloaded 时提供；可能是 Markdown（latest.yml 内嵌）或 GitHub 渲染后的 HTML（atom feed 回退），渲染层按双格式处理） */
  readonly releaseNotes?: string;
  /** 错误信息（error 时提供；unknown 分类下展示给用户，其余仅记日志） */
  readonly message?: string;
}

/**
 * update:event:status payload zod schema
 *
 * 主进程发送侧 dev 校验：emitEvent 仅在未打包时按此核对 payload（失败只记日志、不阻断
 * 推送，打包版零开销）；值域须与上方 UpdatePhase / UpdateStatusPayload 手工同步。
 */
export const UpdateStatusPayloadSchema = z.object({
  phase: z.enum([
    'checking',
    'available',
    'downloading',
    'downloaded',
    'not-available',
    'cancelled',
    'error',
  ]),
  version: z.string().optional(),
  progress: z.number().min(0).max(100).optional(),
  transferred: z.number().min(0).optional(),
  total: z.number().min(0).optional(),
  bytesPerSecond: z.number().min(0).optional(),
  errorKind: z.enum(['network', 'rate-limited', 'checksum', 'disk', 'unknown']).optional(),
  releaseNotes: z.string().optional(),
  message: z.string().optional(),
});

// ────────── 状态快照与更新缓存信息 ──────────

/**
 * update:getStatus 响应：主进程最近一次状态快照
 *
 * 用于渲染层重载（窗口刷新 / 渲染进程重建）后恢复界面——事件通道只在事件
 * 发生时推送，新订阅者会错过历史。快照是"读状态"语义，不触发 toast。
 */
export interface UpdateGetStatusRes {
  /** 状态快照（进程内从未产生过更新状态时为 null） */
  readonly snapshot: UpdateStatusPayload | null;
  /** 上次检查发起时间（毫秒时间戳；从未检查过为 null） */
  readonly lastCheckAt: number | null;
}

/**
 * update:getStatus 响应 zod schema
 *
 * 与上方 UpdateGetStatusRes 手工同构；复用 payload schema，故须声明在其后。
 */
export const UpdateGetStatusResSchema = z.object({
  snapshot: UpdateStatusPayloadSchema.nullable(),
  lastCheckAt: z.number().nullable(),
});

/**
 * 更新缓存信息（update:getCacheInfo / update:clearCache 响应）
 *
 * path 为 null 表示无法解析缓存目录（开发模式无 app-update.yml 等），
 * 此时界面不展示该行——不猜路径、不误删。
 */
export interface UpdateCacheInfo {
  /** 缓存目录绝对路径（无法解析为 null） */
  readonly path: string | null;
  /** 占用字节数 */
  readonly bytes: number;
  /** 文件数 */
  readonly fileCount: number;
}

/** 更新缓存信息 zod schema（getCacheInfo / clearCache 两响应共用；clearCache 后 bytes/fileCount 归零、path 保留） */
export const UpdateCacheInfoSchema = z.object({
  path: z.string().nullable(),
  bytes: z.number().min(0),
  fileCount: z.number().min(0),
});
