// src/renderer/lib/theme-init.ts
// 主题初始化（FOUC 防护）
// ──────────────────────────────────────────────────────────────
// 背景：ThemeProvider 在 React 挂载后才 applyTheme，而 zustand persist 是
// 异步恢复——首帧可能按默认主题渲染后闪切到用户主题（暗色），即 FOUC。
//
// 方案：渲染层入口 main.tsx 在 createRoot 之前同步读取 localStorage 并应用
// .dark class（module script 为 'self' 来源，生产 CSP script-src 'self' 合规；
// 不能放 index.html 内联脚本，生产 CSP 禁止 inline）。
//
// 存储格式与 createPersistentStore 对齐：
//   `code-agent:settings` = { state: { theme: 'light'|'dark'|'system' }, version }
// ──────────────────────────────────────────────────────────────

/** 持久化存储 key（与 createPersistentStore 的 `code-agent:` 前缀 + name 拼接一致） */
export const SETTINGS_STORAGE_KEY = 'code-agent:settings';

/** 默认主题（与 settings-store 默认值一致） */
export const DEFAULT_THEME = 'dark' as const;

/** 用户可选主题 */
export type StoredTheme = 'light' | 'dark' | 'system';

/**
 * 解析持久化的主题设置
 *
 * 解析失败 / 字段缺失 / 非法值 → 回退默认主题。
 * 与 zustand persist 的 JSON 结构（{ state: { theme } }）对齐。
 *
 * @param storage 存储后端（默认 window.localStorage，测试可注入）
 */
export function readStoredTheme(storage: Storage): StoredTheme {
  try {
    const raw = storage.getItem(SETTINGS_STORAGE_KEY);
    if (raw === null) {
      return DEFAULT_THEME;
    }
    const parsed = JSON.parse(raw) as { state?: { theme?: unknown } };
    const theme = parsed.state?.theme;
    return theme === 'light' || theme === 'dark' || theme === 'system' ? theme : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

/** 解析 system 偏好为实际主题（无 window 时回退 light，保持 SSR 健壮性） */
export function resolveSystemTheme(): 'light' | 'dark' {
  if (typeof window === 'undefined') {
    return 'light';
  }
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/**
 * 在 React 渲染前同步应用初始主题，消除首屏闪烁
 *
 * 必须在 createRoot(...).render() 之前调用。
 */
export function applyInitialTheme(): void {
  const theme = readStoredTheme(window.localStorage);
  const resolved: 'light' | 'dark' = theme === 'system' ? resolveSystemTheme() : theme;
  document.documentElement.classList.toggle('dark', resolved === 'dark');
}
