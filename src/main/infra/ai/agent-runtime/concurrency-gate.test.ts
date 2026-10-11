import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createConcurrencyGate, createGateAbortError, MAX_COOLDOWN_MS } from './concurrency-gate';

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

  describe('限流冷却（coolDown）', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('冷却期：即使有空槽 acquire 也排队，冷却到期自动放行', async () => {
      const gate = createConcurrencyGate(2);
      vi.setSystemTime(1_000_000);
      gate.coolDown(1000);
      expect(gate.isCoolingDown()).toBe(true);

      const acquired: string[] = [];
      const p1 = gate.acquire('s1').then((release) => {
        acquired.push('s1');
        return release;
      });
      // 冷却未到：不放行
      await vi.advanceTimersByTimeAsync(0);
      expect(acquired).toEqual([]);

      // 冷却到期：唤醒定时器放行
      await vi.advanceTimersByTimeAsync(1000);
      expect(gate.isCoolingDown()).toBe(false);
      const release = await p1;
      expect(acquired).toEqual(['s1']);
      release();
    });

    it('冷却期已有在飞回合：release 后也不立即补位，冷却到期才放行', async () => {
      const gate = createConcurrencyGate(1);
      vi.setSystemTime(1_000_000);
      const release = await gate.acquire('s1');
      gate.coolDown(500);

      const p2 = gate.acquire('s2').then(() => {
        return 's2';
      });
      release();
      // 槽位已空但冷却中：不放行
      await vi.advanceTimersByTimeAsync(100);
      let settled = false;
      void p2.then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(400);
      expect(await p2).toBe('s2');
    });

    it('多次 coolDown：取最晚到期值，不缩短既有冷却', async () => {
      const gate = createConcurrencyGate(1);
      vi.setSystemTime(1_000_000);
      gate.coolDown(1000);
      gate.coolDown(200); // 更短：不应把冷却提前结束
      vi.advanceTimersByTime(200);
      expect(gate.isCoolingDown()).toBe(true);
      vi.advanceTimersByTime(800);
      expect(gate.isCoolingDown()).toBe(false);
    });

    it('非法值（负数/NaN/0）：忽略', () => {
      const gate = createConcurrencyGate(1);
      gate.coolDown(-100);
      gate.coolDown(Number.NaN);
      gate.coolDown(0);
      expect(gate.isCoolingDown()).toBe(false);
    });

    it('超 MAX_COOLDOWN_MS：封顶', () => {
      const gate = createConcurrencyGate(1);
      vi.setSystemTime(1_000_000);
      gate.coolDown(MAX_COOLDOWN_MS * 10);
      // 封顶后仍冷却，但到点时间是 now+MAX 而非 now+10×MAX
      expect(gate.isCoolingDown()).toBe(true);
      vi.advanceTimersByTime(MAX_COOLDOWN_MS);
      expect(gate.isCoolingDown()).toBe(false);
    });
  });
});
