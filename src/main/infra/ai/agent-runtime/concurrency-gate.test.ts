import { describe, expect, it } from 'vitest';
import { createConcurrencyGate, createGateAbortError } from './concurrency-gate';

describe('createConcurrencyGate', () => {
  it('超并发时 FIFO 排队，释放后按先来先得放行（平均分配语义）', async () => {
    const gate = createConcurrencyGate(2);
    const order: string[] = [];

    const r1 = await gate.acquire('s1');
    const r2 = await gate.acquire('s2');
    expect(gate.getStats()).toEqual({ running: 2, queued: 0 });

    const p3 = gate.acquire('s3').then((release) => {
      order.push('s3');
      return release;
    });
    const p4 = gate.acquire('s4').then((release) => {
      order.push('s4');
      return release;
    });
    expect(gate.getStats()).toEqual({ running: 2, queued: 2 });

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
    release();
    release();
    release();
    expect(await p2).toBe('s2-done');
    expect(gate.getStats()).toEqual({ running: 0, queued: 0 });
  });

  it('排队期间 abort：移除队列并抛 AbortError，让位给后续会话', async () => {
    const gate = createConcurrencyGate(1);
    const release = await gate.acquire('s1');

    const controller2 = new AbortController();
    const p2 = gate.acquire('s2', controller2.signal).catch((error: unknown) => error);
    const p3 = gate.acquire('s3');
    expect(gate.getStats()).toEqual({ running: 1, queued: 2 });

    controller2.abort();
    const err2 = await p2;
    expect(err2).toBeInstanceOf(DOMException);
    expect((err2 as DOMException).name).toBe('AbortError');
    expect(gate.getStats()).toEqual({ running: 1, queued: 1 });

    release();
    const release3 = await p3;
    expect(gate.getStats()).toEqual({ running: 1, queued: 0 });

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
