// src/main/utils/emit-event.ts
// 事件推送统一出口：dev 环境 payload 契约校验 + 发送
// ──────────────────────────────────────────────────────────────
// 职责：
// - 主进程 webContents.send 推送状态/流式事件时，先按定义表 payloadSchema
//   校验（dev only）——防"主进程改 payload 结构忘更新契约"运行时才暴露
// - prod 环境零开销（直接 send）
// - P2-38：流式通道（{domain}:stream:{event}）part 高频（每 token 一条），
//   dev 校验改采样——同类型首事件全量校验 + 每 50 次再校验；非流式事件
//   保持全量校验，防漂移能力不丢
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

/** 流式通道采样间隔：同类型首事件校验后，每 N 次再校验一次 */
const STREAM_SAMPLE_INTERVAL = 50;

/**
 * 流式通道采样计数器：key = 通道 + part 类型（无类型粒度则通道级）
 *
 * 仅 dev 校验路径使用；容量以「通道数 × part 类型数」为上界，有界不泄漏。
 */
const streamSampleCounts = new Map<string, number>();

/** 清空流式采样计数（测试用；生产进程内持续累计） */
export function resetStreamSampleCounts(): void {
  streamSampleCounts.clear();
}

/** 流式事件采样 key：payload 为 { part: { type } } 信封时按 part 类型分桶 */
function streamSampleKey(channel: string, payload: unknown): string {
  if (typeof payload === 'object' && payload !== null) {
    const part = (payload as Record<string, unknown>)['part'];
    if (typeof part === 'object' && part !== null) {
      const type = (part as Record<string, unknown>)['type'];
      if (typeof type === 'string') {
        return `${channel}\u0000${type}`;
      }
    }
  }
  return channel;
}

/**
 * 本次是否需要 dev 校验
 *
 * 流式通道：同类型首事件 + 每 STREAM_SAMPLE_INTERVAL 次（防漂移抽查）；
 * 非流式通道：全量校验。
 */
function shouldValidate(channel: string, payload: unknown, isStreamChannel: boolean): boolean {
  if (!isStreamChannel) {
    return true;
  }
  const key = streamSampleKey(channel, payload);
  const count = (streamSampleCounts.get(key) ?? 0) + 1;
  streamSampleCounts.set(key, count);
  return count === 1 || count % STREAM_SAMPLE_INTERVAL === 0;
}

/**
 * 推送事件（dev 校验 payload 契约，prod 直接发送）
 *
 * @param webContents 目标窗口
 * @param def 事件定义（from IPC_DEFINITIONS，含 channel + payloadSchema）
 * @param payload 事件 payload
 */
export function emitEvent(webContents: WebContents, def: EventDefLike, payload: unknown): void {
  // R2 修复：isDestroyed 防御内置于统一出口——此前各发送点自管守卫，
  // 部分点位（如 agent-ask）缺失，向已销毁窗口 send 会抛 "Object has been destroyed"。
  // 统一在这里短路，调用方不再需要重复检查。
  if (webContents.isDestroyed()) {
    logger.warn({ channel: def.channel }, 'webContents 已销毁，跳过事件推送');
    return;
  }

  // dev 校验：契约漂移在开发期暴露（打包环境跳过，零开销）
  // app 不可用（测试环境 mock 未提供）时跳过校验直接发送，不阻断主流程
  let isPackaged = true;
  try {
    isPackaged = app.isPackaged;
  } catch {
    // 测试环境无 electron app：跳过校验
  }
  if (!isPackaged && def.payloadSchema !== undefined) {
    // P2-38：流式通道（{domain}:stream:{event}）part 高频，校验改采样
    // （同类型首事件 + 每 50 次）；非流式事件保持全量校验
    const isStreamChannel = def.channel.includes(':stream:');
    if (shouldValidate(def.channel, payload, isStreamChannel)) {
      const parsed = def.payloadSchema.safeParse(payload);
      if (!parsed.success) {
        logger.error(
          { channel: def.channel, issues: parsed.error.issues },
          '事件 payload 契约校验失败（dev）',
        );
      }
    }
  }
  webContents.send(def.channel, payload);
}
