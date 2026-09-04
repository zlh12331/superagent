/**
 * sample.ts — 采样回放引擎的前半段：对 getAnimations 隐身的动画（GSAP / rAF 内联样式）
 * 用 60fps computed style 采样还原标量通道曲线，交给 fit.ts 做数学拟合。
 *
 * - rAF 循环采样（默认 3000ms），每帧分解 getComputedStyle：
 *   transform → DOMMatrix 分解（translateX/Y px、scaleX/Y、rotateZ deg）；
 *   opacity、borderRadius(px)、filter 的 blur/brightness、width/height。
 * - 通道按全程波动阈值收录（translate>0.5px、scale>0.005、rotate>0.5deg、opacity>0.01，
 *   width/height 仅在变化 >0.5px 时收录）。
 * - 采样前 dispatch mouseenter/mouseover/focus 尝试激活动效，结束 dispatch mouseleave。
 * - document.hidden 时暂停计时（rAF 通常也会停发，双保险）；带兜底超时保证 Promise 必 resolve。
 * - options.deep：同时采样 el 的前 6 个后代（通道名 'child{i}.' 前缀），默认关闭。
 */
import type { SampleCurve } from './types';

export interface SampleOptions {
  /** 同时采样 el 的前 6 个后代（通道名加 'child{i}.' 前缀），默认 false */
  deep?: boolean;
}

/** 每帧提取的标量通道名（deep 模式下后代加前缀） */
const CHANNEL_KEYS = [
  'translateX',
  'translateY',
  'scaleX',
  'scaleY',
  'rotateZ',
  'opacity',
  'borderRadius',
  'blur',
  'brightness',
  'width',
  'height',
] as const;

type ChannelKey = (typeof CHANNEL_KEYS)[number];
type ChannelValues = Record<ChannelKey, number>;

const IDENTITY_TRANSFORM = {
  translateX: 0,
  translateY: 0,
  scaleX: 1,
  scaleY: 1,
  rotateZ: 0,
};

type TransformValues = typeof IDENTITY_TRANSFORM;

/**
 * 分解 computed transform。
 * 2D matrix(a,b,c,d,e,f)：scaleX=hypot(a,b)·sign(det)，rotate=atan2(b,a)，
 * scaleY=hypot(c,d)·sign(det)，translate=e/f。
 * 3D matrix3d：取近似——translate=m41/m42，scale/rotate 用 m11/m12/m21/m22 的 2D 近似。
 */
function parseTransform(transform: string): TransformValues {
  if (!transform || transform === 'none') return { ...IDENTITY_TRANSFORM };

  const m3 = /^matrix3d\(([^)]+)\)$/.exec(transform);
  if (m3) {
    const v = m3[1].split(',').map(Number);
    if (v.length === 16 && v.every(Number.isFinite)) {
      // CSS matrix3d 为列优先：v[0]=m11, v[1]=m12, v[4]=m21, v[5]=m22, v[12]=m41, v[13]=m42
      const det = v[0] * v[5] - v[1] * v[4];
      const s = det < 0 ? -1 : 1;
      return {
        translateX: v[12],
        translateY: v[13],
        scaleX: Math.hypot(v[0], v[1]) * s,
        scaleY: Math.hypot(v[4], v[5]) * s,
        rotateZ: (Math.atan2(v[1], v[0]) * 180) / Math.PI,
      };
    }
    return { ...IDENTITY_TRANSFORM };
  }

  const m2 = /^matrix\(([^)]+)\)$/.exec(transform);
  if (m2) {
    const v = m2[1].split(',').map(Number);
    if (v.length === 6 && v.every(Number.isFinite)) {
      const det = v[0] * v[3] - v[1] * v[2];
      const s = det < 0 ? -1 : 1;
      return {
        translateX: v[4],
        translateY: v[5],
        scaleX: Math.hypot(v[0], v[1]) * s,
        scaleY: Math.hypot(v[2], v[3]) * s,
        rotateZ: (Math.atan2(v[1], v[0]) * 180) / Math.PI,
      };
    }
  }
  return { ...IDENTITY_TRANSFORM };
}

function parsePx(value: string, percentBase?: number): number {
  const v = value.trim().split(' ')[0] || '0';
  if (v.endsWith('%') && percentBase != null) return (parseFloat(v) / 100) * percentBase;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

/** 单帧：读取一个元素的全部分解通道 */
function readChannels(el: Element): ChannelValues {
  const cs = getComputedStyle(el);
  const width = parsePx(cs.width);
  const height = parsePx(cs.height);
  const filter = cs.filter || 'none';
  const blurM = /blur\(\s*([\d.]+)px\s*\)/.exec(filter);
  const briM = /brightness\(\s*([\d.]+)\s*\)/.exec(filter);
  const opacity = parseFloat(cs.opacity);
  return {
    ...parseTransform(cs.transform),
    opacity: Number.isFinite(opacity) ? opacity : 1,
    borderRadius: parsePx(cs.borderRadius || '0', width),
    blur: blurM ? Number(blurM[1]) : 0,
    brightness: briM ? Number(briM[1]) : 1,
    width,
    height,
  };
}

/** 人口标准差（忽略 NaN）；有效样本不足返回 0 */
function std(values: readonly number[]): number {
  let n = 0;
  let mean = 0;
  for (const v of values) {
    if (Number.isFinite(v)) {
      n++;
      mean += v;
    }
  }
  if (n < 2) return 0;
  mean /= n;
  let s = 0;
  for (const v of values) {
    if (Number.isFinite(v)) s += (v - mean) * (v - mean);
  }
  return Math.sqrt(s / n);
}

function range(values: readonly number[]): number {
  let mn = Infinity;
  let mx = -Infinity;
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    if (v < mn) mn = v;
    if (v > mx) mx = v;
  }
  return mx === -Infinity ? 0 : mx - mn;
}

/** 通道收录阈值：全程 std（width/height 用极差，>0.5px 才收，避免噪声通道） */
function keepChannel(key: ChannelKey, values: readonly number[]): boolean {
  switch (key) {
    case 'translateX':
    case 'translateY':
      return std(values) > 0.5;
    case 'scaleX':
    case 'scaleY':
      return std(values) > 0.005;
    case 'rotateZ':
      return std(values) > 0.5;
    case 'opacity':
      return std(values) > 0.01;
    case 'borderRadius':
      return std(values) > 0.5;
    case 'blur':
      return std(values) > 0.1;
    case 'brightness':
      return std(values) > 0.01;
    case 'width':
    case 'height':
      return range(values) > 0.5;
  }
}

/** NaN 前向填充（帧读取失败时保持对齐）；全 NaN 返回 null */
function fillNaN(values: readonly number[]): number[] | null {
  const out = new Array<number>(values.length);
  let last = NaN;
  let firstValid = NaN;
  for (const v of values) {
    if (Number.isFinite(v)) {
      firstValid = v;
      break;
    }
  }
  if (!Number.isFinite(firstValid)) return null;
  last = firstValid;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (Number.isFinite(v)) {
      last = v;
      out[i] = v;
    } else {
      out[i] = last;
    }
  }
  return out;
}

function dispatchActivation(el: Element, phase: 'enter' | 'leave'): void {
  try {
    if (phase === 'enter') {
      el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false, cancelable: true }));
      el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true }));
      el.dispatchEvent(new FocusEvent('focus', { bubbles: false, cancelable: true }));
    } else {
      el.dispatchEvent(new MouseEvent('mouseleave', { bubbles: false, cancelable: true }));
    }
  } catch {
    /* 某些环境（如 SVG 早期实现）构造事件失败，忽略 */
  }
}

/**
 * 对 el 做 durationMs（默认 3000ms）的 rAF computed-style 采样。
 * 页面隐藏时暂停计时；返回实测 fps 与过滤后的标量通道曲线。
 */
export async function sampleElement(
  el: Element,
  durationMs = 3000,
  options: SampleOptions = {},
): Promise<SampleCurve> {
  const targets: Array<{ el: Element; prefix: string }> = [{ el, prefix: '' }];
  if (options.deep) {
    Array.from(el.querySelectorAll('*'))
      .slice(0, 6)
      .forEach((kid, i) => targets.push({ el: kid, prefix: `child${i}.` }));
  }

  const times: number[] = [];
  const raw = new Map<string, number[]>();
  for (const { prefix } of targets) {
    for (const k of CHANNEL_KEYS) raw.set(prefix + k, []);
  }

  return new Promise<SampleCurve>((resolve) => {
    let finished = false;
    let frames = 0;
    let activeMs = 0;
    let last = -1;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = () => {
      if (finished) return;
      finished = true;
      if (timer !== undefined) clearTimeout(timer);
      dispatchActivation(el, 'leave');

      const channels: SampleCurve['channels'] = {};
      for (const [name, values] of raw) {
        const base = name.slice(name.indexOf('.') + 1) as ChannelKey;
        const filled = fillNaN(values);
        if (!filled || !keepChannel(base, filled)) continue;
        channels[name] = times.map((t, i) => [t, filled[i]]);
      }
      resolve({
        fps: activeMs > 0 ? Math.round((frames / (activeMs / 1000)) * 10) / 10 : 0,
        durationMs: Math.round(activeMs),
        channels,
      });
    };

    if (!(durationMs > 0) || typeof requestAnimationFrame !== 'function') {
      finish();
      return;
    }

    dispatchActivation(el, 'enter');
    // 兜底超时：rAF 长时间停发（非 hidden 场景异常）也保证 resolve
    timer = setTimeout(finish, durationMs * 3 + 2000);

    const tick = (now: number) => {
      if (finished) return;
      if (last < 0) {
        last = now;
      } else {
        const delta = now - last;
        last = now;
        const hidden = typeof document !== 'undefined' && document.hidden;
        if (!hidden) activeMs += Math.max(0, delta);
      }
      if (activeMs >= durationMs) {
        finish();
        return;
      }
      frames++;
      times.push(activeMs);
      for (const { el: target, prefix } of targets) {
        let vals: ChannelValues | null = null;
        try {
          vals = readChannels(target);
        } catch {
          vals = null; // 元素被移除等异常：整帧 NaN 占位，保持通道对齐
        }
        for (const k of CHANNEL_KEYS) {
          raw.get(prefix + k)?.push(vals ? vals[k] : NaN);
        }
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}
