// src/renderer/components/chat/__tests__/ChatMessageList.test.tsx
// ChatMessageList 组装层回归测试
//
// 锁定 2026-08 聊天区布局修复，防止"CSS 已定义但从未渲染"类回归：
// 1. .messages-inner 居中限宽容器必须真实渲染（消息与 820px 输入框对齐）
// 2. 导航轨仅在用户消息 ≥2 条时显示，且最后圆点默认高亮
// 3. 连续 assistant 消息透传 isContinuation；流式尾条透传 isStreaming
// 4. 空列表显示 EmptyState（开始新对话）
// 5. 分页窗口：DOM 层只渲染最近一页，data-msg-index 基线与"已加载 x / y 条"计数同源
//
// MessageItem/StreamingFooter 渲染较重（Markdown/shiki/工具调用），
// 本测试聚焦组装层结构，mock 叶子组件并记录透传 props。

import { render, screen } from '@testing-library/react';
import type { ComponentProps, ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TooltipProvider } from '@/components/ui/tooltip';
import { ChatMessageList } from '../ChatMessageList';

// vi.hoisted：mock 工厂有提升限制，用 hoisted 对象承载可断言的 mock
const mocks = vi.hoisted(() => ({
  // biome-ignore lint/style/useNamingConvention: 保持与模块导出名一致
  MessageItem:
    vi.fn<
      (props: {
        message: { id: string };
        isContinuation?: boolean;
        isStreaming?: boolean;
      }) => ReactElement
    >(),
}));

vi.mock('../message-item', () => ({
  // biome-ignore lint/style/useNamingConvention: 保持与模块导出名一致
  MessageItem: mocks.MessageItem,
}));

vi.mock('../streaming-footer', () => ({
  // biome-ignore lint/style/useNamingConvention: 保持与模块导出名一致
  StreamingFooter: () => <div data-testid="streaming-footer" />,
}));

/** 构造最小消息（组装层只关心 role/id，渲染细节在 mock 内） */
function mkMsg(role: 'user' | 'assistant', id: string) {
  return { id, role, parts: [{ type: 'text', text: `msg-${id}` }] } as never;
}

type Msg = ReturnType<typeof mkMsg>;
type ListProps = ComponentProps<typeof ChatMessageList>;

function renderList(messages: Msg[], props: Partial<ListProps> = {}) {
  return render(
    <TooltipProvider>
      <ChatMessageList messages={messages} status="ready" onRegenerate={undefined} {...props} />
    </TooltipProvider>,
  );
}

describe('ChatMessageList 组装层', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // jsdom 未实现 scrollTo，组件挂载即调用（自动滚动 effect）
    HTMLElement.prototype.scrollTo = vi.fn() as unknown as typeof HTMLElement.prototype.scrollTo;
    mocks.MessageItem.mockImplementation(({ message }) => (
      <div data-testid="message-item" data-id={message.id} />
    ));
  });

  describe('布局容器', () => {
    it('非空列表渲染 .messages > .messages-inner（居中限宽容器真实渲染）', () => {
      const { container } = renderList([mkMsg('user', 'u1')]);
      const scroller = container.querySelector('.messages');
      const inner = container.querySelector('.messages-inner');
      expect(scroller).not.toBeNull();
      expect(inner).not.toBeNull();
      // .messages-inner 必须是 .messages 的直接子元素（CSS 选择器依赖此层级）
      expect(inner?.parentElement).toBe(scroller);
      // 消息渲染在 .messages-inner 内部
      expect(inner?.querySelectorAll('[data-testid="message-item"]')).toHaveLength(1);
      // 滚动容器保留 overflow-y-auto
      expect(scroller?.className).toContain('overflow-y-auto');
    });

    it('空列表不渲染消息容器，显示 EmptyState（开始新对话）', () => {
      const { container } = renderList([]);
      expect(container.querySelector('.messages')).toBeNull();
      expect(screen.getByText('开始新对话')).toBeInTheDocument();
    });

    it('滚动到底部按钮常驻渲染（初始隐藏）', () => {
      renderList([mkMsg('user', 'u1')]);
      const btn = screen.getByLabelText('滚动到底部');
      expect(btn).toBeInTheDocument();
      expect(btn.className).toContain('scroll-to-bottom');
      expect(btn.className).not.toContain('visible');
    });
  });

  describe('导航轨（消息圆点）', () => {
    it('用户消息 <2 条时不显示导航轨', () => {
      renderList([mkMsg('user', 'u1'), mkMsg('assistant', 'a1')]);
      expect(screen.queryByLabelText('消息导航轨')).toBeNull();
    });

    it('用户消息 ≥2 条时显示导航轨，最后圆点默认高亮', () => {
      renderList([
        mkMsg('user', 'u1'),
        mkMsg('assistant', 'a1'),
        mkMsg('user', 'u2'),
        mkMsg('assistant', 'a2'),
      ]);
      expect(screen.getByLabelText('消息导航轨')).toBeInTheDocument();
      // 跳转条（对齐参考项目 QuestionJumpBar）：活跃横条 18px accent、非活跃 12px；
      // jsdom 视口高度 0 → 视口中线 0，全部消息 offsetTop 0 → 活跃 = 最后一条用户消息（第 2 条）
      const dot2 = screen.getByLabelText('跳转到消息 2').querySelector('.jump-dot');
      const dot1 = screen.getByLabelText('跳转到消息 1').querySelector('.jump-dot');
      expect(dot2).toHaveStyle({ width: '18px' });
      expect(dot2).toHaveStyle({ background: 'var(--accent)' });
      expect(dot1).toHaveStyle({ width: '12px' });
    });
  });

  describe('消息 props 透传', () => {
    // 组件挂载 effect 更新活跃圆点会触发一次重渲染，mock 会重复调用；
    // 断言取每个消息 id 的最后一次调用（最终渲染态的 props）
    const propsFor = (id: string) =>
      mocks.MessageItem.mock.calls.filter((c) => c[0].message.id === id).at(-1)?.[0];

    it('连续 assistant 消息透传 isContinuation=true，首条为 false', () => {
      renderList([mkMsg('user', 'u1'), mkMsg('assistant', 'a1'), mkMsg('assistant', 'a2')]);
      expect(propsFor('u1')?.isContinuation).toBeUndefined();
      // 仅续行消息透传 isContinuation=true（组件用条件展开，非续行不传该 prop）
      expect(propsFor('a1')?.isContinuation).toBeUndefined();
      expect(propsFor('a2')?.isContinuation).toBe(true);
    });

    it('streaming 状态：最后一条 assistant 消息透传 isStreaming=true', () => {
      renderList([mkMsg('user', 'u1'), mkMsg('assistant', 'a1')], { status: 'streaming' });
      expect(propsFor('u1')?.isStreaming).toBeUndefined();
      expect(propsFor('a1')?.isStreaming).toBe(true);
      // 最后一条已是 assistant：不显示流式占位（避免双头像）
      expect(screen.queryByTestId('streaming-footer')).toBeNull();
    });

    it('submitted 状态：assistant 尚未输出时显示流式占位', () => {
      renderList([mkMsg('user', 'u1')], { status: 'submitted' });
      expect(screen.getByTestId('streaming-footer')).toBeInTheDocument();
    });
  });

  describe('分页窗口（DOM 层裁剪）', () => {
    // 长会话仅首条为 user：导航轨需 ≥2 条用户消息，避免顺手渲染数百个圆点
    function mkSession(total: number): Msg[] {
      return Array.from({ length: total }, (_, i) =>
        mkMsg(i === 0 ? 'user' : 'assistant', `m${i}`),
      );
    }
    const renderedItems = (container: HTMLElement) =>
      Array.from(container.querySelectorAll('.messages-inner [data-msg-index]')).map((el) =>
        Number(el.getAttribute('data-msg-index')),
      );

    it('500 条会话只渲染最近一页（200 条），索引基线与"已加载 x / y"计数同源', () => {
      const { container } = renderList(mkSession(500));
      const indexes = renderedItems(container);
      expect(indexes).toHaveLength(200);
      expect(indexes[0]).toBe(300);
      expect(indexes.at(-1)).toBe(499);
      // 断言三者对齐：渲染条数、索引基线、分页提示计数
      const hint = screen.getByText(/已加载|Loaded/);
      expect(hint.textContent).toContain(`${indexes.length} / 500`);
    });

    // 越界那帧的判别证据在纯函数用例（message-window.test.ts）：
    // RTL 的 act 会先 flush 重置 effect，渲染层只能断言收敛态
    it('切换到更短会话后仍渲染消息，索引从 0 连续', () => {
      const { container, rerender } = renderList(mkSession(500));
      const short = mkSession(60);
      rerender(
        <TooltipProvider>
          <ChatMessageList messages={short} status="ready" onRegenerate={undefined} />
        </TooltipProvider>,
      );
      const indexes = renderedItems(container);
      expect(indexes).toHaveLength(60);
      expect(indexes[0]).toBe(0);
      expect(indexes.at(-1)).toBe(59);
      expect(screen.queryByText(/已加载|Loaded/)).toBeNull();
    });
  });
});
