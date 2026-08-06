// src/main/infra/ai/agent-runtime/concurrency-gate.test.ts
// 并发槽位门单测：槽位限制 / FIFO 公平 / 排队 abort 让位 / 释放幂等

import { describe, expect, it } from 'vitest';
import { createConcurrencyGate, createGateAbortError } from './concurrency-gate';

describe('createConcurrencyGate', () => {
  it('超并发时 FIFO 排队，释放后按先来先得放行（平均分配语义）', async () => {
    const gate = createConcurrencyGate(2);
    const order: string[] = [];

    // 前两个立即放行
    const r1 = await gate.acquire('s1');
    const r2 = await gate.acquire('s2');
    expect(gate.getStats()).toEqual({ running: 2, queued: 0 });

    // 第三个排队（FIFO）
    const p3 = gate.acquire('s3').then((release) => {
      order.push('s3');
      return release;
    });
    // 第四个排队（FIFO）
    const p4 = gate.acquire('s4').then((release) => {
      order.push('s4');
      return release;
    });
    expect(gate.getStats()).toEqual({ running: 2, queued: 2 });

    // 释放 s1 → s3 放行；释放 s2 → s4 放行
    r1();
    const r3 = await p3;
    expect(order).toEqual(['s3']);
    expect(gate.getStats()).toEqual({ running: 2, queued: 1 });

    r2();
    const r4 = await p4;
    expect(order).toEqual(['s3', 's4']);
    expect(gate.getStats()).toEqual({ running: 2, queued: 0 });

    r3();
    r4();
    expect(gate.getStats()).toEqual({ running: 0, queued: 0 });
  });

  it('释放函数幂等：重复调用不重复放行', async () => {
    const gate = createConcurrencyGate(1);
    const release = await gate.acquire('s1');
    const p2 = gate.acquire('s2').then((r) => {
      r();
      return 's2-done';
    });
    // 重复释放（模拟误调）不产生额外空位
    release();
    release();
    release();
    expect(await p2).toBe('s2-done');
    expect(gate.getStats()).toEqual({ running: 0, queued: 0 });
  });

  it('排队期间 abort：移除队列并抛 AbortError，让位给后续会话', async () => {
    const gate = createConcurrencyGate(1);
    const release = await gate.acquire('s1');

    // s2 排队
    const controller2 = new AbortController();
    const p2 = gate.acquire('s2', controller2.signal).catch((error: unknown) => error);
    // s3 排队
    const p3 = gate.acquire('s3');
    expect(gate.getStats()).toEqual({ running: 1, queued: 2 });

    // abort s2 → 让位，s3 前移
    controller2.abort();
    const err2 = await p2;
    expect(err2).toBeInstanceOf(DOMException);
    expect((err2 as DOMException).name).toBe('AbortError');
    expect(gate.getStats()).toEqual({ running: 1, queued: 1 });

    // 释放后 s3 直接放行（不再等 s2）
    release();
    const release3 = await p3;
    expect(gate.getStats()).toEqual({ running: 1, queued: 0 });

    // s3 执行完毕释放
    release3();
    expect(gate.getStats()).toEqual({ running: 0, queued: 0 });
  });

  it('已中断信号直接失败（不排队）', async () => {
    const gate = createConcurrencyGate(2);
    const controller = new AbortController();
    controller.abort();
    await expect(gate.acquire('s1', controller.signal)).rejects.toThrow(
      createGateAbortError().message,
    );
    expect(gate.getStats()).toEqual({ running: 0, queued: 0 });
  });

  it('无效 maxConcurrent 抛错', () => {
    expect(() => createConcurrencyGate(0)).toThrow();
    expect(() => createConcurrencyGate(-1)).toThrow();
    expect(() => createConcurrencyGate(2.5)).toThrow();
    expect(() => createConcurrencyGate(Number.NaN)).toThrow();
  });
});
