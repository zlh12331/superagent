// packages/shared/src/schemas/window.ts
// Window 域 zod schema 单一真源（界面缩放应用，35 号 spec §2.3）
// ──────────────────────────────────────────────────────────────
// window:applyZoom：渲染层写入驱动 → 主进程单点收口——遍历全部 BrowserWindow
// 执行 webContents.setZoomFactor（渲染层 sandbox 无 webContents 句柄），
// win32 平台联动 titleBarOverlay.height（52 DIP 固定值不联动则错位）。
// 响应 ok 恒 true（应用失败静默 no-op——窗口销毁即应用退出，无恢复语义）。
// ──────────────────────────────────────────────────────────────

import { z } from 'zod';

import { ZOOM_LEVELS } from '../constants/zoom';

/** window:applyZoom 入参（zoom 为合法档位；handler 内不二次防御——渲染层 clamp 后写入） */
export const ApplyZoomReqSchema = z.object({
  zoom: z.number(),
});

export type ApplyZoomReq = z.infer<typeof ApplyZoomReqSchema>;

/** window:applyZoom 响应 */
export interface ApplyZoomRes {
  readonly ok: boolean;
}

export const ApplyZoomResSchema = z.object({
  ok: z.boolean(),
});

// ZOOM_LEVELS 供 handler 侧 clampZoom 兜底引用（重导出避免调用方双 import）
export { ZOOM_LEVELS };
