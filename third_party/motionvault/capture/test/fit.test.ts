/**
 * fit.ts 单元测试：合成曲线（线性 / ease-in-out / 循环正弦 / overshoot / 多通道同步）。
 * 运行：cd capture && npx tsx --test test/
 * （node ≥22 可用 node --test --experimental-strip-types test/）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fitSegments } from '../src/core/fit';
import type { SampleCurve } from '../src/core/types';

/** 与 fit.ts 内一致的 cubic-bezier y(x) 求解（二分），用于生成「真实 bezier」合成数据 */
function cubicBezier(x1: number, y1: number, x2: number, y2: number): (x: number) => number {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  return (x: number): number => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let lo = 0;
    let hi = 1;
    let t = x;
    for (let i = 0; i < 40; i++) {
      t = (lo + hi) / 2;
      const xt = ((ax * t + bx) * t + cx) * t;
      if (xt < x) lo = t;
      else hi = t;
    }
    return ((ay * t + by) * t + cy) * t;
  };
}

/** 以固定 fps 生成 SampleCurve：fns 为 通道名 → 值函数(t ms) */
function makeCurve(
  fns: Record<string, (t: number) => number>,
  durationMs = 3000,
  fps = 60,
): SampleCurve {
  const dt = 1000 / fps;
  const channels: SampleCurve['channels'] = {};
  for (const [name, fn] of Object.entries(fns)) {
    const pts: Array<[number, number]> = [];
    for (let t = 0; t <= durationMs; t += dt) pts.push([t, fn(t)]);
    channels[name] = pts;
  }
  return { fps, durationMs, channels };
}

test('线性位移动画：分段起止 ±50ms，easing=linear，error 极低', () => {
  // 300ms 静止 → 300~1100ms 线性 0→200px → 静止
  const curve = makeCurve({
    translateX: (t) => (t < 300 ? 0 : t > 1100 ? 200 : ((t - 300) / 800) * 200),
  });
  const segs = fitSegments(curve);
  assert.equal(segs.length, 1);
  const s = segs[0];
  assert.ok(Math.abs(s.startMs - 300) <= 50, `startMs=${s.startMs}`);
  assert.ok(Math.abs(s.endMs - 1100) <= 50, `endMs=${s.endMs}`);
  assert.equal(s.easing, 'linear');
  assert.ok(s.error < 0.05, `error=${s.error}`);
  assert.ok(Math.abs(s.channels.translateX.from - 0) <= 5, `from=${s.channels.translateX.from}`);
  assert.ok(Math.abs(s.channels.translateX.to - 200) <= 5, `to=${s.channels.translateX.to}`);
  assert.equal(s.periodMs, undefined);
});

test('ease-in-out（真实 bezier 生成）：easing 命中知名曲线名', () => {
  const eio = cubicBezier(0.42, 0, 0.58, 1);
  const curve = makeCurve({
    opacity: (t) => (t < 200 ? 0 : t > 1000 ? 1 : eio((t - 200) / 800)),
  });
  const segs = fitSegments(curve);
  assert.equal(segs.length, 1);
  const s = segs[0];
  assert.ok(Math.abs(s.startMs - 200) <= 50, `startMs=${s.startMs}`);
  assert.ok(Math.abs(s.endMs - 1000) <= 50, `endMs=${s.endMs}`);
  assert.equal(s.easing, 'ease-in-out');
  assert.ok(s.error < 0.05, `error=${s.error}`);
  assert.ok(Math.abs(s.channels.opacity.from - 0) <= 0.05);
  assert.ok(Math.abs(s.channels.opacity.to - 1) <= 0.05);
});

test('循环正弦：自相关检出 periodMs ±10%，段截到首个极值', () => {
  // 周期 600ms、幅值 50px 的正弦，3000ms 共 5 个周期
  const curve = makeCurve({ translateY: (t) => 50 * Math.sin((2 * Math.PI * t) / 600) });
  const segs = fitSegments(curve);
  assert.ok(segs.length >= 1);
  const s = segs[0];
  assert.ok(s.periodMs !== undefined, '应检出循环');
  assert.ok(Math.abs(s.periodMs - 600) <= 60, `periodMs=${s.periodMs}`);
  assert.ok(Math.abs(s.startMs - 0) <= 50, `startMs=${s.startMs}`);
  // 往返段被截到去程极值（150ms 处的波峰 50px）
  assert.ok(Math.abs(s.endMs - 150) <= 60, `endMs=${s.endMs}`);
  assert.ok(Math.abs(s.channels.translateY.to - 50) <= 5, `to=${s.channels.translateY.to}`);
  assert.ok(s.error < 0.1, `error=${s.error}`);
});

test('overshoot 回弹（ease-out-back）：直接判 spring/overshoot', () => {
  const eob = cubicBezier(0.34, 1.56, 0.64, 1); // 峰值归一化 ≈1.099
  const curve = makeCurve({
    scaleX: (t) => (t < 100 ? 1 : t > 700 ? 1.5 : 1 + 0.5 * eob((t - 100) / 600)),
  });
  const segs = fitSegments(curve);
  assert.equal(segs.length, 1);
  const s = segs[0];
  assert.ok(Math.abs(s.startMs - 100) <= 50, `startMs=${s.startMs}`);
  assert.equal(s.easing, 'spring/overshoot');
  assert.ok(s.error > 0 && s.error <= 0.5, `error=${s.error}`);
  assert.ok(Math.abs(s.channels.scaleX.to - 1.5) <= 0.05);
});

test('多通道同步活跃段时间重叠 ≥60% 归为同一段', () => {
  const curve = makeCurve({
    opacity: (t) => (t > 600 ? 1 : t / 600),
    translateX: (t) => (t > 600 ? 100 : (t / 600) * 100),
  });
  const segs = fitSegments(curve);
  assert.equal(segs.length, 1);
  const s = segs[0];
  assert.ok('opacity' in s.channels && 'translateX' in s.channels);
  assert.ok(Math.abs(s.channels.opacity.from - 0) <= 0.05);
  assert.ok(Math.abs(s.channels.opacity.to - 1) <= 0.05);
  assert.ok(Math.abs(s.channels.translateX.from - 0) <= 5);
  assert.ok(Math.abs(s.channels.translateX.to - 100) <= 5);
  assert.ok(Math.abs(s.startMs - 0) <= 50, `startMs=${s.startMs}`);
  assert.ok(Math.abs(s.endMs - 600) <= 50, `endMs=${s.endMs}`);
});

test('静止曲线：无活跃段返回空数组', () => {
  const curve = makeCurve({ translateX: () => 42, opacity: () => 0.8 });
  assert.deepEqual(fitSegments(curve), []);
});

test('空通道曲线：返回空数组', () => {
  assert.deepEqual(fitSegments({ fps: 60, durationMs: 3000, channels: {} }), []);
});
