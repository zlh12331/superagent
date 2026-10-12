// concurrency-gate.test.ts：分桶并发门测试——per-provider 隔离、桶内 FIFO/冷却、快路径公平性、
// 时间行为（fake timers 只在 gate 层——controller 本身零 fake timers 穷举测试在 controller.test）
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createConcurrencyGate, createGateAbortError, MAX_COOLDOWN_MS } from './concurrency-gate';

describe('createConcurrencyGate（分桶并发门）', () => {
  it('桶隔离：A 桶打满不影响 B 桶准入', async () => {
    const gate = createConcurrencyGate(1);
    const rA = await gate.acquire('deepseek', 's1');
    expect(gate.getStats()).toEqual({ running: 1, queued: 0 });

    // A 桶满：s2 排队；B 桶空：立即放行
    const pA2 = gate.acquire('deepseek', 's2');
    const rB = await gate.acquire('openai', 's3');
    expect(gate.getStats()).toEqual({ running: 2, queued: 1 });

    rA();
    const rA2 = await pA2;
    rA2();
    rB();
    expect(gate.getStats()).toEqual({ running: 0, queued: 0 });
  });

  it('桶内 FIFO：超并发排队，释放后先来先得', async () => {
    const gate = createConcurrencyGate(2);
    const order: string[] = [];
    const r1 = await gate.acquire('deepseek', 's1');
    const r2 = await gate.acquire('deepseek', 's2');
    const p3 = gate.acquire('deepseek', 's3').then((release) => {
      order.push('s3');
      return release;
    });
    const p4 = gate.acquire('deepseek', 's4').then((release) => {
      order.push('s4');
      return release;
    });
    expect(gate.getStats()).toEqual({ running: 2, queued: 2 });

    r1();
    await p3;
    expect(order).toEqual(['s3']);
    r2();
    await p4;
    expect(order).toEqual(['s3', 's4']);
  });

  it('释放函数幂等：重复调用不重复放行', async () => {
    const gate = createConcurrencyGate(1);
    const release = await gate.acquire('deepseek', 's1');
    const p2 = gate.acquire('deepseek', 's2');
    release();
    release();
    release();
    const r2 = await p2;
    expect(gate.getStats()).toEqual({ running: 1, queued: 0 });
    r2();
  });

  it('账目闭环：终态上报后 release 恰好回减一次（回归：双回减曾致实际并发超 cap）', async () => {
    const gate = createConcurrencyGate(2);
    const r1 = await gate.acquire('deepseek', 's1');
    const r2 = await gate.acquire('deepseek', 's2');
    expect(gate.getStats()).toEqual({ running: 2, queued: 0 });

    // s1 完成：终态上报（纯学习）+ release（唯一回减口）→ 账面恰减一次
    gate.reportAttemptOutcome('deepseek', { kind: 'succeeded' });
    r1();
    const r3 = await gate.acquire('deepseek', 's3');
    expect(gate.getStats()).toEqual({ running: 2, queued: 0 }); // 真实 2 = 账面 2

    // s2 完成 → s4 准入 → 再次满 2；此刻第 5 个必须排队（cap=2 不被旁路）
    gate.reportAttemptOutcome('deepseek', { kind: 'failed' });
    r2();
    const r4 = await gate.acquire('deepseek', 's4');
    expect(gate.getStats()).toEqual({ running: 2, queued: 0 });
    const p5 = gate.acquire('deepseek', 's5');
    let settled = false;
    void p5.then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);
    // s3 完成 → s5 补位；依次收尾归零
    gate.reportAttemptOutcome('deepseek', { kind: 'succeeded' });
    r3();
    const r5 = await p5;
    gate.reportAttemptOutcome('deepseek', { kind: 'throttled' });
    r4();
    gate.reportAttemptOutcome('deepseek', { kind: 'failed' });
    r5();
    expect(gate.getStats()).toEqual({ running: 0, queued: 0 });
  });

  it('排队期间 abort：移除队列并抛 AbortError', async () => {
    const gate = createConcurrencyGate(1);
    const release = await gate.acquire('deepseek', 's1');
    const controller2 = new AbortController();
    const p2 = gate.acquire('deepseek', 's2', controller2.signal).catch((error: unknown) => error);
    const p3 = gate.acquire('deepseek', 's3');
    controller2.abort();
    const err2 = await p2;
    expect(err2).toBeInstanceOf(DOMException);
    expect((err2 as DOMException).name).toBe('AbortError');
    release();
    const r3 = await p3;
    r3();
  });

  it('已中断信号直接失败（不排队）', async () => {
    const gate = createConcurrencyGate(2);
    const controller = new AbortController();
    controller.abort();
    await expect(gate.acquire('deepseek', 's1', controller.signal)).rejects.toThrow(
      createGateAbortError().message,
    );
  });

  it('无效上限抛错', () => {
    expect(() => createConcurrencyGate(0)).toThrow();
    expect(() => createConcurrencyGate(-1)).toThrow();
    expect(() => createConcurrencyGate(2.5)).toThrow();
  });

  describe('限流冷却（per-provider 桶）', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('冷却只作用于本桶：deepseek 冷却时 openai 正常准入', async () => {
      const gate = createConcurrencyGate(1);
      gate.coolDown('deepseek', 1000);
      expect(gate.isCoolingDown('deepseek')).toBe(true);
      expect(gate.isCoolingDown('openai')).toBe(false);

      const rB = await gate.acquire('openai', 's-b');
      expect(gate.getStats().running).toBe(1);
      rB();
    });

    it('冷却期：即使有空槽 acquire 也排队，冷却到期自动放行', async () => {
      const gate = createConcurrencyGate(2);
      gate.coolDown('deepseek', 1000);
      const acquired: string[] = [];
      const p1 = gate.acquire('deepseek', 's1').then((release) => {
        acquired.push('s1');
        return release;
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(acquired).toEqual([]);

      await vi.advanceTimersByTimeAsync(1000);
      const release = await p1;
      expect(acquired).toEqual(['s1']);
      release();
    });

    it('多次 coolDown 取最晚值；非法值忽略；超 MAX_COOLDOWN_MS 封顶', () => {
      const gate = createConcurrencyGate(1);
      gate.coolDown('deepseek', 2000);
      gate.coolDown('deepseek', 500); // 更短不提前结束
      vi.advanceTimersByTime(500);
      expect(gate.isCoolingDown('deepseek')).toBe(true);

      gate.coolDown('deepseek', Number.NaN);
      gate.coolDown('deepseek', -5);
      expect(gate.isCoolingDown('deepseek')).toBe(true);

      gate.coolDown('openai', MAX_COOLDOWN_MS * 10);
      vi.advanceTimersByTime(MAX_COOLDOWN_MS);
      expect(gate.isCoolingDown('openai')).toBe(false);
      expect(gate.isCoolingDown('deepseek')).toBe(false);
    });

    it('waitCooldown：冷却中等待到结束；无冷却立即返回', async () => {
      const gate = createConcurrencyGate(1);
      await gate.waitCooldown('deepseek'); // 桶未创建：立即返回

      gate.coolDown('deepseek', 1000);
      const p = gate.waitCooldown('deepseek');
      await vi.advanceTimersByTimeAsync(1000);
      await expect(p).resolves.toBeUndefined();
    });

    it('bucketSnapshot：暴露桶内 controller 状态；未创建桶返回 undefined', () => {
      const gate = createConcurrencyGate(4);
      expect(gate.bucketSnapshot('deepseek')).toBeUndefined();
      gate.coolDown('deepseek', 100);
      const snap = gate.bucketSnapshot('deepseek');
      expect(snap).toMatchObject({ ceiling: 4, cap: 4 });
    });
  });
});
