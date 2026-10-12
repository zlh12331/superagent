import { act, render, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSettingsStore } from '@/stores/persistent/settings-store';
import { ThemeProvider, useTheme } from './ThemeProvider';

describe('ThemeProvider 批次7 缺口补全', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.classList.remove('dark');
    useSettingsStore.setState({ theme: 'dark' });
  });

  it('theme=dark：html 应用 .dark class，useTheme 返回 dark', () => {
    render(
      <ThemeProvider>
        <div>内容</div>
      </ThemeProvider>,
    );
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    const { result } = renderHook(() => useTheme(), {
      wrapper: ({ children }) => <ThemeProvider>{children}</ThemeProvider>,
    });
    expect(result.current.theme).toBe('dark');
    expect(result.current.resolvedTheme).toBe('dark');
  });

  it('theme=light：html 无 .dark class', () => {
    useSettingsStore.setState({ theme: 'light' });
    render(
      <ThemeProvider>
        <div>内容</div>
      </ThemeProvider>,
    );
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('theme=system + matchMedia dark：resolved 为 dark', () => {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockReturnValue({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }),
    });
    useSettingsStore.setState({ theme: 'system' });
    const { result } = renderHook(() => useTheme(), {
      wrapper: ({ children }) => <ThemeProvider>{children}</ThemeProvider>,
    });
    expect(result.current.resolvedTheme).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('theme=system + matchMedia light：resolved 为 light', () => {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockReturnValue({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }),
    });
    useSettingsStore.setState({ theme: 'system' });
    const { result } = renderHook(() => useTheme(), {
      wrapper: ({ children }) => <ThemeProvider>{children}</ThemeProvider>,
    });
    expect(result.current.resolvedTheme).toBe('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('setTheme：更新 settings-store + html class 跟随', () => {
    const { result } = renderHook(() => useTheme(), {
      wrapper: ({ children }) => <ThemeProvider>{children}</ThemeProvider>,
    });
    expect(result.current.resolvedTheme).toBe('dark');
    act(() => result.current.setTheme('light'));
    expect(useSettingsStore.getState().theme).toBe('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('matchMedia change：system 模式下监听并应用新主题', () => {
    let changeHandler: (() => void) | undefined;
    const addEventListener = vi.fn((_type: string, cb: () => void) => {
      changeHandler = cb;
    });
    const removeEventListener = vi.fn();
    let matches = true;
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockReturnValue({
        get matches() {
          return matches;
        },
        addEventListener,
        removeEventListener,
      }),
    });
    useSettingsStore.setState({ theme: 'system' });
    render(
      <ThemeProvider>
        <div>内容</div>
      </ThemeProvider>,
    );
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(addEventListener).toHaveBeenCalled();
    matches = false;
    act(() => {
      changeHandler?.();
    });
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('useTheme 在 Provider 外：抛错', () => {
    expect(() => renderHook(() => useTheme())).toThrow('ThemeProvider');
  });

  it('非 system 主题：不注册 matchMedia 监听', () => {
    const addEventListener = vi.fn();
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockReturnValue({
        matches: false,
        addEventListener,
        removeEventListener: vi.fn(),
      }),
    });
    render(
      <ThemeProvider>
        <div>内容</div>
      </ThemeProvider>,
    );
    expect(addEventListener).not.toHaveBeenCalled();
  });
});
