import { create } from 'zustand';

import { useActiveSessionStore } from '@/stores/persistent/sessions-store';

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

  /**
   * 进入欢迎页模式（可携带预设工作目录）
   *
   * 内部统一清空激活会话：保证「欢迎页 + 旧激活会话」不一致态不可构造
   * （此前一致性依赖每个调用方手动先调 clearActiveSession，约束散落）
   */
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
  isWelcomeMode: true,
  pendingWorkingDir: null,

  enterWelcomeMode: (workingDir = null) => {
    useActiveSessionStore.getState().clearActiveSession();
    return set(() => ({
      isWelcomeMode: true,
      pendingWorkingDir: workingDir,
    }));
  },

  exitWelcomeMode: () =>
    set(() => ({
      isWelcomeMode: false,
      pendingWorkingDir: null,
    })),

  setWelcomeMode: (enabled) =>
    set((state) => ({
      isWelcomeMode: enabled,
      pendingWorkingDir: enabled ? state.pendingWorkingDir : null,
    })),

  setPendingWorkingDir: (workingDir) =>
    set(() => ({
      pendingWorkingDir: workingDir,
    })),
}));
