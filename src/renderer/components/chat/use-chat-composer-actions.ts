// src/renderer/components/chat/use-chat-composer-actions.ts
// ChatPanel composer 动作（发送 / 斜杠命令）——自 ChatPanel 提取以压低认知复杂度
// ──────────────────────────────────────────────────────────────

import type { Dispatch, SetStateAction } from 'react';
import { resolveComposerSend } from './chat-panel-derives';
import { executeSlashCommand } from './slash-commands';
import type { SlashAction } from './slash-suggestions';

/** composer 动作依赖（由 ChatPanel 注入） */
export interface ChatComposerActionsDeps {
  readonly chatId: string;
  readonly createGoal: (condition: string) => void;
  readonly injectComposerValue: (value: string) => void;
  readonly sendMessage: (parts: { text: string }) => void;
  readonly setMessages: (messages: never[]) => void;
  readonly navigate: (to: string) => void;
  readonly openShortcutHelp: () => void;
  readonly setModelMenuOpen: Dispatch<SetStateAction<boolean>>;
  readonly compact: () => void;
  readonly stop: () => void;
}

/** composer 动作（handleSend + handleSlashCommand） */
export interface ChatComposerActions {
  readonly handleSend: (text: string) => void;
  readonly handleSlashCommand: (action: SlashAction) => void;
}

/**
 * 构建 composer 发送与斜杠命令处理
 *
 * 提取动机：ChatPanel 认知复杂度棘轮（≤15）；发送/斜杠分发含多分支，
 * 与 JSX 混在同一函数会叠加控制流复杂度。
 */
export function createChatComposerActions(deps: ChatComposerActionsDeps): ChatComposerActions {
  const {
    createGoal,
    injectComposerValue,
    sendMessage,
    setMessages,
    navigate,
    openShortcutHelp,
    setModelMenuOpen,
    compact,
    stop,
  } = deps;

  const handleSend = (text: string): void => {
    const intent = resolveComposerSend(text);
    if (intent.kind === 'createGoal') {
      createGoal(intent.condition);
      return;
    }
    if (intent.kind === 'prefillGoal') {
      injectComposerValue('/goal ');
      return;
    }
    void sendMessage({ text });
  };

  const handleSlashCommand = (action: SlashAction): void => {
    executeSlashCommand(action, {
      navigateToHome: () => navigate('/'),
      clearMessages: () => setMessages([]),
      openShortcutHelp,
      openModelMenu: () => setModelMenuOpen(true),
      compact,
      interrupt: () => {
        void stop();
      },
      sendMessage: (text) => {
        void sendMessage({ text });
      },
      prefillGoal: () => injectComposerValue('/goal '),
    });
  };

  return { handleSend, handleSlashCommand };
}
