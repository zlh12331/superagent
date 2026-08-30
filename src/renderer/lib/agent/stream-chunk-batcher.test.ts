// src/renderer/lib/agent/stream-chunk-batcher.test.ts
// 流式 text-delta 出口合并器行为锁定
// ──────────────────────────────────────────────
// 回归目标：修复「每个 token 一次 DOM 提交 ⇒ 流式消息 react-markdown 全量重解析 O(n²)」。
// 关键约束：合并不许丢字、不许乱序、不许跨 text part 串字。

import type { UIMessageChunk } from 'ai';
import { beforeEach, describe, expect, it } from 'vitest';

import { createStreamChunkBatcher, TEXT_DELTA_BATCH_MS } from './stream-chunk-batcher';

/** 便于书写的 text-delta 构造 */
function delta(id: string, text: string): UIMessageChunk {
  return { type: 'text-delta', id, delta: text };
}

describe('createStreamChunkBatcher', () => {
  let emitted: UIMessageChunk[] = [];
  /** 手动调度器：测试自行决定定时器何时触发（不依赖假计时器与流的交互） */
  let timers: Array<{ cb: () => void; ms: number }> = [];

  function makeBatcher(overrides?: { batchMs?: number; maxChars?: number }) {
    timers = [];
    emitted = [];
    return createStreamChunkBatcher({
      emit: (chunk) => emitted.push(chunk),
      schedule: (cb) => {
        timers.push({ cb, ms: TEXT_DELTA_BATCH_MS });
        return () => {
          timers = timers.filter((t) => t.cb !== cb);
        };
      },
      ...overrides,
    });
  }

  /** 触发当前挂起的定时器（模拟窗口到期） */
  function runTimers(): void {
    for (const timer of [...timers]) {
      timer.cb();
    }
  }

  beforeEach(() => {
    emitted = [];
    timers = [];
  });

  it('相邻同 id 的 delta 合并为一次透出', () => {
    const batcher = makeBatcher();
    batcher.push(delta('t1', 'he'));
    batcher.push(delta('t1', 'll'));
    batcher.push(delta('t1', 'o'));
    expect(emitted).toHaveLength(0);
    runTimers();
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ type: 'text-delta', id: 't1', delta: 'hello' });
  });

  it('500 个 token 在一个窗口内只产生 1 次提交（O(n²) 复解析的根因）', () => {
    const batcher = makeBatcher();
    for (let i = 0; i < 500; i += 1) {
      batcher.push(delta('t1', `w${i}`));
    }
    runTimers();
    expect(emitted).toHaveLength(1);
    const merged = emitted[0];
    expect(merged?.type === 'text-delta' ? merged.delta : '').toBe(
      Array.from({ length: 500 }, (_, i) => `w${i}`).join(''),
    );
  });

  it('不同 text part（id 不同）不串字：先落地旧缓冲再开新缓冲', () => {
    const batcher = makeBatcher();
    batcher.push(delta('t1', 'A'));
    batcher.push(delta('t2', 'B'));
    expect(emitted).toEqual([delta('t1', 'A')]);
    runTimers();
    expect(emitted).toEqual([delta('t1', 'A'), delta('t2', 'B')]);
  });

  it('非 delta chunk 立即透出且保持顺序（先冲缓冲）', () => {
    const batcher = makeBatcher();
    batcher.push(delta('t1', 'A'));
    batcher.push({ type: 'finish' } as UIMessageChunk);
    expect(emitted).toEqual([delta('t1', 'A'), { type: 'finish' }]);
  });

  it('缓冲超过字符上限立即透出（高频流下不累积延迟）', () => {
    const batcher = makeBatcher({ maxChars: 8 });
    batcher.push(delta('t1', '1234'));
    batcher.push(delta('t1', '5678'));
    expect(emitted).toEqual([delta('t1', '12345678')]);
    // 缓冲已清空：再次 flush 不产生重复透出
    batcher.flush();
    expect(emitted).toHaveLength(1);
  });

  it('flush 幂等：无缓冲时为 no-op', () => {
    const batcher = makeBatcher();
    batcher.flush();
    batcher.push(delta('t1', 'A'));
    batcher.flush();
    batcher.flush();
    expect(emitted).toEqual([delta('t1', 'A')]);
    // 缓冲落地后定时器已取消
    expect(timers).toHaveLength(0);
  });

  it('dispose 放弃缓冲并取消定时器（流被取消时不再写下游）', () => {
    const batcher = makeBatcher();
    batcher.push(delta('t1', 'A'));
    batcher.dispose();
    expect(timers).toHaveLength(0);
    batcher.flush();
    batcher.push(delta('t1', 'B'));
    expect(emitted).toHaveLength(0);
  });
});
