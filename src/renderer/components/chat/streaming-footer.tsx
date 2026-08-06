// streaming-footer.tsx（自 ChatMessageList 拆分）
// 流式响应尾部：生成中提示 / 占位
// ──────────────────────────────
// 拆分背景：ChatMessageList 685 行，流式尾部提取为独立文件
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
import type { ReactElement } from 'react';

import { useTranslation } from '@/i18n/use-translation';

export function StreamingFooter(): ReactElement {
  return <StreamingPlaceholder />;
}

// ──────────────────────────────────────────────────────────────
// 内部组件
// ──────────────────────────────────────────────────────────────

/**
 * 单条消息渲染
 *
 * 按 message.role 分发到不同的展示样式：
 * - 'user'：.msg.user > .msg-body > .msg-content（玻璃渐变气泡）
 * - 'assistant'：.msg.assistant > .msg-avatar.assistant + .msg-body > .msg-role + parts
 * - 'system'：居中淡灰小字
 */

export function StreamingPlaceholder(): ReactElement {
  // 本地化文案
  const { t } = useTranslation();
  return (
    <div className="msg assistant enter-anim">
      <div className="msg-avatar assistant" aria-hidden="true">
        C
      </div>
      <div className="msg-body">
        <div className="msg-role assistant">{t('chat.assistant')}</div>
        <div className="typing-indicator" role="status" aria-label={t('chat.assistantTyping')}>
          <span className="ti-dot" />
          <span className="ti-dot" />
          <span className="ti-dot" />
        </div>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────
// 消息微交互组件
// ──────────────────────────────────────────────────────────────

/**
 * 消息 hover 操作栏（对齐原型 addMsgActions + .msg-actions）
 *
 * - 默认 opacity:0，hover .msg 时 opacity:1（CSS 控制）
 * - 复制：navigator.clipboard 写入纯文本，2s 内显示 copied 反馈
 * - 重新生成：调用 useChat.regenerate({ messageId })，流式状态下禁用避免并发
 *
 * 仅在 assistant 消息渲染（跳过 tool 消息），对齐原型 addMsgActions 逻辑。
 */
