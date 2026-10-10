import { app, type WebContents } from 'electron';
import type { ZodType } from 'zod';
import { logger } from './logger';

interface EventDefLike {
  readonly channel: string;
  readonly payloadSchema?: ZodType;
}

const STREAM_SAMPLE_INTERVAL = 50;

const streamSampleCounts = new Map<string, number>();

export function resetStreamSampleCounts(): void {
  streamSampleCounts.clear();
}

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

function shouldValidate(channel: string, payload: unknown, isStreamChannel: boolean): boolean {
  if (!isStreamChannel) {
    return true;
  }
  const key = streamSampleKey(channel, payload);
  const count = (streamSampleCounts.get(key) ?? 0) + 1;
  streamSampleCounts.set(key, count);
  return count === 1 || count % STREAM_SAMPLE_INTERVAL === 0;
}

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
