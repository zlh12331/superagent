// src/main/__tests__/stream-bridge.test.ts
// stream-bridge 单测
//
// 说明：原 IPC_CHANNELS.CHAT_STREAM_* 常量已随业务层删除，
// StreamBridge 现为通用工具，channel 由调用方传入字符串。
// 测试中使用字面量字符串模拟业务 channel。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getStreamBridge, resetStreamBridge, StreamBridge } from '../infra/ai/stream-bridge';

// 测试用 channel 字符串（模拟业务调用方传入的 channel）
const CHUNK_CHANNEL = 'test:stream:chunk';
const END_CHANNEL = 'test:stream:end';
const ERROR_CHANNEL = 'test:stream:error';

// 辅助：构造内存 AsyncIterable
function makeStream<T>(chunks: T[], shouldThrow = false): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        next(): Promise<IteratorResult<T>> {
          if (shouldThrow && i === chunks.length) {
            return Promise.reject(new Error('stream error'));
          }
          if (i >= chunks.length) {
            return Promise.resolve({ done: true, value: undefined as unknown as T });
          }
          // noUncheckedIndexedAccess 下 chunks[i] 推断为 T | undefined，断言为 T
          return Promise.resolve({ done: false, value: chunks[i++] as T });
        },
      };
    },
  };
}

// 模拟 webContents
function makeWebContents() {
  return {
    send: vi.fn(),
    isDestroyed: vi.fn(() => false),
  };
}

describe('StreamBridge', () => {
  let bridge: StreamBridge;

  beforeEach(() => {
    bridge = new StreamBridge();
  });

  it('streamToWebContents 迭代完成推送所有 chunk 与 end 事件', async () => {
    const wc = makeWebContents();
    const stream = makeStream(['hello', ' ', 'world']);

    const fullText = await bridge.streamToWebContents({
      sessionId: 'session-1',
      webContents: wc as never,
      stream,
      chunkChannel: CHUNK_CHANNEL,
      endChannel: END_CHANNEL,
      errorChannel: ERROR_CHANNEL,
    });

    expect(fullText).toBe('hello world');
    expect(wc.send).toHaveBeenCalledTimes(4); // 3 chunk + 1 end
    expect(wc.send).toHaveBeenNthCalledWith(1, CHUNK_CHANNEL, {
      sessionId: 'session-1',
      chunk: 'hello',
    });
    expect(wc.send).toHaveBeenNthCalledWith(4, END_CHANNEL, {
      sessionId: 'session-1',
      fullText: 'hello world',
    });
  });

  it('stream 抛错时推送 error 事件并清理', async () => {
    const wc = makeWebContents();
    const stream = makeStream(['a', 'b'], true);

    await expect(
      bridge.streamToWebContents({
        sessionId: 'session-2',
        webContents: wc as never,
        stream,
        chunkChannel: CHUNK_CHANNEL,
        endChannel: END_CHANNEL,
        errorChannel: ERROR_CHANNEL,
      }),
    ).rejects.toThrow('stream error');

    expect(wc.send).toHaveBeenCalledWith(ERROR_CHANNEL, {
      sessionId: 'session-2',
      error: 'stream error',
    });
    // 流被清理
    expect(await bridge.has('session-2')).toBe(false);
  });

  it('abort 中断流并推送 error 事件', async () => {
    const wc = makeWebContents();
    // definite assignment assertion：resolveNext 会在 Promise 构造时被赋值
    let resolveNext!: () => void;
    const blockedNext = new Promise<void>((resolve) => {
      resolveNext = resolve;
    });

    const stream: AsyncIterable<string> = {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<string>> {
            return blockedNext.then(() => ({ done: true, value: undefined as unknown as string }));
          },
        };
      },
    };

    const promise = bridge.streamToWebContents({
      sessionId: 'session-3',
      webContents: wc as never,
      stream,
      chunkChannel: CHUNK_CHANNEL,
      endChannel: END_CHANNEL,
      errorChannel: ERROR_CHANNEL,
    });

    await bridge.abort('session-3');
    resolveNext();

    await promise;

    expect(wc.send).toHaveBeenCalledWith(ERROR_CHANNEL, {
      sessionId: 'session-3',
      error: 'aborted',
    });
    expect(await bridge.has('session-3')).toBe(false);
  });

  it('has 返回活跃流状态', async () => {
    const wc = makeWebContents();
    const stream = makeStream(['a']);

    expect(await bridge.has('session-4')).toBe(false);

    const promise = bridge.streamToWebContents({
      sessionId: 'session-4',
      webContents: wc as never,
      stream,
      chunkChannel: CHUNK_CHANNEL,
      endChannel: END_CHANNEL,
      errorChannel: ERROR_CHANNEL,
    });
    // 流在迭代期间活跃
    expect(await bridge.has('session-4')).toBe(true);
    await promise;
    // 流结束后清理
    expect(await bridge.has('session-4')).toBe(false);
  });

  it('webContents 已销毁时不推送', async () => {
    const wc = makeWebContents();
    wc.isDestroyed.mockReturnValue(true);
    const stream = makeStream(['a', 'b']);

    const fullText = await bridge.streamToWebContents({
      sessionId: 'session-5',
      webContents: wc as never,
      stream,
      chunkChannel: CHUNK_CHANNEL,
      endChannel: END_CHANNEL,
      errorChannel: ERROR_CHANNEL,
    });

    expect(wc.send).not.toHaveBeenCalled();
    expect(fullText).toBe('ab');
  });
});

describe('getStreamBridge 单例', () => {
  it('多次调用应返回同一实例', () => {
    resetStreamBridge();
    const a = getStreamBridge();
    const b = getStreamBridge();
    expect(a).toBe(b);
  });

  it('resetStreamBridge 后应返回新实例', () => {
    resetStreamBridge();
    const a = getStreamBridge();
    resetStreamBridge();
    const b = getStreamBridge();
    expect(a).not.toBe(b);
  });
});
