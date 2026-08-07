// src/main/utils/emit-event.ts
// 事件推送统一出口：dev 环境 payload 契约校验 + 发送
// ──────────────────────────────────────────────────────────────
// 职责：
// - 主进程 webContents.send 推送状态/流式事件时，先按定义表 payloadSchema
//   校验（dev only）——防"主进程改 payload 结构忘更新契约"运行时才暴露
// - prod 环境零开销（直接 send）
//
// 使用方式：
//   emitEvent(webContents, IPC_DEFINITIONS.agent.subscribeStreamEnd, payload);
// ──────────────────────────────────────────────────────────────

import { app, type WebContents } from 'electron';
import type { ZodType } from 'zod';
import { logger } from './logger';

/** 事件定义形状（definitions 中 event 条目） */
interface EventDefLike {
  readonly channel: string;
  readonly payloadSchema?: ZodType;
}

/**
 * 推送事件（dev 校验 payload 契约，prod 直接发送）
 *
 * @param webContents 目标窗口
 * @param def 事件定义（from IPC_DEFINITIONS，含 channel + payloadSchema）
 * @param payload 事件 payload
 */
export function emitEvent(webContents: WebContents, def: EventDefLike, payload: unknown): void {
  // dev 校验：契约漂移在开发期暴露（打包环境跳过，零开销）
  // app 不可用（测试环境 mock 未提供）时跳过校验直接发送，不阻断主流程
  let isPackaged = true;
  try {
    isPackaged = app.isPackaged;
  } catch {
    // 测试环境无 electron app：跳过校验
  }
  if (!isPackaged && def.payloadSchema !== undefined) {
    const parsed = def.payloadSchema.safeParse(payload);
    if (!parsed.success) {
      logger.error(
        { channel: def.channel, issues: parsed.error.issues },
        '事件 payload 契约校验失败（dev）',
      );
    }
  }
  webContents.send(def.channel, payload);
}
