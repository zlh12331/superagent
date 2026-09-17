// src/renderer/components/chat/__tests__/history-render.integration.test.tsx
// 历史重建 → 消息渲染 跨模块集成测试（正向 / 边界 / 异常）
// ──────────────────────────────────────────────────────────────
// 覆盖此前无测试的真实链路：主进程落库的 ChatMessage[]（含 role='tool' 的工具
// 结果消息）→ reconstructHistory 重建 UI part → MessageItem 真实渲染
// → 断言**角色归属与组件分发**都正确（工具卡不能落进用户气泡）。
//
// 为什么需要这层：history-parts.test.ts 只断言 parts 形态（不碰 role 归属），
// message-item.test.tsx 只喂手工构造的 UIMessage（不碰重建）。中间那段
// 「重建产出的 role 决定走哪个渲染分支」正是 2026-09 修复的缺陷所在
// （role='tool' 曾兜底成 'user'，孤儿工具卡被渲染进用户气泡），单测各自都覆盖不到。
//
// mock 边界：Markdown/shiki 属重依赖（wasm + 语言包），替换为轻量桩——本测试测的是
// 「角色 → 渲染分支 → 工具卡形态」，不是语法高亮。store/IPC 走真实实现。
// ──────────────────────────────────────────────────────────────

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

// Markdown 桩：文本可断言，跳过 shiki/wasm 重依赖
vi.mock('./Markdown', () => ({
  // biome-ignore lint/style/useNamingConvention: mock 工厂必须保留组件原名（同名导出）
  Markdown: ({ content }: { content: string }): ReactElement => <span data-md="">{content}</span>,
}));
// 操作行桩（本测试不涉及复制/重生成）
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

    // assistant 分支：推理块 + 工具卡 + 文本都在同一条 assistant 消息内。
    // 注意工具卡自身也带 .msg（tool-call-view 的 .msg.msg-tool 包装），
    // 故这里断言「消息级」容器 .msg.assistant 与 .msg.user 的条数。
    expect(container.querySelectorAll('.msg.assistant')).toHaveLength(1);
    // tool 消息的配对结果被合并进工具卡 → 不产生第二条消息（无 user 气泡）
    expect(container.querySelectorAll('.msg.user')).toHaveLength(0);
    // 工具卡真实渲染（ToolCallView 走真实实现），标题回退工具名
    const card = container.querySelector('.msg-tool');
    expect(card).not.toBeNull();
    expect(screen.getByText('read_file')).toBeDefined();
    // 关键集成信号：配对的 tool-result 已合并 → 卡片呈成功态（而非停在 running）
    expect(container.querySelector('.card-status.success')).not.toBeNull();
    // 输出内容经 CodeBlock 以 JSON 序列化呈现
    expect(screen.getByText(/"文件内容"/)).toBeDefined();
    expect(screen.getByText('先看文件')).toBeDefined();
    expect(screen.getByText('读完了')).toBeDefined();
  });

  it('回归锚：孤儿工具结果（role=tool 且无配对 tool-call）归 assistant，不进用户气泡', () => {
    // 主进程把工具结果落成独立的 role='tool' 消息（turn-transcript）。
    // 配对条目会被合并掉，只有孤儿留在这里——它**不是用户发言**。
    const { container } = renderHistory([
      {
        role: 'tool',
        content: [
          { type: 'tool-result', toolCallId: 'orphan', toolName: 'run_command', output: 'ok' },
        ],
      },
    ]);

    // 关键断言：渲染成 assistant（工具卡），而不是 user 气泡
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
    // assistant 角色行展示「助手 · 模型」
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

    // 未知 role → 兜底 user；空 content / 未知 part 的消息整体跳过（无空气泡）
    expect(screen.getByText('兜底为用户')).toBeDefined();
  });
});
