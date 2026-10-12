// dialog.ts：Dialog 域 zod 契约单一真源——dialog:pickDirectory / dialog:pickFiles 的请求-响应形状
// 消费方：IPC 定义表（packages/shared/src/ipc/definitions.ts）引用这些 schema，注册层（src/main/ipc/register.ts）
// 据此校验入参与 handler 返回值（resSchema 缺失即启动抛错）；渲染层经 src/renderer/lib/dialog-actions.ts 调用。
// 边界：只定义形状；原生对话框调用、「未选中 → canceled」归一与选中文件的用户手势读取授权登记，
// 都在主进程 handler（src/main/ipc/dialog.handler.ts）。

import { z } from 'zod';

// ────────── dialog:pickDirectory：原生目录选择 ──────────

/**
 * dialog:pickDirectory 入参 zod schema（无字段）
 *
 * 无参也必须传空对象：undefined 过不了入参校验（INVALID_INPUT），多余键则被 zod 剥离后放行。
 */
export const DialogPickDirectoryReqSchema = z.object({});

/** dialog:pickDirectory 入参类型 */
export type DialogPickDirectoryReq = z.infer<typeof DialogPickDirectoryReqSchema>;

/**
 * dialog:pickDirectory 响应 payload（单选目录；原生对话框可能返回多个路径，主进程只取第一个）
 */
export interface DialogPickDirectoryRes {
  /** 用户是否取消选择（含直接关闭对话框；选中结果为空时主进程同样归为 true） */
  readonly canceled: boolean;
  /** 选中的目录路径（canceled=true 时为 undefined） */
  readonly path?: string;
}

/**
 * dialog:pickDirectory 响应 zod schema（响应契约校验：注册层据此核对 handler 返回值，不符即 INVALID_RESPONSE）
 */
export const DialogPickDirectoryResSchema = z.object({
  canceled: z.boolean(),
  path: z.string().optional(),
});

// ────────── dialog:pickFiles：原生文件选择（聊天附件入口） ──────────

/**
 * dialog:pickFiles 入参 zod schema（multiple 可省略）
 *
 * 调用须至少传 `{}`（undefined 入参过不了注册层的入参校验）。
 */
export const DialogPickFilesReqSchema = z.object({
  /**
   * 是否允许多选（省略 = true）
   *
   * 解析后该键恒存在且为 boolean——handler 可直接读 `input.multiple`，无需判 undefined。
   */
  multiple: z
    .boolean()
    .optional()
    .transform((v) => v ?? true),
});

/** dialog:pickFiles 入参类型（z.infer 取校验后形状，故 multiple 为必填 boolean） */
export type DialogPickFilesReq = z.infer<typeof DialogPickFilesReqSchema>;

/**
 * dialog:pickFiles 响应 payload（聊天附件入口）
 *
 * 副作用：canceled=false 时主进程会用这些路径登记「用户手势」读取授权，
 * 使工作区外的附件在后续 file:read 中可读。
 */
export interface DialogPickFilesRes {
  /** 用户是否取消选择（含直接关闭对话框；未选中任何文件时同样为 true） */
  readonly canceled: boolean;
  /** 选中的文件路径列表（canceled=true 时为 undefined） */
  readonly paths?: string[];
}

/**
 * dialog:pickFiles 响应 zod schema（响应契约校验：注册层据此核对 handler 返回值，不符即 INVALID_RESPONSE）
 */
export const DialogPickFilesResSchema = z.object({
  canceled: z.boolean(),
  paths: z.array(z.string()).optional(),
});
