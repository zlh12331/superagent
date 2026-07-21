// src/renderer/providers/ThemeProvider.tsx
// 主题 Provider（L2 settings-store 的副作用消费方）
// ──────────────────────────────────────────────────────────────
// 职责（P2 改造后）：
// - 仅负责「把 settings-store 的 theme 字段应用到 <html>」副作用
// - 不再持有状态、不再手写 localStorage（状态源已迁到 settings-store）
// - 监听系统主题变化（matchMedia prefers-color-scheme），动态解析 'system'
// - 通过 Context 暴露 useTheme() hook（接口与 next-themes 兼容，便于迁移）
//
// 嵌套关系：
// - 必须在 QueryProvider 内（QueryProvider 不依赖 theme）
// - 必须在 TooltipProvider 外（Tooltip 颜色跟随 theme）
//
// 与改造前的差异：
// - 之前：useState 持有 theme + localStorage 持久化 + useEffect 应用副作用
// - 现在：直接订阅 settings-store.theme + useEffect 应用副作用 + 监听系统偏好变化
// - 状态源单一化：所有主题设置变更都走 settings-store.setTheme()
// ──────────────────────────────────────────────────────────────

import {
  createContext,
  type ReactElement,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
} from 'react';

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
  // 主题状态源：settings-store（持久化由 settings-store 负责）
  const theme = useSettingsStore((s) => s.theme);
  const setTheme = useSettingsStore((s) => s.setTheme);

  // resolvedTheme：'system' 解析为 'light' 或 'dark'
  const resolvedTheme: 'light' | 'dark' = theme === 'system' ? getSystemTheme() : theme;

  // 应用主题到 <html>（theme 变化或系统偏好变化时重新应用）
  useEffect(() => {
    applyTheme(resolvedTheme);
  }, [resolvedTheme]);

  // 监听系统主题变化（仅当 theme === 'system' 时生效）
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

  // setTheme：直接调用 settings-store 的 setTheme（持久化由 store 负责）
  // 用 useCallback 稳定引用，避免 Context value 每次渲染变化
  const stableSetTheme = useCallback((next: Theme) => setTheme(next), [setTheme]);

  // 用 useMemo 稳定 context 值，避免不必要的重渲染
  const value = useMemo<ThemeContextValue>(
    () => ({ theme, resolvedTheme, setTheme: stableSetTheme }),
    [theme, resolvedTheme, stableSetTheme],
  );

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
