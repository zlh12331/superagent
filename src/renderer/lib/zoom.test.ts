// src/renderer/lib/zoom.test.ts
// applyZoom 薄壳测试（35 号 §2.7：无桥 no-op / 归一 / 错误吞掉）
// ──────────────────────────────────────────────────────────────

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { applyZoom } from './zoom';

const applySpy = vi.fn(async () => ({ data: { ok: true } }));

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(window, 'api', {
    value: { window: { applyZoom: applySpy } },
    writable: true,
    configurable: true,
  });
});

describe('applyZoom（渲染层唯一应用出口）', () => {
  it('V2/V3：合法档位经 window:applyZoom 交给主进程', async () => {
    await applyZoom(1.25);
    expect(applySpy).toHaveBeenCalledWith({ zoom: 1.25 });
  });

  it('第二道防线：非档位值归一后应用（0.93 → 0.9）', async () => {
    await applyZoom(0.93);
    expect(applySpy).toHaveBeenCalledWith({ zoom: 0.9 });
  });

  it('反例 3：无桥 no-op 不抛（浏览器模式/单测）', async () => {
    Object.defineProperty(window, 'api', { value: undefined, writable: true, configurable: true });
    await expect(applyZoom(1.5)).resolves.toBeUndefined();
    expect(applySpy).not.toHaveBeenCalled();
  });

  it('应用失败静默（窗口销毁竞态等，非致命）', async () => {
    applySpy.mockRejectedValueOnce(new Error('window destroyed'));
    await expect(applyZoom(1.5)).resolves.toBeUndefined();
  });
});
