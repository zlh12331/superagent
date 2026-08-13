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

import { emitEvent } from './emit-event';

/** 构造最小 webContents mock（R2：emitEvent 内置 isDestroyed 防御，mock 需暴露该方法） */
function createWebContents() {
  return { send: mockSend, isDestroyed: () => false } as never;
}

describe('emitEvent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
});
