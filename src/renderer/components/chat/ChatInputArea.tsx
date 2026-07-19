// src/renderer/components/chat/ChatInputArea.tsx
// 聊天输入区（输入框 + 发送 + 停止按钮）
// 设计文档 §5.1 场景 3 AI 流式对话 + §7.10 用户友好提示
//
// 职责：
// - 提供 Textarea 多行纯文本输入（不引入 markdown 编辑器）
// - Enter 发送，Shift+Enter 换行
// - 发送按钮（isStreaming=false 时显示）
// - 停止按钮（isStreaming=true 时显示，destructive variant）
// - 输入为空时禁用发送；sessionId === null 时禁用整个输入区
// - 发送后清空输入框
//
// 注意：
// - Textarea 用 rows={3} + max-h-[200px] overflow-y-auto 实现自动调整高度
// - 仅纯文本输入，不引入 TipTap 等富文本编辑器
// - 中文输入法组合态（isComposing）时 Enter 应换行而非发送，
//   但浏览器原生 Textarea 已正确处理 IME composition 事件，
//   keydown 在 composition 期间不会触发本处理函数

import { Send, StopCircle } from 'lucide-react';
import type { KeyboardEvent, ReactElement } from 'react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';

interface ChatInputAreaProps {
  /** 当前会话 ID（null 表示未选中会话，禁用输入区） */
  sessionId: string | null;
  /** 是否正在流式接收（true 时显示停止按钮，false 时显示发送按钮） */
  isStreaming: boolean;
  /** 发送消息回调（入参为去除首尾空白的消息内容） */
  onSend: (content: string) => void;
  /** 停止生成回调 */
  onStop: () => void;
}

/**
 * 聊天输入区
 *
 * @example
 * <ChatInputArea
 *   sessionId={activeSessionId}
 *   isStreaming={isStreaming}
 *   onSend={(content) => void sendAsync({ sessionId: activeSessionId!, content })}
 *   onStop={() => void stopAsync(activeSessionId!)}
 * />
 */
export function ChatInputArea({
  sessionId,
  isStreaming,
  onSend,
  onStop,
}: ChatInputAreaProps): ReactElement {
  // 输入框内容
  const [value, setValue] = useState('');

  // 会话未选中：禁用整个输入区
  const disabled = sessionId === null;

  /**
   * 发送消息
   * - 空白内容不发送（trim 后长度为 0）
   * - 发送后清空输入框
   */
  const handleSend = (): void => {
    const trimmed = value.trim();
    if (trimmed.length === 0) return;
    onSend(trimmed);
    setValue('');
  };

  /**
   * 键盘事件：Enter 发送，Shift+Enter 换行
   *
   * 阻止默认行为（换行）后调 handleSend。
   * Shift+Enter 时不阻止默认行为，浏览器自动插入换行符。
   */
  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="border-t p-3">
      <div className="mx-auto flex max-w-3xl items-end gap-2">
        <Textarea
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={disabled ? '请先选择会话' : '输入消息，Enter 发送，Shift+Enter 换行'}
          rows={3}
          disabled={disabled}
          className="max-h-[200px] min-h-[80px] resize-none overflow-y-auto"
        />
        {/* 发送 / 停止按钮：根据 isStreaming 切换 */}
        {isStreaming ? (
          <Button variant="destructive" size="default" onClick={onStop} disabled={disabled}>
            <StopCircle className="size-4" />
            停止
          </Button>
        ) : (
          <Button
            variant="default"
            size="default"
            onClick={handleSend}
            disabled={disabled || value.trim().length === 0}
          >
            <Send className="size-4" />
            发送
          </Button>
        )}
      </div>
    </div>
  );
}
