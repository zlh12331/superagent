// message-actions.tsx（自 ChatMessageList 拆分）
// 消息操作按钮组（复制/重试/折叠等）
// ──────────────────────────────
// 拆分背景：ChatMessageList 685 行，操作按钮提取为独立文件
// ──────────────────────────────

// src/renderer/components/chat/ChatMessageList.tsx
// 聊天消息列表 · Aurora 设计系统
// ──────────────────────────────────────────────────────────────
// 职责：
// - 渲染 UIMessage 数组（user / assistant / system 三种角色）
// - assistant 消息按 parts 分发渲染（text / reasoning / tool / file / step-start 等）
// - 智能自动滚动：仅当用户在底部附近时跟随，否则显示 scroll-to-bottom 按钮
// - 空状态展示 EmptyState 组件
//
// 设计（对齐原型 docs/prototype/prototype-v2.html）：
// - user 消息：.msg.user > .msg-body > .msg-content（玻璃渐变气泡，靠右由 .msg-content 自身样式实现）
// - assistant 消息：.msg.assistant > .msg-avatar.assistant + .msg-body > .msg-role + .msg-content（无气泡开放排版）
// - tool 调用：.msg.msg-tool > .msg-body > .card.tool-card（可折叠卡片）
// - reasoning：.reasoning-block（折叠式推理块，accent 左光条）
// - system 消息：居中小字
// - streaming 占位：typing-indicator（三个 accent 点弹跳）
// - 滚动到底部按钮：.scroll-to-bottom（距底部 > 80px 时显示，有新消息加 .has-new）
// ──────────────────────────────────────────────────────────────
//
// 说明：
// - 不在此组件内调用 useChat，messages / status 由父组件传入
// - 仅做展示，不做任何业务逻辑
// - 使用 AI SDK 官方类型守卫（isTextUIPart / isReasoningUIPart 等）
// - part 类型用 UIMessage['parts'][number] 派生，避免手写泛型参数

// type-only import：仅引入类型，不引入运行时依赖
// AI SDK 官方类型守卫：在运行时判断 part 类型并收窄 TypeScript 类型
import { Copy, RefreshCw } from 'lucide-react';
import type { ReactElement } from 'react';
import { useCopy } from '@/hooks/use-copy';

import { useTranslation } from '@/i18n/use-translation';
import { cn } from '@/lib/utils';

export function MsgActions({
  text,
  messageId,
  onRegenerate,
  disabled,
}: {
  text: string;
  messageId: string;
  onRegenerate: ((messageId: string) => void) | undefined;
  disabled: boolean;
}): ReactElement {
  // 剪贴板复制统一走 useCopy（含失败 toast 反馈，此前静默失败）
  const { copied, copy } = useCopy();
  // 本地化文案
  const { t } = useTranslation();

  const handleRegenerate = (): void => {
    if (disabled) return;
    onRegenerate?.(messageId);
  };

  return (
    <div className="msg-actions show">
      <button
        type="button"
        className={cn('msg-action-btn', copied && 'copied')}
        onClick={() => void copy(text)}
        aria-label={copied ? t('chat.copied') : t('chat.copy')}
        title={copied ? t('chat.copied') : t('chat.copy')}
      >
        <Copy />
        {copied ? t('chat.copied') : t('chat.copy')}
      </button>
      <button
        type="button"
        className="msg-action-btn"
        aria-label={t('chat.regenerate')}
        title={disabled ? t('chat.generating') : t('chat.regenerate')}
        onClick={handleRegenerate}
        disabled={disabled}
      >
        <RefreshCw />
        {t('chat.regenerate')}
      </button>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────
// 工具函数
// ──────────────────────────────────────────────────────────────

/**
 * 从 parts 中提取所有文本并拼接
 *
 * 用于 user / system 消息（只展示文本内容）。
 */
