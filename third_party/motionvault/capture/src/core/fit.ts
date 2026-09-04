/**
 * fit.ts — 采样曲线的数学拟合（纯函数，零 DOM 依赖，node 可直接测）。
 *
 * 流程：
 * 1. 逐通道中心差分速度 → 活跃段（|v| > 通道量程 1%/100ms），合并 80ms 内相邻段；
 * 2. 多通道活跃段按时间重叠 ≥60% 归为同一 FittedSegment；
 * 3. 幅值最大通道做自相关循环检测（lag 100ms ~ duration/2，峰值 >0.92）；
 *    判定循环后只拟合第一个周期，periodMs 挂在段上（iterations 由调用方推）；
 * 4. 段内归一化到 [0,1]，超调 >5% 直接判 'spring/overshoot'；
 *    否则在知名曲线集上粗选 cubic-bezier，再以 0.05 步长在邻域细化 P1/P2；
 * 5. error = RMSE / 段量程，截断 [0,1]。
 */
import type { SampleCurve, FittedSegment } from './types';

type Pt = [number, number];

/** 知名 easing 候选集：名字 → cubic-bezier P1/P2 */
const KNOWN: ReadonlyArray<readonly [string, [number, number, number, number]]> = [
  ['linear', [0, 0, 1, 1]],
  ['ease', [0.25, 0.1, 0.25, 1]],
  ['ease-in', [0.42, 0, 1, 1]],
  ['ease-out', [0, 0, 0.58, 1]],
  ['ease-in-out', [0.42, 0, 0.58, 1]],
  ['ease-in-out-cubic', [0.65, 0, 0.35, 1]],
  ['ease-out-back', [0.34, 1.56, 0.64, 1]],
];

const MERGE_GAP_MS = 80;       // 活跃段合并间隙
const GROUP_OVERLAP = 0.6;     // 多通道并段的时间重叠比
const MIN_SEG_MS = 40;         // 短于此的段视为噪声
const AUTOCORR_THRESHOLD = 0.92;
const AUTOCORR_MIN_LAG_MS = 100;
const OVERSHOOT_TOLERANCE = 0.05;
const REFINE_STEP = 0.05;
const REFINE_WINDOW = 0.15;    // 粗选参数 ±0.15 邻域
const NAME_MATCH_TOL = 0.051;  // 细化参数落在知名曲线此容差内则报名字

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const clamp01 = (v: number) => clamp(v, 0, 1);
const round2 = (v: number) => Math.round(v * 100) / 100;

function sorted(pts: readonly Pt[]): Pt[] {
  return [...pts].sort((a, b) => a[0] - b[0]);
}

function rangeOf(pts: readonly Pt[]): number {
  let mn = Infinity;
  let mx = -Infinity;
  for (const p of pts) {
    if (p[1] < mn) mn = p[1];
    if (p[1] > mx) mx = p[1];
  }
  return mx - mn;
}

/** t 时刻的线性插值（端点外 clamp） */
function valueAt(pts: readonly Pt[], t: number): number {
  const n = pts.length;
  if (n === 0 || t <= pts[0][0]) return n ? pts[0][1] : 0;
  if (t >= pts[n - 1][0]) return pts[n - 1][1];
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (pts[mid][0] <= t) lo = mid;
    else hi = mid;
  }
  const [t0, v0] = pts[lo];
  const [t1, v1] = pts[hi];
  return t1 > t0 ? v0 + ((v1 - v0) * (t - t0)) / (t1 - t0) : v0;
}

/** 中心差分速度（值/ms）；端点退化为前/后向差分 */
function velocities(pts: readonly Pt[]): number[] {
  const n = pts.length;
  const v = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(n - 1, i + 1)];
    const dt = b[0] - a[0];
    v[i] = dt > 0 ? (b[1] - a[1]) / dt : 0;
  }
  return v;
}

interface Interval {
  start: number;
  end: number;
  channel: string;
}

interface Group {
  start: number;
  end: number;
  items: Interval[];
}

/** 单通道活跃段：|v| > 量程 1%/100ms 的连续区间，边界外扩一个采样点，合并 80ms 内相邻段 */
function channelActiveIntervals(channel: string, rawPts: readonly Pt[]): Interval[] {
  const pts = sorted(rawPts);
  const n = pts.length;
  if (n < 3) return [];
  const range = rangeOf(pts);
  if (!(range > 0)) return [];
  const vThresh = (range * 0.01) / 100;
  const vs = velocities(pts);

  // 双阈值迟滞：|v| 超 vThresh 触发，回落到 vThresh/4 以下才结束，
  // 避免 ease-out 类末段缓速尾被提前截断
  const runs: Array<[number, number]> = [];
  let i = 0;
  while (i < n) {
    if (Math.abs(vs[i]) > vThresh) {
      let j = i;
      while (j + 1 < n && Math.abs(vs[j + 1]) > vThresh / 4) j++;
      runs.push([i, j]);
      i = j + 1;
    } else {
      i++;
    }
  }
  if (!runs.length) return [];

  const raw = runs.map(([a, b]) => ({
    // 外扩到相邻静止样本，覆盖阈值穿越延迟
    start: pts[Math.max(0, a - 1)][0],
    end: pts[Math.min(n - 1, b + 1)][0],
    channel,
  }));

  const merged: Interval[] = [];
  for (const iv of raw) {
    const last = merged[merged.length - 1];
    if (last && iv.start - last.end < MERGE_GAP_MS) {
      last.end = Math.max(last.end, iv.end);
    } else {
      merged.push({ ...iv });
    }
  }
  return merged;
}

/** 多通道活跃段并组：与当前组时间重叠 ≥60%（占较短者比例）即同组 */
function groupIntervals(intervals: Interval[]): Group[] {
  const sortedIv = [...intervals].sort((a, b) => a.start - b.start);
  const groups: Group[] = [];
  for (const iv of sortedIv) {
    const g = groups[groups.length - 1];
    if (g) {
      const overlap = Math.max(0, Math.min(iv.end, g.end) - Math.max(iv.start, g.start));
      const shorter = Math.min(iv.end - iv.start, g.end - g.start);
      if (shorter > 0 && overlap / shorter >= GROUP_OVERLAP) {
        g.items.push(iv);
        g.start = Math.min(g.start, iv.start);
        g.end = Math.max(g.end, iv.end);
        continue;
      }
    }
    groups.push({ start: iv.start, end: iv.end, items: [iv] });
  }
  return groups;
}

function resampleUniform(pts: readonly Pt[], count: number): number[] {
  const t0 = pts[0][0];
  const t1 = pts[pts.length - 1][0];
  const out = new Array<number>(count);
  for (let i = 0; i < count; i++) {
    out[i] = valueAt(pts, t0 + ((t1 - t0) * i) / (count - 1));
  }
  return out;
}

/**
 * 自相关循环检测：lag 范围 100ms ~ min(实测时长, durationMs)/2。
 * 逐 lag 用重叠窗口的 Pearson 相关（避免长 lag 因项数少被系统性压低）。
 * 取首个超过阈值后的局部峰值，返回周期 ms；非循环返回 null。
 */
function detectPeriod(rawPts: readonly Pt[], durationMs: number): number | null {
  const pts = sorted(rawPts);
  const n = pts.length;
  if (n < 12) return null;
  const dur = pts[n - 1][0] - pts[0][0];
  if (dur < 2 * AUTOCORR_MIN_LAG_MS + 50) return null;

  const xs = resampleUniform(pts, n);
  const dt = dur / (n - 1);
  let mean = 0;
  for (const x of xs) mean += x;
  mean /= n;
  const xc = xs.map((x) => x - mean);

  const lagMin = Math.max(2, Math.round(AUTOCORR_MIN_LAG_MS / dt));
  const lagMax = Math.min(n - 2, Math.floor(Math.min(dur, durationMs) / 2 / dt));
  if (lagMax <= lagMin) return null;

  const r = new Array<number>(lagMax + 1).fill(0);
  for (let lag = lagMin; lag <= lagMax; lag++) {
    let sxy = 0;
    let sxx = 0;
    let syy = 0;
    for (let i = 0; i + lag < n; i++) {
      const a = xc[i];
      const b = xc[i + lag];
      sxy += a * b;
      sxx += a * a;
      syy += b * b;
    }
    // 常数窗口（sxx/syy≈0）相关无定义，置 0 防止平台期误判为循环
    const floor = 1e-12 * (n - lag);
    r[lag] = sxx > floor && syy > floor ? sxy / Math.sqrt(sxx * syy) : 0;
  }

  // 首个「先深跌（<0.5）再升破阈值」的局部峰。
  // 深跌前置条件排除平滑单调信号（斜坡/单次缓动在短 lag 上自相关天然偏高，但从不深跌后回升）。
  let dipSeen = false;
  for (let lag = lagMin; lag < lagMax; lag++) {
    if (r[lag] < 0.5) dipSeen = true;
    if (dipSeen && r[lag] > AUTOCORR_THRESHOLD) {
      let best = lag;
      while (best + 1 <= lagMax && r[best + 1] >= r[best]) best++;
      return best * dt;
    }
  }
  return null;
}

/** cubic-bezier(x1,y1,x2,y2) 在归一化时间 x 处的 y（x(t) 单调，二分求解） */
function bezierY(x1: number, y1: number, x2: number, y2: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  let lo = 0;
  let hi = 1;
  let t = x;
  for (let i = 0; i < 32; i++) {
    t = (lo + hi) / 2;
    const xt = ((ax * t + bx) * t + cx) * t;
    if (xt < x) lo = t;
    else hi = t;
  }
  return ((ay * t + by) * t + cy) * t;
}

interface EasingFit {
  easing: string;
  error: number;
}

/**
 * 段内 easing 拟合。window 为 [t, v] 采样（已按段窗口截取；往返段已被调用方截到去程）。
 * 超调 >5% → 'spring/overshoot'，error 取超调幅值；否则粗选 + 0.05 步长邻域细化。
 */
function fitEasing(window: readonly Pt[]): EasingFit {
  const n = window.length;
  if (n < 4) return { easing: 'linear', error: 0 };
  const t0 = window[0][0];
  const t1 = window[n - 1][0];
  const from = window[0][1];
  const to = window[n - 1][1];
  const span = to - from;
  const dur = t1 - t0;
  if (!(dur > 0) || Math.abs(span) < 1e-9) return { easing: 'linear', error: 0 };

  const xs = new Array<number>(n);
  const ys = new Array<number>(n);
  let mn = Infinity;
  let mx = -Infinity;
  for (let i = 0; i < n; i++) {
    xs[i] = (window[i][0] - t0) / dur;
    ys[i] = (window[i][1] - from) / span;
    if (ys[i] < mn) mn = ys[i];
    if (ys[i] > mx) mx = ys[i];
  }

  if (mn < -OVERSHOOT_TOLERANCE || mx > 1 + OVERSHOOT_TOLERANCE) {
    return { easing: 'spring/overshoot', error: clamp01(Math.max(mx - 1, -mn, 0)) };
  }

  const rmse = (p: readonly [number, number, number, number]): number => {
    let s = 0;
    for (let i = 0; i < n; i++) {
      const d = bezierY(p[0], p[1], p[2], p[3], xs[i]) - ys[i];
      s += d * d;
    }
    return Math.sqrt(s / n);
  };

  // 粗选：知名曲线集
  let bestName = '';
  let bestP: [number, number, number, number] = [0, 0, 1, 1];
  let bestErr = Infinity;
  for (const [name, p] of KNOWN) {
    const e = rmse(p);
    if (e < bestErr - 1e-12) {
      bestErr = e;
      bestP = [p[0], p[1], p[2], p[3]];
      bestName = name;
    }
  }

  // 细化：粗选参数 ±0.15 邻域，0.05 步长（x∈[0,1]，y 允许超调空间）
  const steps: number[] = [];
  for (let d = -REFINE_WINDOW; d <= REFINE_WINDOW + 1e-9; d += REFINE_STEP) steps.push(round2(d));
  for (const dx1 of steps) {
    for (const dy1 of steps) {
      for (const dx2 of steps) {
        for (const dy2 of steps) {
          const p: [number, number, number, number] = [
            clamp(round2(bestP[0] + dx1), 0, 1),
            clamp(round2(bestP[1] + dy1), -1, 2),
            clamp(round2(bestP[2] + dx2), 0, 1),
            clamp(round2(bestP[3] + dy2), -1, 2),
          ];
          const e = rmse(p);
          if (e < bestErr - 1e-9) {
            bestErr = e;
            bestP = p;
            bestName = '';
          }
        }
      }
    }
  }

  // 细化结果若仍贴近某知名曲线，报曲线名而非参数
  if (!bestName) {
    for (const [name, p] of KNOWN) {
      if (
        Math.abs(p[0] - bestP[0]) <= NAME_MATCH_TOL &&
        Math.abs(p[1] - bestP[1]) <= NAME_MATCH_TOL &&
        Math.abs(p[2] - bestP[2]) <= NAME_MATCH_TOL &&
        Math.abs(p[3] - bestP[3]) <= NAME_MATCH_TOL
      ) {
        bestName = name;
        break;
      }
    }
  }

  const easing =
    bestName || `cubic-bezier(${bestP.map((v) => v.toFixed(2)).join(', ')})`;
  return { easing, error: clamp01(bestErr) };
}

/**
 * 将采样曲线拟合为动画片段序列。纯函数，无 DOM 依赖。
 */
export function fitSegments(curve: SampleCurve): FittedSegment[] {
  const entries = Object.entries(curve.channels)
    .map(([name, pts]) => [name, sorted(pts)] as const)
    .filter(([, pts]) => pts.length >= 3 && rangeOf(pts) > 0);
  if (!entries.length) return [];

  const intervals: Interval[] = [];
  for (const [name, pts] of entries) intervals.push(...channelActiveIntervals(name, pts));
  if (!intervals.length) return [];
  const groups = groupIntervals(intervals);
  if (!groups.length) return [];

  // 循环检测：全程幅值最大的通道
  let dominantEntry = entries[0];
  for (const e of entries) {
    if (rangeOf(e[1]) > rangeOf(dominantEntry[1])) dominantEntry = e;
  }
  const period = detectPeriod(dominantEntry[1], curve.durationMs);

  const byName = new Map(entries);
  const periodStart = groups[0].start;
  const segments: FittedSegment[] = [];

  for (const g of groups) {
    // 循环动画只拟合第一个周期
    if (period != null && g.start >= periodStart + period) continue;
    const start = g.start;
    let end = period != null ? Math.min(g.end, periodStart + period) : g.end;
    if (end - start < MIN_SEG_MS) continue;

    const memberNames = [...new Set(g.items.map((iv) => iv.channel))];
    const channels: Record<string, { from: number; to: number }> = {};
    let domName = memberNames[0];
    let domSpan = -1;
    for (const name of memberNames) {
      const pts = byName.get(name);
      if (!pts) continue;
      const from = valueAt(pts, start);
      const to = valueAt(pts, end);
      channels[name] = { from: round2(from), to: round2(to) };
      const span = Math.abs(to - from);
      if (span > domSpan) {
        domSpan = span;
        domName = name;
      }
    }

    const domPts = byName.get(domName);
    if (!domPts) continue;
    let window = domPts.filter((p) => p[0] >= start - 1e-9 && p[0] <= end + 1e-9);

    // 往返段（回到起点附近）：截到首次极值，只拟合去程，easing/from-to 才有意义
    if (window.length >= 4) {
      const wRange = rangeOf(window);
      const wFrom = window[0][1];
      const wTo = window[window.length - 1][1];
      if (wRange > 0 && Math.abs(wTo - wFrom) < 0.2 * wRange) {
        let extIdx = 0;
        let extDev = -1;
        for (let i = 0; i < window.length; i++) {
          const dev = Math.abs(window[i][1] - wFrom);
          if (dev > extDev) {
            extDev = dev;
            extIdx = i;
          }
        }
        if (extIdx >= 3 && window[extIdx][0] > start) {
          window = window.slice(0, extIdx + 1);
          end = window[window.length - 1][0];
          channels[domName] = {
            from: round2(wFrom),
            to: round2(window[window.length - 1][1]),
          };
        }
      }
    }

    const { easing, error } = fitEasing(window);
    const seg: FittedSegment = {
      startMs: round2(start),
      endMs: round2(end),
      channels,
      easing,
      error,
    };
    if (period != null) seg.periodMs = round2(period);
    segments.push(seg);
  }

  return segments;
}
