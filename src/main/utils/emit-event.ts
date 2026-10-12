// emit-event.ts：主进程 → 渲染层事件推送统一出口——webContents 销毁检查 + dev 环境契约抽样校验
// 边界：请求-响应 IPC 不走这里（那是 utils/wrap.ts）；打包态校验零开销（只在 dev 生效）
import { app, type WebContents } from 'electron';
import type { ZodType } from 'zod';
import { logger } from './logger';

interface EventDefLike {
  readonly channel: string;
  readonly payloadSchema?: ZodType;
}

// 流式事件高频（每个 delta 一条），逐条 zod parse 开销大：首条必校验，之后每 50 条抽一条
const STREAM_SAMPLE_INTERVAL = 50;

const streamSampleCounts = new Map<string, number>();

/** 清空抽样计数（测试隔离用） */
export function resetStreamSampleCounts(): void {
  streamSampleCounts.clear();
}

// 抽样按 channel + part.type 分桶：不同 part 类型（text/tool_call/…）各自独立计数
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

// 非流式通道全量校验（低频，契约必须 100% 把关）；流式按桶抽样
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
 * 推送事件到渲染层：目标已销毁只告警不抛（渲染层崩溃重建窗口期间属常态）；
 * dev 下校验失败记 error 但仍发送（契约回归靠日志抓，不掐断实时流）
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
