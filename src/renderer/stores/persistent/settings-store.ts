// src/renderer/stores/persistent/settings-store.ts
// 用户设置状态（L2 客户端共享状态层 - persistent）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 统一管理用户偏好设置：主题、AI 默认模型、编辑器配置等
// - 替代 ThemeProvider 中手写的 localStorage 逻辑（ThemeProvider 改为副作用消费方）
// - 跨应用重启保留用户设置
//
// 设计：
// - 使用 createPersistentStore 工厂统一 storage key 前缀 + 版本迁移
// - 字段按业务域分组（theme / ai / editor），便于扩展
// - 仅存储用户偏好，不存储敏感数据（API Key 由主进程 keychain 管理）
// ──────────────────────────────────────────────────────────────

import type { ApiKeyProvider, ThinkingLevel } from '@code-agent/shared/renderer';
import { createPersistentStore } from './create-persistent-store';

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
   *
   * 用途：让用户自定义 Agent 行为（如"使用中文回复"、"专注于 TypeScript 代码"等）。
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
 */
export interface ExperimentalSettings {
  /** 扫描线视觉叠加（.scanlines-overlay） */
  readonly scanlines: boolean;
  /** 推理块默认折叠（false = 默认展开） */
  readonly reasoningCollapsed: boolean;
}

/**
 * 用户设置状态形状
 */
interface SettingsState {
  /** 主题设置 */
  readonly theme: Theme;
  /** AI 设置 */
  readonly ai: AiSettings;
  /** 编辑器设置 */
  readonly editor: EditorSettings;
  /** 快捷键设置 */
  readonly shortcuts: KeyboardShortcuts;
  /** 实验性功能 */
  readonly experimental: ExperimentalSettings;

  // ── 操作方法 ────────────────────────────────────────
  /** 设置主题 */
  readonly setTheme: (theme: Theme) => void;
  /** 更新 AI 设置（部分字段） */
  readonly updateAi: (patch: Partial<AiSettings>) => void;
  /** 更新编辑器设置（部分字段） */
  readonly updateEditor: (patch: Partial<EditorSettings>) => void;
  /** 更新快捷键设置（部分字段） */
  readonly updateShortcuts: (patch: Partial<KeyboardShortcuts>) => void;
  /** 更新实验性功能（部分字段） */
  readonly updateExperimental: (patch: Partial<ExperimentalSettings>) => void;
}

/**
 * 用户设置 Store（持久化）
 *
 * @example
 * ```tsx
 * const theme = useSettingsStore((s) => s.theme);
 * const setTheme = useSettingsStore((s) => s.setTheme);
 * ```
 */
export const useSettingsStore = createPersistentStore<SettingsState>()(
  (set) => ({
    theme: 'dark',
    ai: {
      defaultProvider: 'deepseek',
      defaultModel: 'deepseek-v4-flash',
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
      searchFile: `${MOD}+Shift+F`,
      toggleTheme: `${MOD}+Shift+T`,
      openSettings: `${MOD}+,`,
      newSession: `${MOD}+N`,
    },
    experimental: {
      scanlines: false,
      reasoningCollapsed: true,
    },

    setTheme: (theme) => set({ theme }),
    updateAi: (patch) => set((state) => ({ ai: { ...state.ai, ...patch } })),
    updateEditor: (patch) => set((state) => ({ editor: { ...state.editor, ...patch } })),
    updateShortcuts: (patch) => set((state) => ({ shortcuts: { ...state.shortcuts, ...patch } })),
    updateExperimental: (patch) =>
      set((state) => ({ experimental: { ...state.experimental, ...patch } })),
  }),
  {
    name: 'settings',
    version: 3,
    // v3 迁移：v2 默认快捷键均为 Meta 前缀（Windows 用户按 Ctrl+P 无效），
    // 按平台归一化——Windows/Linux 上 'Meta+P' → 'Ctrl+P'（macOS 保持）
    migrate: (persisted): Partial<SettingsState> => {
      const state = persisted as Partial<SettingsState> | null;
      if (state === null || state.shortcuts === undefined || IS_MAC) {
        return state ?? {};
      }
      const migrated: Record<string, string> = {};
      for (const [key, value] of Object.entries(state.shortcuts)) {
        migrated[key] =
          typeof value === 'string' && value.startsWith('Meta+')
            ? value.replace(/^Meta\+/, 'Ctrl+')
            : (value as string);
      }
      // KeyboardShortcuts 为全必填接口，Record 结果经 unknown 断言（迁移保证 6 键齐全）
      return {
        ...state,
        shortcuts: migrated as unknown as KeyboardShortcuts,
      };
    },
  },
);
