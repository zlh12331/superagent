import { createContext, type ReactElement, type ReactNode, useContext, useEffect } from 'react';

import type { Theme } from '@/stores/persistent/settings-store';
import { useSettingsStore } from '@/stores/persistent/settings-store';

/**
 * 主题 Context 值
 *
 * 与 next-themes 的 useTheme 接口对齐，便于迁移：
 * - theme：用户选择的主题（可能是 'system'）
 * - resolvedTheme：实际生效的主题（'system' 已解析为 'light' 或 'dark'）
 * - setTheme：切换主题（直接调 settings-store.setTheme）
 */
interface ThemeContextValue {
  /** 用户选择的主题（可能是 'system'） */
  theme: Theme;
  /** 实际生效的主题（'system' 已解析为 'light' 或 'dark'） */
  resolvedTheme: 'light' | 'dark';
  /** 切换主题（写入 settings-store，由 settings-store 负责持久化） */
  setTheme: (theme: Theme) => void;
}

/**
 * 主题 Context
 *
 * 默认值为 undefined，useTheme 中检测未在 Provider 内使用时抛错。
 */
const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

/**
 * 获取系统偏好主题
 *
 * 在 SSR 或非浏览器环境返回 'light'（Electron 渲染层始终有 window，但稳妥起见做判空）
 */
function getSystemTheme(): 'light' | 'dark' {
  if (typeof window === 'undefined') {
    return 'light';
  }
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/**
 * 把主题应用到 <html> 元素
 *
 * 通过添加/移除 .dark class 切换，与 Tailwind v4 的 dark: 变量对齐。
 */
function applyTheme(resolved: 'light' | 'dark'): void {
  const root = document.documentElement;
  if (resolved === 'dark') {
    root.classList.add('dark');
  } else {
    root.classList.remove('dark');
  }
}

/**
 * 主题 Provider
 *
 * 必须放在应用最外层，确保所有子组件能读取到主题状态。
 *
 * @example
 * <ThemeProvider>
 *   <App />
 * </ThemeProvider>
 */
export function ThemeProvider({ children }: { children: ReactNode }): ReactElement {
  const theme = useSettingsStore((s) => s.theme);
  const setTheme = useSettingsStore((s) => s.setTheme);

  const resolvedTheme: 'light' | 'dark' = theme === 'system' ? getSystemTheme() : theme;

  useEffect(() => {
    applyTheme(resolvedTheme);
  }, [resolvedTheme]);

  useEffect(() => {
    if (theme !== 'system') {
      return;
    }
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handleChange = () => {
      const resolved = mediaQuery.matches ? 'dark' : 'light';
      applyTheme(resolved);
    };
    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, [theme]);

  const value: ThemeContextValue = { theme, resolvedTheme, setTheme };

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

/**
 * 读取主题状态
 *
 * 必须在 ThemeProvider 内使用，否则抛错。
 *
 * @example
 * const { resolvedTheme, setTheme } = useTheme();
 * setTheme(resolvedTheme === 'dark' ? 'light' : 'dark');
 */
export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (ctx === undefined) {
    throw new Error('useTheme 必须在 ThemeProvider 内使用');
  }
  return ctx;
}
