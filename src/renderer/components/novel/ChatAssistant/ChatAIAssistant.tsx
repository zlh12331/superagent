// src/renderer/components/novel/ChatAssistant/ChatAIAssistant.tsx
// AI 对话面板组件
// ──────────────────────────────────────────────────────────────
// 职责：
// - 聊天界面
// - 卡片式消息渲染（角色卡/大纲卡/设定卡）
// - 支持发送消息（占位，实际 AI 调用待 Agent 集成）
// ──────────────────────────────────────────────────────────────

import { SendHorizonal } from 'lucide-react';
import { type ReactElement, useCallback, useRef, useState } from 'react';

import { ScrollArea } from '@/components/ui/scroll-area';

interface ChatAIAssistantProps {
  projectId: string;
}

interface Message {
  role: 'user' | 'assistant';
  content: string;
  cards?: Array<{
    type: 'character' | 'outline' | 'world-setting';
    data: Record<string, unknown>;
  }>;
}

export function ChatAIAssistant({ projectId: _projectId }: ChatAIAssistantProps): ReactElement {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);

  const handleSend = useCallback(() => {
    const text = input.trim();
    if (!text) return;

    const userMsg: Message = { role: 'user', content: text };
    setMessages((prev) => [...prev, userMsg]);
    setInput('');

    // 模拟 AI 回复（实际 Agent 集成后替换）
    setTimeout(() => {
      const aiMsg: Message = {
        role: 'assistant',
        content: 'AI 助手功能开发中，敬请期待。',
      };
      setMessages((prev) => [...prev, aiMsg]);
    }, 500);
  }, [input]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  return (
    <div className="flex h-full flex-col">
      {/* 顶栏 */}
      <div className="border-b px-3 py-2">
        <span className="text-xs font-medium">AI 对话</span>
      </div>

      {/* 消息列表 */}
      <ScrollArea className="flex-1">
        <div className="flex flex-col gap-2 p-3">
          {messages.length === 0 && (
            <p className="text-muted-foreground py-8 text-center text-xs">
              AI 助手可以帮你续写、润色、获取灵感
            </p>
          )}

          {messages.map((msg, idx) => (
            <div
              key={idx}
              className={`flex flex-col ${msg.role === 'user' ? 'items-end' : 'items-start'}`}
            >
              <div
                className={`max-w-[85%] rounded-lg px-3 py-2 text-xs ${
                  msg.role === 'user'
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-secondary text-secondary-foreground'
                }`}
              >
                {msg.content}
              </div>

              {/* 卡片渲染 */}
              {msg.cards && msg.cards.length > 0 && (
                <div className="mt-1 flex flex-col gap-1">
                  {msg.cards.map((card, cardIdx) => (
                    <CardPreview key={cardIdx} card={card} />
                  ))}
                </div>
              )}
            </div>
          ))}
          <div ref={bottomRef} />
        </div>
      </ScrollArea>

      {/* 输入区 */}
      <div className="flex items-center gap-2 border-t px-3 py-2">
        <textarea
          className="border-input bg-background text-foreground placeholder:text-muted-foreground min-h-[32px] flex-1 resize-none rounded-md border px-2 py-1.5 text-xs outline-none"
          placeholder="输入消息..."
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          rows={1}
        />
        <button
          type="button"
          className="text-muted-foreground hover:text-foreground rounded p-1 transition-colors disabled:opacity-30"
          onClick={handleSend}
          disabled={!input.trim()}
        >
          <SendHorizonal className="size-4" />
        </button>
      </div>
    </div>
  );
}

/**
 * 卡片预览组件
 *
 * 根据卡片类型渲染不同的结构卡片：
 * - character: 角色卡
 * - outline: 大纲卡
 * - world-setting: 设定卡
 */
function CardPreview({ card }: { card: NonNullable<Message['cards']>[number] }): ReactElement {
  const labelMap = {
    character: '角色卡',
    outline: '大纲卡',
    'world-setting': '设定卡',
  } as const;

  const colorMap = {
    character: 'border-l-blue-400',
    outline: 'border-l-amber-400',
    'world-setting': 'border-l-green-400',
  } as const;

  return (
    <div
      className={`bg-card text-card-foreground w-[200px] rounded border border-l-2 ${colorMap[card.type]} px-2.5 py-1.5 text-xs`}
    >
      <div className="text-muted-foreground mb-0.5 text-[10px] font-medium">
        {labelMap[card.type]}
      </div>
      {card.type === 'character' && typeof card.data['name'] === 'string' && (
        <span className="font-medium">{card.data['name'] as string}</span>
      )}
      {card.type === 'outline' && typeof card.data['title'] === 'string' && (
        <span>{card.data['title'] as string}</span>
      )}
      {card.type === 'world-setting' && typeof card.data['title'] === 'string' && (
        <span>{card.data['title'] as string}</span>
      )}
    </div>
  );
}

export default ChatAIAssistant;
