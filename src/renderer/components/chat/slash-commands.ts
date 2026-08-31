// src/renderer/components/chat/slash-commands.ts
// 斜杠命令执行器（自 ChatPanel 提取的纯分发层）
// ──────────────────────────────────────────────
// 命令 → 动作的唯一映射点：ChatPanel 只提供动作回调，不再持switch 分支。
// 纯同步分发（无 React 依赖），可独立单测全部命令路径。
// ──────────────────────────────────────────────

import type { SlashAction } from './slash-suggestions';

/** 斜杠命令执行依赖（由 ChatPanel 注入实际行为） */
export interface SlashCommandDeps {
  /** /new：回欢迎页新建会话 */
  readonly navigateToHome: () => void;
  /** /clear：清空当前对话（AI SDK v7 setMessages([])） */
  readonly clearMessages: () => void;
  /** /help：打开快捷键帮助对话框 */
  readonly openShortcutHelp: () => void;
  /** /models：打开 composer 项目栏的模型选择下拉（受控） */
  readonly openModelMenu: () => void;
  /** /compact：手动压缩会话上下文（useMutation.mutate） */
  readonly compact: () => void;
  /** /interrupt：即时中断当前生成 */
  readonly interrupt: () => void;
  /** 发送文本（/demo /limit 等 mock 演示命令走消息通道触发 mock 流） */
  readonly sendMessage: (text: string) => void;
  /** /goal 斜杠建议：预填 "/goal " 到输入框（用户补需求后发送；ChatPanel 经 prefillGoalInput 实现） */
  readonly prefillGoal: () => void;
}

/**
 * 执行斜杠命令（纯同步分发）
 *
 * @param action 命令动作（来自 SLASH_SUGGESTIONS 的 action 字段）
 * @param deps 动作回调集合
 */
export function executeSlashCommand(action: SlashAction, deps: SlashCommandDeps): void {
  switch (action) {
    case 'new':
      deps.navigateToHome();
      break;
    case 'clear':
      deps.clearMessages();
      break;
    case 'help':
      deps.openShortcutHelp();
      break;
    case 'models':
      deps.openModelMenu();
      break;
    case 'compact':
      deps.compact();
      break;
    case 'interrupt':
      deps.interrupt();
      break;
    case 'goal':
      // /goal 斜杠建议：填入输入框（用户需求：唯一交互 = 输入 /goal 需求直接发送；
      // 点建议后输入框预填 "/goal "，用户补需求回车即创建目标）
      deps.prefillGoal();
      break;
    case 'demo':
    case 'limit':
      // mock 演示命令（前端开发专用）：直接发送触发 mock 流
      deps.sendMessage(action === 'demo' ? '/demo' : '/limit');
      break;
  }
}
