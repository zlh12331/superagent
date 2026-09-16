// src/renderer/components/browser/__tests__/browser-device-bar.test.tsx
// DeviceBar 单测（正向 / 边界 / 异常）
// ──────────────────────────────────────────────────────────────
// 重点守护一个真实缺陷：`Number('')` 为 0 而非 NaN，此前守卫只判 NaN，
// 导致「清空宽高输入框」把值置 0 → 视口矩形宽高非正 → 违反
// BrowserRectSchema.positive() → IPC 校验失败且被静默吞掉（视口同步无声失效）。
//
// 另外锁住档位来自共享真源（lib/browser/presets）：预设顺序/文案与
// 缩放档位一旦与设置页分叉，在此失败。
// ──────────────────────────────────────────────────────────────

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { DeviceBar, type DeviceBarProps } from '../browser-device-bar';

/** 渲染受控组件并捕获全部回调（返回类型由 vi.fn() 推断） */
function setup(overrides?: Partial<DeviceBarProps>) {
  const handlers = {
    onPresetChange: vi.fn(),
    onWidthChange: vi.fn(),
    onHeightChange: vi.fn(),
    onZoomChange: vi.fn(),
    onClose: vi.fn(),
  };
  render(
    <DeviceBar
      devicePreset="mobile"
      deviceWidth={375}
      deviceHeight={667}
      deviceZoom={100}
      {...handlers}
      {...overrides}
    />,
  );
  return handlers;
}

function presetSelect(): HTMLSelectElement {
  return screen.getByLabelText('设备预设') as HTMLSelectElement;
}

describe('DeviceBar', () => {
  it('预设下拉：档位与顺序来自共享真源（含「笔记本电脑」）', () => {
    setup();
    expect(presetSelect().value).toBe('mobile');
    expect(Array.from(presetSelect().options).map((option) => option.textContent)).toEqual([
      '自适应',
      '桌面',
      '笔记本电脑',
      '平板',
      '手机',
    ]);
  });

  it('缩放下拉：档位来自共享真源', () => {
    setup();
    const zoomSelect = screen.getByLabelText('缩放') as HTMLSelectElement;
    expect(zoomSelect.value).toBe('100');
    expect(Array.from(zoomSelect.options).map((option) => option.textContent)).toEqual([
      '50%',
      '75%',
      '100%',
      '125%',
      '150%',
      '200%',
    ]);
  });

  it('切换预设 → onPresetChange(预设值)', () => {
    const handlers = setup();
    fireEvent.change(presetSelect(), { target: { value: 'tablet' } });
    expect(handlers.onPresetChange).toHaveBeenCalledWith('tablet');
  });

  it('切换缩放 → onZoomChange(数值档位)', () => {
    const handlers = setup();
    fireEvent.change(screen.getByLabelText('缩放'), { target: { value: '75' } });
    expect(handlers.onZoomChange).toHaveBeenCalledWith(75);
  });

  it('宽度输入合法值 → onWidthChange(数值)', () => {
    const handlers = setup();
    fireEvent.change(screen.getByLabelText('宽度'), { target: { value: '1200' } });
    expect(handlers.onWidthChange).toHaveBeenCalledWith(1200);
  });

  it('高度输入合法值 → onHeightChange(数值)', () => {
    const handlers = setup();
    fireEvent.change(screen.getByLabelText('高度'), { target: { value: '900' } });
    expect(handlers.onHeightChange).toHaveBeenCalledWith(900);
  });

  it('宽度输入被清空 → 不回调（防置 0 使视口矩形非法）', () => {
    const handlers = setup();
    fireEvent.change(screen.getByLabelText('宽度'), { target: { value: '' } });
    expect(handlers.onWidthChange).not.toHaveBeenCalled();
  });

  it('高度输入被清空 → 不回调', () => {
    const handlers = setup();
    fireEvent.change(screen.getByLabelText('高度'), { target: { value: '' } });
    expect(handlers.onHeightChange).not.toHaveBeenCalled();
  });

  it('宽度输入为 0 / 负数 → 不回调', () => {
    const handlers = setup();
    const input = screen.getByLabelText('宽度');
    fireEvent.change(input, { target: { value: '0' } });
    fireEvent.change(input, { target: { value: '-120' } });
    expect(handlers.onWidthChange).not.toHaveBeenCalled();
  });

  it('responsive 预设：宽高输入禁用（尺寸跟随宿主区域）', () => {
    setup({ devicePreset: 'responsive' });
    expect(screen.getByLabelText('宽度')).toBeDisabled();
    expect(screen.getByLabelText('高度')).toBeDisabled();
  });

  it('非 responsive 预设：宽高输入可编辑', () => {
    setup();
    expect(screen.getByLabelText('宽度')).toBeEnabled();
    expect(screen.getByLabelText('高度')).toBeEnabled();
  });

  it('关闭按钮 → onClose', () => {
    const handlers = setup();
    fireEvent.click(screen.getByLabelText('关闭设备工具栏'));
    expect(handlers.onClose).toHaveBeenCalledTimes(1);
  });
});
