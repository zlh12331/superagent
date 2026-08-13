// packages/shared/src/schemas/dialog.ts
// Dialog 域 zod schema（原生对话框）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 定义 dialog:pickDirectory / dialog:pickFiles 请求-响应 zod schema
// - 供主进程 DialogHandler 校验入参
// ──────────────────────────────────────────────────────────────

import { z } from 'zod';

/** dialog:pickDirectory 入参 zod schema（无入参） */
export const DialogPickDirectoryReqSchema = z.object({});

/** dialog:pickDirectory 入参类型 */
export type DialogPickDirectoryReq = z.infer<typeof DialogPickDirectoryReqSchema>;

/** dialog:pickDirectory 响应 payload */
export interface DialogPickDirectoryRes {
  /** 用户是否取消选择 */
  readonly canceled: boolean;
  /** 选中的目录路径（canceled=true 时为 undefined） */
  readonly path?: string;
}

/** dialog:pickDirectory 响应 zod schema（R4：响应契约校验） */
export const DialogPickDirectoryResSchema = z.object({
  canceled: z.boolean(),
  path: z.string().optional(),
});

/** dialog:pickFiles 入参 zod schema */
export const DialogPickFilesReqSchema = z.object({
  /** 是否允许多选（默认 true） */
  multiple: z
    .boolean()
    .optional()
    .transform((v) => v ?? true),
});

/** dialog:pickFiles 入参类型 */
export type DialogPickFilesReq = z.infer<typeof DialogPickFilesReqSchema>;

/** dialog:pickFiles 响应 payload */
export interface DialogPickFilesRes {
  /** 用户是否取消选择 */
  readonly canceled: boolean;
  /** 选中的文件路径列表（canceled=true 时为 undefined） */
  readonly paths?: string[];
}

/** dialog:pickFiles 响应 zod schema（R4：响应契约校验） */
export const DialogPickFilesResSchema = z.object({
  canceled: z.boolean(),
  paths: z.array(z.string()).optional(),
});
