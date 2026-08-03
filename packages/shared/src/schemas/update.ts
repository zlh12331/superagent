// packages/shared/src/schemas/update.ts
// 自动更新域 schema（electron-updater 状态桥接）
// ──────────────────────────────────────────────────────────────
// 设计：
// - 请求-响应：update:check（手动/自动触发检查，返回当前状态）
// - 事件推送：update:event:status（主进程推送检查/下载进度/就绪状态）
// - payload 用 phase 区分阶段，渲染层据此渲染提示（检查中/可更新/下载中/已就绪/错误）
// ──────────────────────────────────────────────────────────────

import { z } from 'zod';

/** update:check 入参 */
export const UpdateCheckReqSchema = z.object({
  /** 是否手动触发（手动检查时未配置更新源应提示，自动检查可静默） */
  manual: z.boolean().optional(),
});

/** update:check 响应 */
export interface UpdateCheckRes {
  /** 检查结果状态 */
  readonly status: 'up-to-date' | 'available' | 'checking' | 'error';
  /** 新版本号（status=available 时提供） */
  readonly version?: string;
  /** 错误信息（status=error 时提供） */
  readonly message?: string;
}

/** 更新状态推送阶段 */
export type UpdatePhase =
  | 'checking' // 正在检查更新
  | 'available' // 发现新版本（提示用户）
  | 'downloading' // 正在下载（带进度）
  | 'downloaded' // 下载完成（可安装重启）
  | 'not-available' // 已是最新
  | 'error'; // 检查/下载失败

/** update:event:status 事件 payload */
export interface UpdateStatusPayload {
  /** 当前阶段 */
  readonly phase: UpdatePhase;
  /** 新版本号（available/downloading/downloaded 时提供） */
  readonly version?: string;
  /** 下载进度 0-100（downloading 时提供） */
  readonly progress?: number;
  /** 错误信息（error 时提供） */
  readonly message?: string;
}
