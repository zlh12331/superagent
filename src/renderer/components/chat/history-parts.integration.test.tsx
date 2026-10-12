import { render, screen } from '@testing-library/react';
import type { UIMessage } from 'ai';
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n/config';
import { useActiveSessionStore } from '@/stores/persistent/sessions-store';
import { applySettingsSnapshot } from '@/stores/persistent/settings-store';
import { reconstructHistory } from './history-parts';
import { MessageItem } from './message-item';

const t = i18n.t.bind(i18n);

vi.mock('./Markdown', () => ({
  // biome-ignore lint/style/useNamingConvention: mock 工厂必须保留组件原名（同名导出）
  Markdown: ({ content }: { content: string }): ReactElement => <span data-md="">{content}</span>,
}));
vi.mock('./message-actions', () => ({
  // biome-ignore lint/style/useNamingConvention: mock 工厂必须保留组件原名（同名导出）
  MsgActions: (): ReactElement => <div data-testid="msg-actions" />,
}));
vi.mock('./streaming-cursor', () => ({
  // biome-ignore lint/style/useNamingConvention: mock 工厂必须保留组件原名（同名导出）
  StreamingCursor: (): ReactElement => <span data-testid="cursor" />,
}));

/** 持久化消息形态（主进程 messages 表 content 为 part 数组） */
type StoredMsg = { role: string; content: object[] };

function renderHistory(messages: readonly StoredMsg[]) {
  const { messages: uiMessages } = reconstructHistory(messages as never);
  return render(
    <div>
      {uiMessages.map((m: UIMessage) => (
        <MessageItem key={m.id} message={m} onRegenerate={undefined} disableActions={true} />
      ))}
    </div>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  applySettingsSnapshot({});
  useActiveSessionStore.setState({ activeSessionId: null });
});

describe('历史重建 → 渲染（集成）', () => {
  it('正向：落库的富回合（assistant reasoning/tool-call + tool 结果）重建为工具卡', () => {
    const { container } = renderHistory([
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: '先看文件' },
          { type: 'tool-call', toolCallId: 'c1', toolName: 'read_file', input: { path: 'a.ts' } },
          { type: 'text', text: '读完了' },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'c1',
            toolName: 'read_file',
            output: { type: 'text', value: '文件内容' },
          },
        ],
      },
    ]);

    expect(container.querySelectorAll('.msg.assistant')).toHaveLength(1);
    expect(container.querySelectorAll('.msg.user')).toHaveLength(0);
    const card = container.querySelector('.msg-tool');
    expect(card).not.toBeNull();
    expect(screen.getByText('read_file')).toBeDefined();
    expect(container.querySelector('.card-status.success')).not.toBeNull();
    expect(screen.getByText(/"文件内容"/)).toBeDefined();
    expect(screen.getByText('先看文件')).toBeDefined();
    expect(screen.getByText('读完了')).toBeDefined();
  });

  it('回归锚：孤儿工具结果（role=tool 且无配对 tool-call）归 assistant，不进用户气泡', () => {
    const { container } = renderHistory([
      {
        role: 'tool',
        content: [
          { type: 'tool-result', toolCallId: 'orphan', toolName: 'run_command', output: 'ok' },
        ],
      },
    ]);

    expect(container.querySelectorAll('.msg.assistant')).toHaveLength(1);
    expect(container.querySelectorAll('.msg.user')).toHaveLength(0);
    expect(container.querySelector('[class*="tool-card"]')).not.toBeNull();
  });

  it('边界：纯文本历史按角色分流（user 气泡 / assistant 角色行 / system 居中）', () => {
    const { container } = renderHistory([
      { role: 'user', content: [{ type: 'text', text: '你好' }] },
      { role: 'assistant', content: [{ type: 'text', text: '你好，有什么可以帮你的' }] },
      { role: 'system', content: [{ type: 'text', text: '系统提示' }] },
    ]);

    expect(container.querySelectorAll('.msg.user')).toHaveLength(1);
    expect(container.querySelectorAll('.msg.assistant')).toHaveLength(1);
    expect(screen.getByText('系统提示')).toBeDefined();
    expect(screen.getByText(new RegExp(t('chat.assistant')))).toBeDefined();
  });

  it('异常：畸形历史（未知 role / 空 content / 未知 part 类型）不抛错且不产空气泡', () => {
    expect(() =>
      renderHistory([
        { role: 'weird', content: [{ type: 'text', text: '兜底为用户' }] },
        { role: 'assistant', content: [] },
        { role: 'assistant', content: [{ type: 'unknown-part-type', foo: 1 }] },
      ]),
    ).not.toThrow();

    expect(screen.getByText('兜底为用户')).toBeDefined();
  });
});
