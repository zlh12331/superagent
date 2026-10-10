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
  if (webContents.isDestroyed()) {
    logger.warn({ channel: def.channel }, 'webContents 已销毁，跳过事件推送');
    return;
  }

  let isPackaged = true;
  try {
    isPackaged = app.isPackaged;
  } catch {}
  if (!isPackaged && def.payloadSchema !== undefined) {
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
