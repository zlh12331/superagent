// concurrency-controller.test.ts：AIMD 纯状态机测试——时间戳注入（零 fake timers），
// 逐个喂 now 穷举迁移：乘性减/加性增/lastGood 记忆/epoch 阻尼/空闲重置/冷却窗口
import { describe, expect, it } from 'vitest';
import {
  CONCURRENCY_FLOOR,
  CONCURRENCY_IDLE_RESET_MS,
  CONCURRENCY_INCREASE_AFTER_SUCCESSES,
  ConcurrencyController,
} from './concurrency-controller';

describe('ConcurrencyController（AIMD 纯状态机）', () => {
  it('构造校验：ceiling 必须为正整数', () => {
    expect(() => new ConcurrencyController(0)).toThrow();
    expect(() => new ConcurrencyController(-1)).toThrow();
    expect(() => new ConcurrencyController(2.5)).toThrow();
  });

  it('初始状态：cap=ceiling，可准入', () => {
    const c = new ConcurrencyController(4);
    expect(c.snapshot()).toMatchObject({ cap: 4, ceiling: 4, inFlight: 0 });
    expect(c.canAdmit(1000)).toBe(true);
  });

  it('canAdmit：在飞打满 cap 后拒绝', () => {
    const c = new ConcurrencyController(2);
    c.admitted(1000);
    c.admitted(1001);
    expect(c.canAdmit(1002)).toBe(false);
  });

  it('乘性减：429 砍 cap 至 floor(cap×0.75)，不低于 FLOOR', () => {
    const c = new ConcurrencyController(8);
    c.admitted(1000);
    c.throttled(1001, { cooldownMs: 1000 });
    expect(c.snapshot().cap).toBe(6); // floor(8×0.75)

    c.admitted(1100);
    c.throttled(1101, { cooldownMs: 0 });
    expect(c.snapshot().cap).toBe(4); // floor(6×0.75)

    // 连续砍到 FLOOR 为止
    for (let i = 0; i < 10; i += 1) {
      c.admitted(2000 + i);
      c.throttled(2001 + i);
    }
    expect(c.snapshot().cap).toBe(CONCURRENCY_FLOOR);
  });

  it('加性增：连续成功 K 次后 cap+1，逐步探测回上限', () => {
    const c = new ConcurrencyController(4);
    c.admitted(1000);
    c.throttled(1001); // cap 4→3
    expect(c.snapshot().cap).toBe(3);

    // K-1 次成功：不动
    for (let i = 0; i < CONCURRENCY_INCREASE_AFTER_SUCCESSES - 1; i += 1) {
      c.admitted(2000 + i * 10);
      c.succeeded(2001 + i * 10);
    }
    expect(c.snapshot().cap).toBe(3);

    // 第 K 次：cap+1
    c.admitted(3000);
    c.succeeded(3001);
    expect(c.snapshot().cap).toBe(4);

    // 已到 ceiling：不再增长
    c.admitted(4000);
    c.succeeded(4001);
    c.admitted(4100);
    c.succeeded(4101);
    c.admitted(4200);
    c.succeeded(4201);
    c.admitted(4300);
    c.succeeded(4301);
    expect(c.snapshot().cap).toBe(4);
  });

  it('lastGood 记忆：从低水位上冲后撞墙，一步回退到已验证水位', () => {
    const c = new ConcurrencyController(8);
    // 先砍到 6（lastGood 被清——非上冲回落）
    c.admitted(1000);
    c.throttled(1001);
    expect(c.snapshot().cap).toBe(6);
    expect(c.snapshot().lastGood).toBeUndefined();

    // 从 6 探上 7、8（沿途 lastGood 记录 6）
    for (let i = 0; i < 8; i += 1) {
      c.admitted(2000 + i * 10);
      c.succeeded(2001 + i * 10);
    }
    expect(c.snapshot().cap).toBe(8);

    // 从 8 撞墙：回退到 lastGood（6 附近的最后安全值），不按公式继续砍
    c.admitted(5000);
    c.throttled(5001);
    const snap = c.snapshot();
    expect(snap.lastBad).toBe(8);
    expect(snap.cap).toBeLessThan(8);
  });

  it('冷却：throttled 记录 cooldownUntil，isCoolingDown/cooldownRemainingMs 正确', () => {
    const c = new ConcurrencyController(4);
    c.admitted(1000);
    c.throttled(1001, { cooldownMs: 30_000 });
    expect(c.isCoolingDown(2000)).toBe(true);
    expect(c.cooldownRemainingMs(2000)).toBe(29_001); // cooldownUntil = 1001+30000
    expect(c.isCoolingDown(31_001)).toBe(false);
    expect(c.cooldownRemainingMs(31_001)).toBe(0);
  });

  it('非限流失败（网络错）：不评价 cap，只释放计数', () => {
    const c = new ConcurrencyController(4);
    c.admitted(1000);
    c.failed(1001);
    expect(c.snapshot()).toMatchObject({ cap: 4, inFlight: 0 });
  });

  it('空闲重置：无在飞超过 IDLE_RESET_MS 后遗忘 cap 回 ceiling', () => {
    const c = new ConcurrencyController(8);
    c.admitted(1000);
    c.throttled(1001); // cap 8→6
    expect(c.snapshot().cap).toBe(6);

    // 空闲不足：不重置
    c.canAdmit(1001 + CONCURRENCY_IDLE_RESET_MS - 1);
    expect(c.snapshot().cap).toBe(6);

    // 空闲超过：遗忘
    c.canAdmit(1001 + CONCURRENCY_IDLE_RESET_MS + 1);
    expect(c.snapshot().cap).toBe(8);
  });

  it('在飞期间不触发空闲重置（inFlight>0 挡住）', () => {
    const c = new ConcurrencyController(8);
    c.admitted(1000);
    c.throttled(1001); // cap 6，inFlight 归零，lastRequestAt=1001
    // 再次准入（lastRequestAt 刷新为远未来），然后以更远的时间查 cap——
    // inFlight=1 挡住 idleReset
    const late = 1001 + CONCURRENCY_IDLE_RESET_MS + 1;
    c.admitted(late);
    c.canAdmit(late + CONCURRENCY_IDLE_RESET_MS);
    expect(c.snapshot().cap).toBe(6);
  });

  it('epoch：限流裁决递增（旧 epoch 的在途反馈由此失效）', () => {
    const c = new ConcurrencyController(4);
    const before = c.snapshot().epoch;
    c.admitted(1000);
    expect(c.snapshot().epoch).toBe(before); // 准入不动 epoch
    c.throttled(1001); // 裁决 +1
    expect(c.snapshot().epoch).toBe(before + 1);
    c.throttled(1002); // 再裁决再 +1
    expect(c.snapshot().epoch).toBe(before + 2);
  });

  it('stale 请求：只清 streak 刷冷却，不评价 cap（防回声连砍）', () => {
    const c = new ConcurrencyController(8);
    // 砍到 6
    c.admitted(1000);
    c.throttled(1001);
    expect(c.snapshot().cap).toBe(6);
    // 一个 stale 请求（旧 cap=8 世界发出）回来 429：cap 不动
    c.admitted(2000);
    c.throttled(2001, { stale: true });
    expect(c.snapshot().cap).toBe(6);
    // 对照：非 stale 请求会继续砍（6→4）
    c.admitted(3000);
    c.throttled(3001);
    expect(c.snapshot().cap).toBe(4);
  });
});
