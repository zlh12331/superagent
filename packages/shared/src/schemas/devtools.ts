// devtools.ts：DevTools 域（开发者工具集成）zod 契约单一真源
// 消费方：packages/shared/src/ipc/definitions.ts 的 devtools 域——入参在 handler 前校验、响应在回渲染层前校验
// （注册层 src/main/ipc/register.ts 强制 resSchema 必填，缺失即启动抛错）
// 边界：只定义契约形状；默认停靠模式在 src/main/ipc/devtools.handler.ts，模式语义由 Electron 决定

import { z } from 'zod';

/**
 * devtools:open 请求 payload
 *
 * 打开主窗口的 Chromium DevTools；整个请求体可缺省（省略即用默认 mode）。
 *
 * mode 值域（Electron 的 `OpenDevToolsOptions.mode` 还有 'left' / 'undocked'，本契约刻意不暴露，
 * 免得与 'detach' 混淆——只有 'undocked' 能再停靠回窗口）：
 * - 'detach'：独立窗口，不占用主窗口空间（默认；默认值取自 devtools.handler.ts 的 DEFAULT_MODE）
 * - 'right'：停靠在主窗口右侧
 * - 'bottom'：停靠在主窗口底部
 *
 * ⚠️ Electron 文档：Windows 上启用 Window Control Overlay 时一律按 'detach' 打开——主窗口在非
 * macOS 启用 titleBarOverlay（src/main/window.ts），故 Windows 下传 'right' / 'bottom' 不保证生效。
 */
export const OpenDevToolsReqSchema = z
  .object({
    mode: z.enum(['detach', 'right', 'bottom']).optional(),
  })
  .optional();

/** devtools:open 请求 payload 类型（承载侧序列化后可整体缺省，消费侧先判空再取 mode） */
export type OpenDevToolsReq = z.infer<typeof OpenDevToolsReqSchema>;

/**
 * devtools:open 响应 payload
 *
 * mode 回传实际生效值，供渲染层反馈状态文案（见 src/renderer/components/dev/InspectorPanel.tsx）。
 */
export interface OpenDevToolsRes {
  /** 是否成功打开 DevTools；唯一失败路径是 sender 窗口已不存在（handler 未对「已打开」特殊处理，重复调用照常返回 true，故 ok=true 不代表新开了窗口） */
  readonly ok: boolean;
  /** 实际使用的 mode（请求缺省时即默认值，渲染层按此回显而非按请求参数回显） */
  readonly mode: 'detach' | 'right' | 'bottom';
}

/** devtools:open 响应 zod schema：定义表注册时必填（缺失即启动抛错，见 src/main/ipc/register.ts），handler 返回值回渲染层前经它校验 */
export const OpenDevToolsResSchema = z.object({
  ok: z.boolean(),
  mode: z.enum(['detach', 'right', 'bottom']),
});
