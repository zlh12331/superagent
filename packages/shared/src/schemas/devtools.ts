// packages/shared/src/schemas/devtools.ts
// DevTools 域 zod schema 单一真源（开发者工具集成）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 集中定义 DevTools 域 zod schema，作为 IPC 入参运行时校验的单一真源
// - 当前提供 devtools:open（打开 Chromium DevTools，支持 mode 参数）
//
// 设计：
// - devtools:open 入参为 { mode? }（可选，默认 'detach' 独立窗口）
// - mode 仅支持 'detach' / 'right' / 'bottom' 三种常用模式
//   （完整 Electron 支持 'left' | 'right' | 'bottom' | 'undocked' | 'detach'，
//    本项目仅暴露常用三种，避免误用 'undocked' 与 'detach' 混淆）
// - 返回 { ok: boolean } 表示是否成功打开
// ──────────────────────────────────────────────────────────────

import { z } from 'zod';

/**
 * devtools:open 请求 payload
 *
 * mode 字段说明：
 * - 'detach'：独立窗口（推荐，不占用应用主窗口空间）
 * - 'right'：停靠在主窗口右侧
 * - 'bottom'：停靠在主窗口底部
 *
 * schema 用 `.optional().transform(v => v ?? undefined)` 兼容 exactOptionalPropertyTypes：
 * 让 z.infer 推断为 `string | undefined`，与显式 `| undefined` 类型对齐
 */
export const OpenDevToolsReqSchema = z
  .object({
    mode: z.enum(['detach', 'right', 'bottom']).optional(),
  })
  .optional();

/** devtools:open 请求 payload TypeScript 类型 */
export type OpenDevToolsReq = z.infer<typeof OpenDevToolsReqSchema>;

/**
 * devtools:open 响应 payload
 */
export interface OpenDevToolsRes {
  /** 是否成功打开 DevTools（已打开时重复调用会聚焦原窗口，仍返回 true） */
  readonly ok: boolean;
  /** 实际使用的 mode（便于渲染层反馈用户） */
  readonly mode: 'detach' | 'right' | 'bottom';
}
