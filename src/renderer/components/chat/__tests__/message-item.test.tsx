// src/renderer/components/chat/__tests__/message-item.test.tsx
// MessageItem 直测（列表层测试 mock 了 MessageItem，此处补真实渲染护栏）
// ──────────────────────────────────────────────────────────────
// 测试要点：
// 1. ToolCallView：title 会话作用域查找（活跃会话命中 / 跨会话不串扰 / 无记录回退工具名）
// 2. 状态徽章：output-error → chat.statusError 本地化文案
// 3. 渲染结构：user 文本气泡 / assistant 角色行 / reasoning 折叠块
// ──────────────────────────────────────────────────────────────

import { render, screen } from '@testing-library/react';
import type { UIMessage } from 'ai';
import { beforeEach, describe, expect, it } from 'vitest';

import { i18n } from '@/i18n/config';
import { useActiveSessionStore } from '@/stores/persistent/sessions-store';
import { useToolStore } from '@/stores/transient/tool-store';
import { MessageItem } from '../message-item';

const t = i18n.t.bind(i18n);

/** 构造含单个 tool part 的 assistant 消息（AI SDK 静态工具 part 形态） */
function assistantWithTool(part: Record<string, unknown>): UIMessage {
  return {
    id: 'm1',
    role: 'assistant',
    parts: [part],
  } as unknown as UIMessage;
}

/** 向 tool-store 种入一条工具调用（覆盖测试所需的完整 ToolCallItem 字段） */
function seedCall(sessionId: string, id: string, title: string | null): void {
  useToolStore.setState({
    callsBySession: new Map([
      [
        sessionId,
        [
          {
            id,
            sessionId,
            toolName: 'read_file',
            title,
            input: { path: '/a.ts' },
            permission: 'auto',
            status: title === null ? 'pending' : 'success',
            output: null,
            error: null,
            createdAt: Date.now(),
            resolvedAt: null,
          },
        ],
      ],
    ]),
  });
}

describe('MessageItem（直测）', () => {
  beforeEach(() => {
    useActiveSessionStore.setState({ activeSessionId: 'sess-a' });
    useToolStore.setState({ callsBySession: new Map() });
  });

  describe('ToolCallView title 会话作用域', () => {
    it('活跃会话有推送标题：显示标题而非工具名', () => {
      seedCall('sess-a', 'c1', '读取完成');
      render(
        <MessageItem
          message={assistantWithTool({
            type: 'tool-read_file',
            toolCallId: 'c1',
            state: 'output-available',
            input: { path: '/a.ts' },
            output: 'ok',
          })}
          onRegenerate={undefined}
          disableActions={false}
        />,
      );
      expect(screen.getByText('读取完成')).toBeDefined();
      expect(screen.queryByText('read_file')).toBeNull();
    });

    it('跨会话不串扰：其他会话的同 id 调用不命中，回退工具名', () => {
      seedCall('sess-b', 'c1', '别会话的标题');
      render(
        <MessageItem
          message={assistantWithTool({
            type: 'tool-read_file',
            toolCallId: 'c1',
            state: 'output-available',
            input: { path: '/a.ts' },
            output: 'ok',
          })}
          onRegenerate={undefined}
          disableActions={false}
        />,
      );
      expect(screen.queryByText('别会话的标题')).toBeNull();
      expect(screen.getByText('read_file')).toBeDefined();
    });

    it('store 无记录：回退工具名（pending 场景）', () => {
      render(
        <MessageItem
          message={assistantWithTool({
            type: 'tool-read_file',
            toolCallId: 'c-none',
            state: 'input-available',
            input: { path: '/a.ts' },
          })}
          onRegenerate={undefined}
          disableActions={false}
        />,
      );
      expect(screen.getByText('read_file')).toBeDefined();
    });
  });

  it('状态徽章：output-error → chat.statusError 本地化文案', () => {
    render(
      <MessageItem
        message={assistantWithTool({
          type: 'tool-read_file',
          toolCallId: 'c1',
          state: 'output-error',
          input: { path: '/a.ts' },
          errorText: 'boom',
        })}
        onRegenerate={undefined}
        disableActions={false}
      />,
    );
    // 状态徽章文本可能与 error 代码块的标签同文案（'错误'），故按类名精确定位徽章
    expect(document.querySelector('.card-status.error')?.textContent).toBe(t('chat.statusError'));
  });

  it('user 消息：文本气泡渲染', () => {
    const msg = {
      id: 'u1',
      role: 'user',
      parts: [{ type: 'text', text: '你好，帮我看看这个文件' }],
    } as unknown as UIMessage;
    render(<MessageItem message={msg} onRegenerate={undefined} disableActions={false} />);
    expect(screen.getByText('你好，帮我看看这个文件')).toBeDefined();
  });

  it('assistant 消息：角色行（chat.assistant）渲染', () => {
    const msg = {
      id: 'a1',
      role: 'assistant',
      parts: [{ type: 'text', text: '回复内容' }],
    } as unknown as UIMessage;
    render(<MessageItem message={msg} onRegenerate={undefined} disableActions={false} />);
    // 角色行实际渲染 `chat.assistant · 模型名` 拼接文本，用子串匹配
    expect(screen.getByText(t('chat.assistant'), { exact: false })).toBeDefined();
    expect(screen.getByText('回复内容')).toBeDefined();
  });

  it('reasoning part：折叠块标题（chat.thinking）+ 思考文本', () => {
    const msg = {
      id: 'a2',
      role: 'assistant',
      parts: [
        { type: 'reasoning', text: '思考内容…' },
        { type: 'text', text: '结论' },
      ],
    } as unknown as UIMessage;
    render(<MessageItem message={msg} onRegenerate={undefined} disableActions={false} />);
    expect(screen.getByText(t('chat.thinking'))).toBeDefined();
    expect(screen.getByText('思考内容…')).toBeDefined();
  });
});
