// src/renderer/lib/__tests__/theme-init.test.ts
// theme-init 单测：FOUC 防护的初始主题应用
// 直接操作 jsdom 的 localStorage / document.documentElement.classList 验证。

import { beforeEach, describe, expect, it } from 'vitest';

import {
  applyInitialTheme,
  DEFAULT_THEME,
  readStoredTheme,
  resolveSystemTheme,
  SETTINGS_STORAGE_KEY,
} from '../theme-init';

/** 覆盖 matchMedia 模拟系统暗色偏好（resolveSystemTheme 只读 .matches） */
function mockSystemDark(dark: boolean): void {
  const mock = { matches: dark } as MediaQueryList;
  window.matchMedia = (() => mock) as typeof window.matchMedia;
}

/** 写入持久化主题（模拟 zustand persist 存储格式） */
function storeTheme(theme: 'light' | 'dark' | 'system'): void {
  window.localStorage.setItem(
    SETTINGS_STORAGE_KEY,
    JSON.stringify({ state: { theme }, version: 2 }),
  );
}

describe('readStoredTheme', () => {
  it('无存储时回退默认主题（dark，与 settings-store 默认一致）', () => {
    expect(readStoredTheme(window.localStorage)).toBe(DEFAULT_THEME);
  });

  it('读取持久化的 light', () => {
    storeTheme('light');
    expect(readStoredTheme(window.localStorage)).toBe('light');
  });

  it('损坏 JSON 回退默认主题', () => {
    window.localStorage.setItem(SETTINGS_STORAGE_KEY, '{broken json');
    expect(readStoredTheme(window.localStorage)).toBe(DEFAULT_THEME);
  });

  it('非法 theme 值回退默认主题', () => {
    window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ state: { theme: 'neon' } }));
    expect(readStoredTheme(window.localStorage)).toBe(DEFAULT_THEME);
  });
});

describe('resolveSystemTheme', () => {
  it('系统偏好暗色 → dark', () => {
    mockSystemDark(true);
    expect(resolveSystemTheme()).toBe('dark');
  });

  it('系统偏好亮色 → light', () => {
    mockSystemDark(false);
    expect(resolveSystemTheme()).toBe('light');
  });
});

describe('applyInitialTheme', () => {
  beforeEach(() => {
    // 重置 localStorage 与 .dark class，避免用例间污染
    window.localStorage.clear();
    document.documentElement.classList.remove('dark');
    mockSystemDark(false);
  });

  it('无存储 → 应用默认暗色', () => {
    applyInitialTheme();
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('持久化 light → 不添加 .dark', () => {
    storeTheme('light');
    applyInitialTheme();
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('持久化 dark → 添加 .dark', () => {
    storeTheme('dark');
    applyInitialTheme();
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('system + 系统偏好暗色 → 添加 .dark', () => {
    storeTheme('system');
    mockSystemDark(true);
    applyInitialTheme();
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('system + 系统偏好亮色 → 不添加 .dark', () => {
    storeTheme('system');
    applyInitialTheme();
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });
});
