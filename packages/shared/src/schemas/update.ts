// packages/shared/src/schemas/update.ts
// 自动更新域 schema（electron-updater 状态桥接）
// ──────────────────────────────────────────────────────────────
// 设计（见 docs/design/27-auto-update-spec.md）：
// - 请求-响应：update:check（触发检查）/ update:install（安装重启）/
//   update:cancel（取消下载）/ update:getStatus（取主进程状态快照）
// - 事件推送：update:event:status（检查/下载进度/就绪/取消/错误）
// - payload 用 phase 区分阶段，渲染层据此渲染提示
// - 进度字段对齐 electron-updater 的 ProgressInfo：差分下载时 total 是
//   本次需下载的字节数（差分包大小），不是完整安装包体积
// ──────────────────────────────────────────────────────────────

import { z } from 'zod';

/** update:check 入参 */
export const UpdateCheckReqSchema = z.object({
  /** 是否手动触发（手动检查时未配置更新源应提示，自动检查可静默） */
  manual: z.boolean().optional(),
});

/**
 * update:check 响应
 *
 * 只表示"检查已发起 / 发起失败"：检查结果（有新版 / 已最新）经
 * update:event:status 事件下发。此前声明过 'up-to-date' / 'available'，但
 * electron-updater 的 checkForUpdates 不返回结果，那两个值永不出现（死枚举），
 * 2026-09-18 收敛为实际会返回的集合。
 */
export interface UpdateCheckRes {
  /** 检查发起状态 */
  readonly status: 'checking' | 'error';
  /** 错误信息（status=error 时提供） */
  readonly message?: string;
}

/** update:check 响应 zod schema（R4：响应契约校验） */
export const UpdateCheckResSchema = z.object({
  status: z.enum(['checking', 'error']),
  message: z.string().optional(),
});

/** 更新状态推送阶段 */
export type UpdatePhase =
  | 'checking' // 正在检查更新
  | 'available' // 发现新版本（提示用户）
  | 'downloading' // 正在下载（带进度）
  | 'downloaded' // 下载完成（可安装重启）
  | 'not-available' // 已是最新
  | 'cancelled' // 用户取消下载
  | 'error'; // 检查/下载失败

/**
 * 更新错误分类（主进程按错误特征归类，渲染层映射本地化文案）
 *
 * 原始 message 是 electron-updater 的英文技术文本（含 net:: / sha512 / ENOSPC
 * 等），直接展示对用户不可操作，故由主进程分类后下发。
 */
export type UpdateErrorKind =
  | 'network' // 网络不可达 / DNS / 连接超时
  | 'rate-limited' // 被限流（HTTP 403/429）
  | 'checksum' // 包校验失败
  | 'disk' // 磁盘空间不足
  | 'unknown'; // 其他（保留原始 message 供排查）

/** update:event:status 事件 payload */
export interface UpdateStatusPayload {
  /** 当前阶段 */
  readonly phase: UpdatePhase;
  /** 新版本号（available/downloading/downloaded 时提供） */
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
  /** 更新说明（available/downloaded 时提供；来源为 GitHub release body = 润色过的 CHANGELOG 段落） */
  readonly releaseNotes?: string;
  /** 错误信息（error 时提供；unknown 分类下展示给用户，其余仅记日志） */
  readonly message?: string;
}

/** update:event:status payload schema（R2：主进程发送侧 dev 校验） */
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

/** update:getStatus 响应 zod schema（定义顺序：引用上面的 payload schema） */
export const UpdateGetStatusResSchema = z.object({
  snapshot: UpdateStatusPayloadSchema.nullable(),
  lastCheckAt: z.number().nullable(),
});
