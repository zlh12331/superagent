// src/renderer/stores/transient/welcome-store.ts
// 欢迎页模式状态管理（L2 客户端共享状态层 - transient）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 维护 isWelcomeMode 标志：决定 .view-chat 是否进入 welcome-mode
// - 维护 pendingWorkingDir：可选的预设工作目录（如「在此文件夹新建会话」入口）
// - 提供 enterWelcomeMode / exitWelcomeMode 原子操作
//
// 设计：
// - 纯 UI 状态容器，不调用 IPC（创建会话由 HomePage 在发送消息时触发）
// - 不持久化：每次启动应回到「无激活会话 → 默认进入欢迎页」的初始态
//   （activeSessionId 由 sessions-store 持久化，若存在则 ChatPage 进入时退出欢迎模式）
//
// 交互对齐原型 docs/prototype/prototype-v2.html：
// - 原型 setWelcomeMode(true) 在「新建会话」按钮 + 切换到 home 视图时触发
// - 原型 setWelcomeMode(false) 在选中会话 / 发送消息创建会话后触发
// ──────────────────────────────────────────────────────────────

import { create } from 'zustand';

/**
 * 欢迎页模式状态形状
 */
interface WelcomeModeState {
  /** 是否处于欢迎页模式（控制 .view-chat.welcome-mode class） */
  readonly isWelcomeMode: boolean;
  /**
   * 预设工作目录（可选）
   *
   * - 由「在此文件夹新建会话」入口设置，欢迎页发送消息时使用此目录创建会话
   * - 为 null 时，HomePage 发送消息需先弹出目录选择器
   */
  readonly pendingWorkingDir: string | null;

  // ── 操作方法 ────────────────────────────────────────
  /** 进入欢迎页模式（可携带预设工作目录） */
  readonly enterWelcomeMode: (workingDir?: string | null) => void;
  /** 退出欢迎页模式（清空预设目录） */
  readonly exitWelcomeMode: () => void;
  /** 显式设置 welcome-mode 标志（用于 ChatPage 进入时退出欢迎模式） */
  readonly setWelcomeMode: (enabled: boolean) => void;
  /**
   * 仅更新预设工作目录（不切换 welcome-mode 标志）
   *
   * 用于 HomePage composer-project-bar 的 folder dropdown 选择：
   * 用户在 dropdown 中选择历史目录后，仅更新 pendingWorkingDir，
   * 不影响 welcome-mode 状态（仍在欢迎页编辑首条消息）。
   */
  readonly setPendingWorkingDir: (workingDir: string | null) => void;
}

/**
 * 欢迎页模式 store
 *
 * @example
 * ```tsx
 * const isWelcomeMode = useWelcomeStore((s) => s.isWelcomeMode);
 * const enterWelcomeMode = useWelcomeStore((s) => s.enterWelcomeMode);
 * ```
 */
export const useWelcomeStore = create<WelcomeModeState>()((set) => ({
  // 默认进入欢迎页模式（首次启动无激活会话）
  isWelcomeMode: true,
  pendingWorkingDir: null,

  enterWelcomeMode: (workingDir = null) =>
    set(() => ({
      isWelcomeMode: true,
      pendingWorkingDir: workingDir,
    })),

  exitWelcomeMode: () =>
    set(() => ({
      isWelcomeMode: false,
      pendingWorkingDir: null,
    })),

  setWelcomeMode: (enabled) =>
    set((state) => ({
      isWelcomeMode: enabled,
      // 退出时清空预设目录；进入时保留现有 pendingWorkingDir（避免误清）
      pendingWorkingDir: enabled ? state.pendingWorkingDir : null,
    })),

  setPendingWorkingDir: (workingDir) =>
    set(() => ({
      pendingWorkingDir: workingDir,
    })),
}));
