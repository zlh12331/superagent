// src/main/utils/emit-event.test.ts
// 事件推送统一出口单测：dev 契约校验 + 发送
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const { mockIsPackaged, mockSend } = vi.hoisted(() => ({
  mockIsPackaged: { value: false },
  mockSend: vi.fn(),
}));

vi.mock('electron', () => ({
  app: {
    // getter 形式保持与 emit-event 的 app.isPackaged 读取一致
    get isPackaged() {
      return mockIsPackaged.value;
    },
  },
  // biome-ignore lint/style/useNamingConvention: mock electron WebContents，需匹配 SDK 类型形状
  WebContents: class {},
}));

vi.mock('./logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { emitEvent, resetStreamSampleCounts } from './emit-event';

/** 构造最小 webContents mock（R2：emitEvent 内置 isDestroyed 防御，mock 需暴露该方法） */
function createWebContents() {
  return { send: mockSend, isDestroyed: () => false } as never;
}

describe('emitEvent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // 采样计数为模块级：每用例前清空，保证「首事件校验」语义独立
    resetStreamSampleCounts();
  });

  it('dev 模式：payload 合法时发送', () => {
    mockIsPackaged.value = false;
    const def = {
      channel: 'agent:stream:end',
      payloadSchema: z.object({ sessionId: z.string(), reason: z.enum(['completed']) }),
    };
    emitEvent(createWebContents(), def, { sessionId: 's-1', reason: 'completed' });
    expect(mockSend).toHaveBeenCalledWith('agent:stream:end', {
      sessionId: 's-1',
      reason: 'completed',
    });
  });

  it('dev 模式：payload 契约不符时仍发送但记录错误日志（不阻断主流程）', async () => {
    mockIsPackaged.value = false;
    const { logger } = await import('./logger');
    const def = {
      channel: 'agent:stream:end',
      payloadSchema: z.object({ sessionId: z.string(), reason: z.enum(['completed']) }),
    };
    // 漂移 payload：缺 sessionId
    emitEvent(createWebContents(), def, { reason: 'completed' });
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalled();
  });

  it('prod 模式：跳过校验直接发送', () => {
    mockIsPackaged.value = true;
    const def = { channel: 'agent:stream:end' };
    emitEvent(createWebContents(), def, { whatever: true });
    expect(mockSend).toHaveBeenCalledWith('agent:stream:end', { whatever: true });
  });

  it('R2：webContents 已销毁 → 跳过推送（不 send）', () => {
    const destroyed = { send: mockSend, isDestroyed: () => true } as never;
    const def = { channel: 'agent:stream:end' };
    emitEvent(destroyed, def, { whatever: true });
    expect(mockSend).not.toHaveBeenCalled();
  });

  // ── P2-38：流式通道 dev 校验采样（同类型首事件 + 每 50 次） ──────────

  it('P2-38 流式通道：首事件校验，第 2 条起跳过（漂移不记日志）', async () => {
    mockIsPackaged.value = false;
    const { logger } = await import('./logger');
    const def = {
      channel: 'agent:stream:part',
      payloadSchema: z.object({ sessionId: z.string(), part: z.unknown() }),
    };
    const wc = createWebContents();
    // 首条漂移 → 校验 → 记日志
    emitEvent(wc, def, { part: {} });
    expect(logger.error).toHaveBeenCalledTimes(1);
    // 第 2 条漂移 → 采样跳过 → 不记日志（仍发送）
    emitEvent(wc, def, { part: {} });
    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it('P2-38 流式通道：每 50 次再校验一次（防漂移抽查）', async () => {
    mockIsPackaged.value = false;
    const { logger } = await import('./logger');
    const def = {
      channel: 'chat:stream:part',
      payloadSchema: z.object({ sessionId: z.string() }),
    };
    const wc = createWebContents();
    for (let i = 0; i < 50; i++) {
      emitEvent(wc, def, { part: {} }); // 全部漂移（缺 sessionId）
    }
    // 第 1 次与第 50 次被校验（50 % 50 === 0）
    expect(logger.error).toHaveBeenCalledTimes(2);
    expect(mockSend).toHaveBeenCalledTimes(50); // 校验失败不阻断发送
  });

  it('P2-38 流式通道：part.type 参与采样分桶（不同类型各自首验）', async () => {
    mockIsPackaged.value = false;
    const { logger } = await import('./logger');
    const def = {
      channel: 'agent:stream:part',
      payloadSchema: z.object({ sessionId: z.string() }),
    };
    const wc = createWebContents();
    // 三条均为漂移 payload（缺 sessionId），但分桶按 part.type：
    // text-delta 首条被校验；tool-call 是新类型也首验；text-delta 第二条被采样跳过
    emitEvent(wc, def, { part: { type: 'text-delta' } });
    emitEvent(wc, def, { part: { type: 'tool-call' } });
    emitEvent(wc, def, { part: { type: 'text-delta' } });
    expect(logger.error).toHaveBeenCalledTimes(2);
  });

  it('P2-38 非流式通道：保持全量校验（每条漂移都记日志）', async () => {
    mockIsPackaged.value = false;
    const { logger } = await import('./logger');
    const def = {
      channel: 'agent:tool:call',
      payloadSchema: z.object({ sessionId: z.string() }),
    };
    const wc = createWebContents();
    emitEvent(wc, def, {});
    emitEvent(wc, def, {});
    emitEvent(wc, def, {});
    expect(logger.error).toHaveBeenCalledTimes(3);
  });
});
