// src/main/utils/window-state.test.ts
// 窗口状态记忆单测：可恢复性校验 / 加载回退 / 写入持久化

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  isBoundsVisible,
  loadWindowState,
  trackWindowState,
  type WindowState,
} from './window-state';

/** 单显示器 1920×1080 工作区（任务栏 40px） */
const WORK_AREAS = [{ x: 0, y: 0, width: 1920, height: 1040 }];

describe('isBoundsVisible', () => {
  it('中心点在工作区内 → 可见', () => {
    expect(isBoundsVisible({ x: 100, y: 100, width: 800, height: 600 }, WORK_AREAS)).toBe(true);
  });

  it('完全落在屏幕外（外接屏拔掉场景）→ 不可见', () => {
    // 外接屏右侧 -1500px 处的窗口，中心点也不在 1920 主屏内
    expect(isBoundsVisible({ x: -1500, y: 100, width: 800, height: 600 }, WORK_AREAS)).toBe(false);
  });

  it('中心点在工作区外但窗口部分可见 → 不可见（严格判定防恢复出屏）', () => {
    // 中心点越界（x=1900+）→ 视为不可见
    expect(isBoundsVisible({ x: 1600, y: 100, width: 800, height: 600 }, WORK_AREAS)).toBe(false);
  });

  it('多显示器：中心点落在任一工作区即可', () => {
    const areas = [
      { x: 0, y: 0, width: 1920, height: 1040 },
      { x: 1920, y: 0, width: 1920, height: 1040 },
    ];
    // 第二屏内（中心 x=2200）
    expect(isBoundsVisible({ x: 2000, y: 100, width: 400, height: 300 }, areas)).toBe(true);
  });
});

describe('loadWindowState', () => {
  it('文件缺失（首次启动）→ 回退默认值', () => {
    const state = loadWindowState(
      join(tmpdir(), 'no-such-window-state.json'),
      { width: 1280, height: 800 },
      WORK_AREAS,
    );
    expect(state).toEqual({ width: 1280, height: 800, isMaximized: false });
  });

  it('有效状态 → 原样恢复（含坐标与最大化）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wstate-'));
    const file = join(dir, 'state.json');
    writeFileSync(
      file,
      JSON.stringify({ x: 200, y: 100, width: 1440, height: 900, isMaximized: true }),
      'utf8',
    );
    const state = loadWindowState(file, { width: 1280, height: 800 }, WORK_AREAS);
    expect(state).toEqual({ x: 200, y: 100, width: 1440, height: 900, isMaximized: true });
    rmSync(dir, { recursive: true, force: true });
  });

  it('坐标不可见（屏幕变动）→ 丢弃坐标保留尺寸', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wstate-'));
    const file = join(dir, 'state.json');
    writeFileSync(
      file,
      JSON.stringify({ x: -2000, y: 100, width: 1440, height: 900, isMaximized: false }),
      'utf8',
    );
    const state = loadWindowState(file, { width: 1280, height: 800 }, WORK_AREAS);
    expect(state).toEqual({ width: 1440, height: 900, isMaximized: false });
    rmSync(dir, { recursive: true, force: true });
  });

  it('JSON 损坏 → 回退默认值', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wstate-'));
    const file = join(dir, 'state.json');
    writeFileSync(file, '{broken json', 'utf8');
    const state = loadWindowState(file, { width: 1280, height: 800 }, WORK_AREAS);
    expect(state).toEqual({ width: 1280, height: 800, isMaximized: false });
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('trackWindowState', () => {
  it('close 同步兜底：关窗时立即落盘最新状态', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wstate-'));
    const file = join(dir, 'state.json');

    // fake BrowserWindow（只实现 trackWindowState 用到的成员）
    const listeners = new Map<string, () => void>();
    const bounds = { x: 10, y: 20, width: 900, height: 700 };
    let maximized = false;
    const fakeWin = {
      on: (event: string, fn: () => void): void => {
        listeners.set(event, fn);
      },
      removeListener: (event: string): void => {
        listeners.delete(event);
      },
      isDestroyed: (): boolean => false,
      getBounds: (): { x: number; y: number; width: number; height: number } => bounds,
      isMaximized: (): boolean => maximized,
    } as unknown as Parameters<typeof trackWindowState>[0];

    const cleanup = trackWindowState(fakeWin, file);
    // 触发 close（用户关窗）
    listeners.get('close')?.();
    const state = JSON.parse(readFileSync(file, 'utf8')) as WindowState;
    expect(state).toEqual({ x: 10, y: 20, width: 900, height: 700, isMaximized: false });

    // 最大化变化即时保存
    maximized = true;
    listeners.get('maximize')?.();
    const state2 = JSON.parse(readFileSync(file, 'utf8')) as WindowState;
    expect(state2.isMaximized).toBe(true);

    cleanup();
    rmSync(dir, { recursive: true, force: true });
  });
});
