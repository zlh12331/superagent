// src/renderer/providers/ThemeProvider.tsx
// 主题 Provider（替代 next-themes）
// ──────────────────────────────────────────────────────────────
// 设计：
// - 用 React Context + useState 管理主题状态
// - localStorage 持久化用户选择
// - 默认跟随系统偏好（matchMedia prefers-color-scheme）
// - 通过给 <html> 添加/移除 .dark class 切换主题
//   与 globals.css 中的 :root / .dark 变量对齐
//
// 替代 next-themes 的理由：
// - next-themes 依赖 Next.js 生态，Electron 单机应用不需要
// - 减少一个运行时依赖
// - 实现简单，便于维护
//
// 接口与 next-themes 兼容（theme / resolvedTheme / setTheme），
// Topbar 和 sonner 的调用代码无需改动。
// ──────────────────────────────────────────────────────────────

import {
  createContext,
  type ReactElement,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';

/**
 * 主题类型
 *
 * - 'light'：亮色
 * - 'dark'：暗色
 * - 'system'：跟随系统偏好
 */
type Theme = 'light' | 'dark' | 'system';

/**
 * 主题 Context 值
 *
 * 与 next-themes 的 useTheme 接口对齐，便于迁移：
 * - theme：用户选择的主题（可能是 'system'）
 * - resolvedTheme：实际生效的主题（'system' 已解析为 'light' 或 'dark'）
 * - setTheme：切换主题
 */
interface ThemeContextValue {
  /** 用户选择的主题（可能是 'system'） */
  theme: Theme;
  /** 实际生效的主题（'system' 已解析为 'light' 或 'dark'） */
  resolvedTheme: 'light' | 'dark';
  /** 切换主题 */
  setTheme: (theme: Theme) => void;
}

/**
 * 主题 Context
 *
 * 默认值为 undefined，useTheme 中检测未在 Provider 内使用时抛错。
 */
const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

/** localStorage key */
const STORAGE_KEY = 'theme';

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
 * 从 localStorage 读取用户选择的主题
 *
 * 无记录或值非法时返回 'system'（默认跟随系统）
 */
function getStoredTheme(): Theme {
  if (typeof localStorage === 'undefined') {
    return 'system';
  }
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === 'light' || stored === 'dark' || stored === 'system') {
    return stored;
  }
  return 'system';
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
  const [theme, setThemeState] = useState<Theme>(() => getStoredTheme());
  // resolvedTheme 是 theme 解析后的实际值（'system' → 'light'/'dark'）
  // 初始值通过类型收窄确保为 'light' | 'dark'，不含 'system'
  const [resolvedTheme, setResolvedTheme] = useState<'light' | 'dark'>(() => {
    const stored = getStoredTheme();
    return stored === 'system' ? getSystemTheme() : stored;
  });

  // 应用主题到 <html> 并同步 resolvedTheme
  useEffect(() => {
    const resolved = theme === 'system' ? getSystemTheme() : theme;
    setResolvedTheme(resolved);
    applyTheme(resolved);
  }, [theme]);

  // 监听系统主题变化（仅当 theme === 'system' 时生效）
  useEffect(() => {
    if (theme !== 'system') {
      return;
    }
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handleChange = () => {
      const resolved = mediaQuery.matches ? 'dark' : 'light';
      setResolvedTheme(resolved);
      applyTheme(resolved);
    };
    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, [theme]);

  // setTheme：更新状态 + 持久化到 localStorage
  const setTheme = useCallback((next: Theme) => {
    setThemeState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // localStorage 不可用（隐私模式等）时静默失败
    }
  }, []);

  // 用 useMemo 稳定 context 值，避免不必要的重渲染
  const value = useMemo<ThemeContextValue>(
    () => ({ theme, resolvedTheme, setTheme }),
    [theme, resolvedTheme, setTheme],
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
