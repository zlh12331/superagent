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

/**
 * 首帧主题镜像 key（FOUC 防护第二环）
 *
 * 写入点：settings-store 的 setTheme / applySettingsSnapshot（mirrorThemeForFirstPaint）
 * 读取点：index.html head 内联同步脚本（CSP hash 放行，见 index.html 头部注释）——
 * 在主进程 settings:getAll 往返完成前抢先切 .dark class。
 * 值为裸字符串 'light'|'dark'|'system'（非 zustand persist 结构，脚本解析零依赖）。
 */
export const THEME_FIRST_PAINT_KEY = 'code-agent:theme';

/** 默认主题（与 settings-store 默认值一致） */
export const DEFAULT_THEME = 'dark' as const;

/** 用户可选主题 */
export type StoredTheme = 'light' | 'dark' | 'system';

/**
 * 镜像主题到 localStorage（首帧内联脚本消费）
 *
 * settings 真源在 SQLite（S1），首帧脚本无法同步读 IPC——主题每次变更时
 * 低成本镜像一份到 localStorage，脚本启动即得用户选择。
 * 失败静默（无痕模式等）：镜像缺失时脚本回退默认暗色，仅首帧方向偏差一次。
 */
export function mirrorThemeForFirstPaint(theme: StoredTheme): void {
  try {
    localStorage.setItem(THEME_FIRST_PAINT_KEY, theme);
  } catch {
    // 无痕模式 / 存储被禁：静默（首帧脚本回退默认主题）
  }
}

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
 *
 * S1（settings 下沉 SQLite）：theme 参数由 settings-bootstrap 传入
 * （启动快照 / legacy 迁移结果）；未传时回退读 localStorage（测试与
 * 浏览器模式保持原行为）。
 */
export function applyInitialTheme(theme?: StoredTheme): void {
  const resolvedTheme = theme ?? readStoredTheme(window.localStorage);
  const resolved: 'light' | 'dark' =
    resolvedTheme === 'system' ? resolveSystemTheme() : resolvedTheme;
  document.documentElement.classList.toggle('dark', resolved === 'dark');
}
