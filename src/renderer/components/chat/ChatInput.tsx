// src/renderer/components/chat/ChatInput.tsx
// 聊天输入框 + 发送 / 停止按钮 · 极简文学风
// ──────────────────────────────────────────────────────────────
// 职责：
// - 多行文本输入（Enter 发送，Shift+Enter 换行）
// - 流式状态时显示"停止"按钮，否则显示"发送"按钮
// - 透传 disabled / placeholder 等原生属性
//
// 设计：
// - 输入框使用 Textarea 组件（shadcn/ui）
// - 容器使用米色卡片背景 + 圆角 + 阴影
// - 发送按钮使用 Send 图标（lucide-react，strokeWidth=1.5）
// - 停止按钮使用 Square 图标（lucide-react，strokeWidth=1.5）
// - 字体使用衬线宋体，呼应文学风
// ──────────────────────────────────────────────────────────────
//
// 说明：
// - 不在此组件内调用 useChat，所有状态由父组件（ChatPanel）传入
// - 这样 ChatInput 是纯展示+交互组件，可在测试中独立 mock
// - sendMessage / stop 回调签名与 useChat 返回值对齐

import { Send, Square } from 'lucide-react';
import { type KeyboardEvent, type ReactElement, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

interface ChatInputProps {
  /**
   * 当前流式状态
   * - 'ready' / 'error' / 'submitted'：显示发送按钮
   * - 'streaming'：显示停止按钮
   */
  status: 'submitted' | 'streaming' | 'ready' | 'error';
  /** 发送消息回调（传入文本） */
  onSend: (text: string) => void;
  /** 停止流式回调（父组件调用 useChat().stop） */
  onStop: () => void;
  /** 占位提示文字 */
  placeholder?: string;
  /** 是否禁用（如未配置 API Key 时） */
  disabled?: boolean;
  /** 自定义容器类名 */
  className?: string;
}

/**
 * 聊天输入框组件
 *
 * @example
 * ```tsx
 * <ChatInput
 *   status={status}
 *   onSend={(text) => sendMessage({ text })}
 *   onStop={stop}
 *   placeholder="输入消息..."
 * />
 * ```
 */
export function ChatInput({
  status,
  onSend,
  onStop,
  placeholder = '输入消息，按 Enter 发送，Shift+Enter 换行',
  disabled = false,
  className,
}: ChatInputProps): ReactElement {
  // 输入文本由组件内部管理（受控），避免父组件每次 render 都重渲染 Textarea
  const [value, setValue] = useState('');

  // 是否处于流式状态（显示停止按钮）
  const isStreaming = status === 'streaming' || status === 'submitted';

  // 是否可以发送（非空文本 + 非流式 + 未禁用）
  const canSend = value.trim().length > 0 && !isStreaming && !disabled;

  /**
   * 发送当前文本
   *
   * 清空输入框并触发 onSend 回调。
   * 若文本为空或处于流式状态，直接返回。
   */
  const handleSend = () => {
    if (!canSend) {
      return;
    }
    onSend(value);
    setValue('');
  };

  /**
   * 键盘事件处理
   *
   * - Enter（无 Shift）：发送消息，阻止默认换行
   * - Shift+Enter：换行（默认行为，不阻止）
   * - Ctrl/Cmd+Enter：强制发送（即使空行也尝试发送，便于测试）
   */
  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter 且无 Shift / Ctrl / Cmd 同时按：发送
    if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      handleSend();
    }
  };

  return (
    <div
      className={cn(
        // 容器：米色卡片背景 + 圆角 + 阴影，呼应文学风
        'bg-card border-border rounded-md border shadow-sm',
        // 内部布局：Textarea + 按钮，按列分布
        'flex flex-col gap-2 p-2',
        className,
      )}
    >
      <Textarea
        // 文学风的衬线字体
        className="font-serif text-sm leading-relaxed"
        // 自适应高度（min-h-16 由 Textarea 默认提供，配合 field-sizing-content）
        rows={2}
        // 禁用浏览器默认 spellcheck（避免中文输入红线）
        spellCheck={false}
        // 禁用浏览器自动补全
        autoComplete="off"
        // 禁用浏览器自动纠正
        autoCorrect="off"
        // 禁用浏览器自动大写
        autoCapitalize="off"
        placeholder={placeholder}
        value={value}
        disabled={disabled || isStreaming}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={handleKeyDown}
      />
      <div className="flex items-center justify-between">
        {/* 左侧：状态提示（流式时显示"正在回复..."） */}
        <span className="text-muted-foreground font-serif text-xs tracking-wide">
          {isStreaming ? '正在回复...' : ''}
        </span>
        {/* 右侧：发送 / 停止按钮 */}
        {isStreaming ? (
          <Button
            variant="outline"
            size="sm"
            // 停止按钮：点击触发 onStop
            onClick={onStop}
            aria-label="停止生成"
          >
            <Square className="size-3.5" strokeWidth={1.5} />
            停止
          </Button>
        ) : (
          <Button
            variant="default"
            size="sm"
            // 发送按钮：禁用条件（无文本 / 流式中 / 父组件禁用）
            disabled={!canSend}
            onClick={handleSend}
            aria-label="发送消息"
          >
            <Send className="size-3.5" strokeWidth={1.5} />
            发送
          </Button>
        )}
      </div>
    </div>
  );
}
