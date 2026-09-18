// src/renderer/stores/persistent/settings-store.ts
// 用户设置状态（L2 客户端共享状态层 - persistent）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 统一管理用户偏好设置：主题、AI 默认模型、编辑器配置等
// - 替代 ThemeProvider 中手写的 localStorage 逻辑（ThemeProvider 改为副作用消费方）
// - 跨应用重启保留用户设置
//
// S1 设计（settings 下沉 SQLite，用户决策）：
// - 持久化真源从 localStorage 迁移到主进程 SQLite（app_settings 表）
// - 本 store 保持纯内存态（即时性）；写穿透：每次变更 fire-and-forget
//   经 settings:set IPC 落库；启动时 main.tsx 经 settings:getAll 拉取快照后
//   applySettingsSnapshot() 注入（首帧前完成，无主题闪烁）
// - 仅存储用户偏好，不存储敏感数据（API Key 由主进程 keychain 管理）
// ──────────────────────────────────────────────────────────────

import {
  type ApiKeyProvider,
  DEFAULT_MODEL,
  DEFAULT_PROVIDER,
  type SettingKey,
  type ThinkingLevel,
} from '@code-agent/shared/renderer';
import { create } from 'zustand';

import { LANGUAGE_STORAGE_KEY } from '@/i18n/config';
import { mirrorThemeForFirstPaint } from '@/lib/theme-init';

/**
 * 平台修饰键：macOS 用 Meta（⌘），Windows/Linux 用 Ctrl
 *
 * 默认快捷键按平台归一化（Windows 用户按 Ctrl+P 生效，与快捷键帮助文档一致）。
 */
const IS_MAC =
  typeof navigator !== 'undefined' && navigator.platform?.toLowerCase().includes('mac') === true;
const MOD = IS_MAC ? 'Meta' : 'Ctrl';

/**
 * 主题类型
 *
 * - 'light'：亮色
 * - 'dark'：暗色
 * - 'system'：跟随系统偏好
 */
export type Theme = 'light' | 'dark' | 'system';

/**
 * 主题循环顺序：dark → light → system → dark
 *
 * 所有切换入口（快捷键 / Topbar / 账户菜单 / 命令面板）共用同一循环，
 * 保证三态均可到达（此前快捷键为三态而 UI 为两态，system 无 UI 入口）。
 */
export const THEME_CYCLE: Readonly<Record<Theme, Theme>> = {
  dark: 'light',
  light: 'system',
  system: 'dark',
};

/** 计算下一个主题（三态循环） */
export function nextTheme(theme: Theme): Theme {
  return THEME_CYCLE[theme];
}

/**
 * AI 相关设置（不含 API Key，API Key 由主进程 keychain 管理）
 */
export interface AiSettings {
  /** 默认 API 提供商（如 'deepseek'、'openai'） */
  readonly defaultProvider: ApiKeyProvider;
  /** 默认聊天模型（如 'deepseek-v4-flash'） */
  readonly defaultModel: string;
  /** 温度（0-2，默认 0.7） */
  readonly temperature: number;
  /**
   * 自定义系统提示词（Code Agent 专用）
   *
   * 空字符串表示使用主进程内置默认 system prompt；
   * 非空字符串会通过 AgentRunReq.systemPrompt 透传给主进程，
   * 覆盖内置默认值。
   */
  readonly systemPrompt: string;
  /**
   * 思考强度（对齐原型 thinking seg-control：off/low/medium/high）
   *
   * 发送消息时透传给主进程（agent:run / chat:send），
   * 覆盖模型级默认 reasoningEffort（'off' = 不注入，用模型默认）。
   */
  readonly thinking: ThinkingLevel;
}

/**
 * 编辑器相关设置
 */
export interface EditorSettings {
  /** 字体大小（px，默认 14） */
  readonly fontSize: number;
  /** 是否启用 vim 模式 */
  readonly vimMode: boolean;
}

/**
 * 快捷键配置（使用 KeyboardEvent.code 作为键名，便于跨键盘布局）
 */
export interface KeyboardShortcuts {
  /** 打开命令面板 */
  readonly commandPalette: string;
  /** 保存文件 */
  readonly saveFile: string;
  /** 搜索文件 */
  readonly searchFile: string;
  /** 切换主题 */
  readonly toggleTheme: string;
  /** 打开设置 */
  readonly openSettings: string;
  /** 新建会话 */
  readonly newSession: string;
}

/**
 * 实验性功能开关（对齐原型「实验功能」设置区）
 *
 * 只列真实生效的开关：
 * - scanlines：扫描线视觉叠加（致敬终端，CSS 类驱动）
 * - reasoningCollapsed：推理块默认折叠（消息渲染消费）
 * - autoCompact：长会话自动压缩（use-auto-compact 消费，默认关闭）
 */
export interface ExperimentalSettings {
  /** 扫描线视觉叠加（.scanlines-overlay） */
  readonly scanlines: boolean;
  /** 推理块默认折叠（false = 默认展开） */
  readonly reasoningCollapsed: boolean;
  /** 长会话自动压缩：消息达阈值且回合空闲时自动调 session:compact（默认关闭） */
  readonly autoCompact: boolean;
}

/**
 * 语言服务器设置（LSP 按语言覆盖；主进程 getLspManager 构造时读取）
 *
 * serverCommands：语言标识 → 完整命令行（如 'pyright-langserver --stdio'；
 * 空串/缺省 = 内置默认）。修改后重启应用生效。
 */
export interface LspSettings {
  readonly serverCommands: Readonly<Record<string, string>>;
}

/**
 * 工作区设置（文件树行为；忽略模式由主进程 file:list 每次现读——改后即生效）
 */
export interface WorkspaceSettings {
  /**
   * 文件树忽略模式列表（名称级：精确 / * / ?；内置 node_modules 基线之外的用户追加项）
   */
  readonly treeIgnorePatterns: readonly string[];
  /** 文件树默认展开层级（1-3；1 = 仅展开根目录，即既有行为） */
  readonly defaultExpandDepth: number;
}

/** 浏览器预览设备预设（与 BrowserPane 视口映射一一对应） */
export type BrowserDevicePreset = 'responsive' | 'desktop' | 'laptop' | 'tablet' | 'mobile';

/** 浏览器预览缩放档位（与工具栏下拉一致，避免任意值把视口拉出可用范围） */
export type BrowserZoom = 50 | 75 | 100 | 125 | 150 | 200;

/**
 * 记忆功能设置
 *
 * enabled 是隐私开关：关闭后主进程不捕获新记忆、不注入召回（已有记忆保留，
 * 用户可在设置页清除）。默认开启——记忆是产品核心能力之一，但必须可见可关。
 */
export interface MemorySettings {
  /** 是否启用记忆（默认 true） */
  readonly enabled: boolean;
}

/**
 * 浏览器 pane 设置（右面板进程外预览工具，页面在主进程 WebContentsView 加载）
 *
 * 前两项是 pane 挂载时的初值（工具栏内可临时改，不写回）；
 * strictSandbox 是安全策略，切换经 browser:configure 即时生效。
 */
export interface BrowserSettings {
  /** 默认设备预设 */
  readonly defaultDevicePreset: BrowserDevicePreset;
  /** 默认缩放百分比 */
  readonly defaultZoom: BrowserZoom;
  /**
   * 严格沙箱：禁用预览页 JavaScript（webPreferences.javascript: false）
   *
   * 预览页多为外站，放行脚本意味着远端代码可在应用内运行（重定向、指纹采集、
   * 表单劫持）。预览本身已在独立 session 分区 + 沙箱进程中，严格模式是额外
   * 收紧。代价：依赖 JS 的站点渲染为静态骨架，故默认关闭（保持既有行为）。
   */
  readonly strictSandbox: boolean;
}

/**
 * 自动更新设置
 *
 * autoCheck 是"自动发现"总开关（默认开）：开启时每次启动自动检查、发现新版
 * 后台下载、退出时自动安装；关闭时三者全停，但用户手动点"检查更新"后的
 * 下载与安装照常（见 docs/design/27-auto-update-spec.md §4）。
 */
export interface UpdateSettings {
  /** 是否启用自动检查更新（默认 true） */
  readonly autoCheck: boolean;
  /**
   * 用户主动跳过的版本号（默认 null）
   *
   * 语义是"这个版本不再提醒"（顶栏徽标与 toast 静默），不阻断下载与安装——
   * 差分下载成本低，用户改主意时可点"取消跳过"或直接安装。出现更高版本时
   * 因版本号不等而自动失效（无需迁移逻辑）。
   */
  readonly skippedVersion: string | null;
}

/**
 * 应用界面语言
 *
 * P2 修复（S1 单真源残留）：语言此前经 i18next LanguageDetector 只写 localStorage，
 * 游离于 settings 写穿透链路之外（重装/多窗口不同步）。现在 SQLite 为真源，
 * localStorage 的 code-agent:lang 仅作 detector 的同步派生缓存。
 */
export type AppLanguage = 'zh-CN' | 'en';

/**
 * 用户设置数据形状（不含操作方法；DEFAULT_SETTINGS 与快照共用）
 */
interface SettingsData {
  /** 主题设置 */
  readonly theme: Theme;
  /** 界面语言（P2：纳入 SQLite 真源，见 AppLanguage 注释） */
  readonly language: AppLanguage;
  /** AI 设置 */
  readonly ai: AiSettings;
  /** 编辑器设置 */
  readonly editor: EditorSettings;
  /** 快捷键设置 */
  readonly shortcuts: KeyboardShortcuts;
  /** 实验性功能 */
  readonly experimental: ExperimentalSettings;
  /** 语言服务器 */
  readonly lsp: LspSettings;
  /** 工作区（文件树行为） */
  readonly workspace: WorkspaceSettings;
  /** 浏览器 pane（iframe 预览） */
  readonly browser: BrowserSettings;
  /** 记忆功能（隐私开关） */
  readonly memory: MemorySettings;
  /** 自动更新（自动检查开关） */
  readonly update: UpdateSettings;
}

/**
 * 用户设置状态形状
 */
interface SettingsState extends SettingsData {
  // ── 操作方法 ────────────────────────────────────────
  /** 设置主题 */
  readonly setTheme: (theme: Theme) => void;
  /** 设置界面语言（写穿透落库 + 镜像 detector 缓存） */
  readonly setLanguage: (language: AppLanguage) => void;
  /** 更新 AI 设置（部分字段） */
  readonly updateAi: (patch: Partial<AiSettings>) => void;
  /** 更新编辑器设置（部分字段） */
  readonly updateEditor: (patch: Partial<EditorSettings>) => void;
  /** 更新快捷键设置（部分字段） */
  readonly updateShortcuts: (patch: Partial<KeyboardShortcuts>) => void;
  /** 更新实验性功能（部分字段） */
  readonly updateExperimental: (patch: Partial<ExperimentalSettings>) => void;
  /** 更新语言服务器设置（部分字段） */
  readonly updateLsp: (patch: Partial<LspSettings>) => void;
  /** 更新工作区设置（部分字段） */
  readonly updateWorkspace: (patch: Partial<WorkspaceSettings>) => void;
  /** 更新浏览器 pane 设置（部分字段） */
  readonly updateBrowser: (patch: Partial<BrowserSettings>) => void;
  /** 更新记忆设置（写穿透 SQLite） */
  readonly updateMemory: (patch: Partial<MemorySettings>) => void;
  /** 更新自动更新设置（写穿透 SQLite；主进程下次启动读取生效） */
  readonly setUpdate: (patch: Partial<UpdateSettings>) => void;
}

/**
 * 写穿透：设置变更后 fire-and-forget 经 IPC 落库（SQLite 单一真源）
 *
 * window.api 未注入（浏览器模式/单测）时静默跳过——内存态仍可用。
 */
/**
 * 在途写入集合（2026-09-08 可靠性修复：退出丢失窗口）
 *
 * 此前 persistSetting 是纯 fire-and-forget——用户改设置后立刻退出应用，
 * 在途的 settings:set 可能尚未落库就被中断，最后一次变更丢失（回落到旧值）。
 * 这里记录每个在途 Promise，flushPendingSettings() 可在页面卸载前等待它们。
 */
const pendingWrites = new Set<Promise<unknown>>();

/**
 * 等待所有在途设置写入落库（供 main.tsx 注册 pagehide/beforeunload 调用）
 *
 * 注：pagehide 阶段无法阻塞卸载，但 Electron 渲染层退出前主进程会先收到
 * IPC，这里的等待能让绝大多数写入完成（fire-and-forget 的窗口从「整个进程
 * 生命周期」收敛到「同步调用栈」）。
 */
export async function flushPendingSettings(): Promise<void> {
  if (pendingWrites.size === 0) {
    return;
  }
  await Promise.allSettled([...pendingWrites]);
}

function persistSetting(key: SettingKey, value: unknown): void {
  const api = window.api;
  const setter = api?.settings?.set;
  if (typeof setter !== 'function') {
    return;
  }
  const write = setter({ key, value })
    .catch(() => {
      // 落库失败静默：下次变更会重写；不阻断 UI
    })
    .finally(() => {
      pendingWrites.delete(write);
    });
  pendingWrites.add(write);
}

/**
 * 旧版 v3 快捷键迁移（Meta+ → Ctrl+，Windows/Linux 平台归一化）
 *
 * S1：从 persist migrate 迁移为纯函数，供 settings-bootstrap 对
 * localStorage 旧数据与 SQLite 快照统一应用。
 */
export function migrateShortcuts<T extends object>(state: T): T {
  const shortcuts = (state as { readonly shortcuts?: unknown }).shortcuts as
    | Record<string, string>
    | undefined;
  if (shortcuts === undefined || IS_MAC) {
    return state;
  }
  const migrated: Record<string, string> = {};
  for (const [key, value] of Object.entries(shortcuts)) {
    migrated[key] =
      typeof value === 'string' && value.startsWith('Meta+')
        ? value.replace(/^Meta\+/, 'Ctrl+')
        : (value as string);
  }
  return { ...state, shortcuts: migrated } as T;
}

/** 默认设置（模块级常量；applySettingsSnapshot 覆盖） */
const DEFAULT_SETTINGS: SettingsData = {
  theme: 'dark',
  language: 'zh-CN',
  ai: {
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
    temperature: 0.7,
    systemPrompt: '',
    thinking: 'high',
  },
  editor: {
    fontSize: 14,
    vimMode: false,
  },
  shortcuts: {
    commandPalette: `${MOD}+P`,
    saveFile: `${MOD}+S`,
    searchFile: `${MOD}+F`,
    toggleTheme: `${MOD}+Shift+T`,
    openSettings: `${MOD}+,`,
    newSession: `${MOD}+N`,
  },
  experimental: {
    scanlines: false,
    reasoningCollapsed: true,
    autoCompact: false,
  },
  lsp: {
    serverCommands: {},
  },
  workspace: {
    treeIgnorePatterns: [],
    defaultExpandDepth: 1,
  },
  browser: {
    defaultDevicePreset: 'responsive',
    defaultZoom: 100,
    strictSandbox: false,
  },
  memory: {
    enabled: true,
  },
  update: {
    autoCheck: true,
    skippedVersion: null,
  },
};

/**
 * 用户设置 Store（S1：内存态 + 写穿透落库）
 *
 * @example
 * ```tsx
 * const theme = useSettingsStore((s) => s.theme);
 * const setTheme = useSettingsStore((s) => s.setTheme);
 * ```
 */
export const useSettingsStore = create<SettingsState>()((set) => ({
  ...DEFAULT_SETTINGS,

  setTheme: (theme) => {
    set({ theme });
    persistSetting('theme', theme);
    // 首帧防闪镜像：index.html 内联脚本（CSP hash 放行）在主进程 settings:getAll
    // 往返完成前读此键切 .dark——与 LANGUAGE_STORAGE_KEY 镜像同构的派生缓存
    mirrorThemeForFirstPaint(theme);
  },
  setLanguage: (language) => {
    set({ language });
    persistSetting('language', language);
    // 镜像 detector 缓存：i18next init 在 React 渲染期（早于任何 store 消费），
    // LanguageDetector 只能同步读 localStorage；SQLite 才是真源，此键仅派生缓存
    try {
      localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
    } catch {
      // 无痕模式等场景静默（真源已落 SQLite）
    }
  },
  // P2 修复：persistSetting 移出 set() updater——zustand updater 应为纯函数，
  // StrictMode/并发特性下 updater 可能被重复调用，产生重复 IPC 写穿透
  // （幂等但浪费；且违背「updater 内禁副作用」约定）。
  // 模式：先基于 getState() 计算新值 → set() 提交 → 再写穿透
  updateAi: (patch) => {
    const ai = { ...useSettingsStore.getState().ai, ...patch };
    set({ ai });
    persistSetting('ai', ai);
  },
  updateEditor: (patch) => {
    const editor = { ...useSettingsStore.getState().editor, ...patch };
    set({ editor });
    persistSetting('editor', editor);
  },
  updateShortcuts: (patch) => {
    const shortcuts = { ...useSettingsStore.getState().shortcuts, ...patch };
    set({ shortcuts });
    persistSetting('shortcuts', shortcuts);
  },
  updateExperimental: (patch) => {
    const experimental = { ...useSettingsStore.getState().experimental, ...patch };
    set({ experimental });
    persistSetting('experimental', experimental);
  },
  updateLsp: (patch) => {
    const lsp = { ...useSettingsStore.getState().lsp, ...patch };
    set({ lsp });
    persistSetting('lsp', lsp);
  },
  updateWorkspace: (patch) => {
    const workspace = { ...useSettingsStore.getState().workspace, ...patch };
    set({ workspace });
    persistSetting('workspace', workspace);
  },
  updateBrowser: (patch) => {
    const browser = { ...useSettingsStore.getState().browser, ...patch };
    set({ browser });
    persistSetting('browser', browser);
  },
  updateMemory: (patch) => {
    const memory = { ...useSettingsStore.getState().memory, ...patch };
    set({ memory });
    persistSetting('memory', memory);
  },
  setUpdate: (patch) => {
    const update = { ...useSettingsStore.getState().update, ...patch };
    set({ update });
    persistSetting('update', update);
  },
}));

/**
 * 应用启动快照（S1：main.tsx 在 render 前调用，覆盖默认值）
 *
 * @param snapshot settings:getAll 返回的 key → JSON 值映射（已含迁移处理）
 */
export function applySettingsSnapshot(snapshot: Readonly<Record<string, unknown>>): void {
  const theme = (snapshot['theme'] as Theme | undefined) ?? DEFAULT_SETTINGS.theme;
  // 首帧镜像随快照同步：新用户（无镜像）首帧脚本按默认 dark 渲染，
  // 首次改主题后镜像即生效；SQLite 快照是权威值，此处补写保持一致
  mirrorThemeForFirstPaint(theme);
  useSettingsStore.setState({
    theme,
    language: (snapshot['language'] as AppLanguage | undefined) ?? DEFAULT_SETTINGS.language,
    ai: { ...DEFAULT_SETTINGS.ai, ...((snapshot['ai'] as Partial<AiSettings> | undefined) ?? {}) },
    editor: {
      ...DEFAULT_SETTINGS.editor,
      ...((snapshot['editor'] as Partial<EditorSettings> | undefined) ?? {}),
    },
    shortcuts: {
      ...DEFAULT_SETTINGS.shortcuts,
      ...((snapshot['shortcuts'] as Partial<KeyboardShortcuts> | undefined) ?? {}),
    },
    experimental: {
      ...DEFAULT_SETTINGS.experimental,
      ...((snapshot['experimental'] as Partial<ExperimentalSettings> | undefined) ?? {}),
    },
    lsp: {
      ...DEFAULT_SETTINGS.lsp,
      ...((snapshot['lsp'] as Partial<LspSettings> | undefined) ?? {}),
    },
    workspace: {
      ...DEFAULT_SETTINGS.workspace,
      ...((snapshot['workspace'] as Partial<WorkspaceSettings> | undefined) ?? {}),
    },
    browser: {
      ...DEFAULT_SETTINGS.browser,
      ...((snapshot['browser'] as Partial<BrowserSettings> | undefined) ?? {}),
    },
    memory: {
      ...DEFAULT_SETTINGS.memory,
      ...((snapshot['memory'] as Partial<MemorySettings> | undefined) ?? {}),
    },
    update: {
      ...DEFAULT_SETTINGS.update,
      ...((snapshot['update'] as Partial<UpdateSettings> | undefined) ?? {}),
    },
  });
}
