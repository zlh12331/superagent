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

import type { ApiKeyProvider } from '@novel-writer/shared';
import { createPersistentStore } from './create-persistent-store';

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

  // ── 操作方法 ────────────────────────────────────────
  /** 设置主题 */
  readonly setTheme: (theme: Theme) => void;
  /** 更新 AI 设置（部分字段） */
  readonly updateAi: (patch: Partial<AiSettings>) => void;
  /** 更新编辑器设置（部分字段） */
  readonly updateEditor: (patch: Partial<EditorSettings>) => void;
  /** 更新快捷键设置（部分字段） */
  readonly updateShortcuts: (patch: Partial<KeyboardShortcuts>) => void;
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
    },
    editor: {
      fontSize: 14,
      vimMode: false,
    },
    shortcuts: {
      commandPalette: 'Meta+P',
      saveFile: 'Meta+S',
      searchFile: 'Meta+Shift+F',
      toggleTheme: 'Meta+Shift+T',
      openSettings: 'Meta+,',
      newSession: 'Meta+N',
    },

    setTheme: (theme) => set({ theme }),
    updateAi: (patch) => set((state) => ({ ai: { ...state.ai, ...patch } })),
    updateEditor: (patch) => set((state) => ({ editor: { ...state.editor, ...patch } })),
    updateShortcuts: (patch) => set((state) => ({ shortcuts: { ...state.shortcuts, ...patch } })),
  }),
  {
    name: 'settings',
    version: 2,
  },
);
