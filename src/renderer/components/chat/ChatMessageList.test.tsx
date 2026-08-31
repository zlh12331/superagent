// src/renderer/components/chat/ChatMessageList.test.tsx
// ChatMessageList 组件逻辑回归（分页渲染窗口 / 滚动定位 / 导航轨 / 流式占位）
// ──────────────────────────────────────────────
// 覆盖动机：组件行覆盖 46%/分支 43%——分页窗口边界（loadEarlier / clamp 兜底）、
// 搜索定位（窗口外扩展滚动）、滚动到底按钮、QuestionJumpBar 磁性吸附均无回归锚。
// MessageItem（Markdown/shiki 重渲染）与 StreamingFooter 以轻量桩替换：
// 本文件测的是 ChatMessageList 自身的逻辑编排，不是消息渲染内部。
// ──────────────────────────────────────────────

import { fireEvent, render, screen } from '@testing-library/react';
import type { UIMessage } from 'ai';
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { ChatMessageList } from './ChatMessageList';
import { MSG_INDEX_ATTR } from './use-message-nav-rail';

// 轻量桩：只暴露消息 id 与关键 props 透传痕迹，隔离 Markdown/shiki 重依赖
vi.mock('./message-item', () => ({
  // biome-ignore lint/style/useNamingConvention: mock 工厂必须保留组件原名（同名导出）
  MessageItem: ({ message }: { message: { id: string } }): ReactElement => (
    <div data-testid="mi" data-mid={message.id} />
  ),
}));
vi.mock('./streaming-footer', () => ({
  // biome-ignore lint/style/useNamingConvention: mock 工厂必须保留组件原名（同名导出）
  StreamingFooter: (): ReactElement => <div data-testid="streaming-footer" />,
}));

/** 交替 user/assistant 消息（用户消息供导航轨取锚点） */
function makeMsgs(n: number): UIMessage[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `m${i}`,
    role: i % 2 === 0 ? 'user' : 'assistant',
    parts: [{ type: 'text', text: `q${i}` }],
  })) as UIMessage[];
}

const noop = (): void => undefined;

function renderList(
  messages: readonly UIMessage[],
  props: Partial<Parameters<typeof ChatMessageList>[0]> = {},
): ReturnType<typeof render> {
  return render(
    <ChatMessageList messages={messages} status="ready" onRegenerate={noop} {...props} />,
  );
}

describe('ChatMessageList', () => {
  beforeEach(() => {
    window.HTMLElement.prototype.scrollTo = vi.fn();
  });

  it('空消息 → EmptyState，不渲染任何消息行', () => {
    renderList([]);
    expect(screen.queryByTestId('mi')).toBeNull();
    expect(screen.getByText(i18n.t('chat.startNewChat'))).toBeInTheDocument();
  });

  it('长会话首屏只渲染最近一页（200 条），分页提示显示已加载数量', () => {
    renderList(makeMsgs(521));
    const items = screen.getAllByTestId('mi');
    expect(items).toHaveLength(200);
    // 窗口起点 321：首条渲染的是索引 321 的消息
    expect(items[0]).toHaveAttribute('data-mid', 'm321');
    // 分页提示（"已加载 200/521"）
    expect(
      screen.getByText(i18n.t('chat.loadedMessages', { count: 200, total: 521 })),
    ).toBeInTheDocument();
  });

  it('短会话（<200 条）全量渲染，无分页提示', () => {
    renderList(makeMsgs(3));
    expect(screen.getAllByTestId('mi')).toHaveLength(3);
    expect(screen.queryByText(i18n.t('chat.loadedMessages', { count: 3, total: 3 }))).toBeNull();
  });

  it('滚动到顶 → 向上扩展一页（加载更早消息）', () => {
    const { container } = renderList(makeMsgs(521));
    const scroller = container.querySelector('.messages') as HTMLElement;
    scroller.scrollTop = 0;
    fireEvent.scroll(scroller);

    const items = screen.getAllByTestId('mi');
    expect(items).toHaveLength(400);
    expect(items[0]).toHaveAttribute('data-mid', 'm121');
  });

  it('窗口已到开头时滚动到顶不再翻页', () => {
    renderList(makeMsgs(3));
    const scroller = document.querySelector('.messages') as HTMLElement;
    scroller.scrollTop = 0;
    fireEvent.scroll(scroller);
    expect(screen.getAllByTestId('mi')).toHaveLength(3);
  });

  it('会话骤变（消息数变小）→ clamp 兜底不白屏，全量渲染新消息', () => {
    const { rerender } = renderList(makeMsgs(521));
    rerender(<ChatMessageList messages={makeMsgs(3)} status="ready" onRegenerate={noop} />);
    const items = screen.getAllByTestId('mi');
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveAttribute('data-mid', 'm0');
  });

  it('searchActiveIndex 命中窗口内消息 → scrollIntoView + 高亮类', () => {
    const spy = vi.spyOn(window.HTMLElement.prototype, 'scrollIntoView');
    const { container } = renderList(makeMsgs(3), { searchActiveIndex: 1 });
    expect(spy).toHaveBeenCalled();
    const row = container.querySelector(`[${MSG_INDEX_ATTR}="1"]`) as HTMLElement;
    expect(row).toHaveClass('search-highlight');
  });

  it('距底部超过阈值 → 显示滚动到底按钮；点击后隐藏并触发滚动', () => {
    const { container } = renderList(makeMsgs(3));
    const scroller = container.querySelector('.messages') as HTMLElement;
    Object.defineProperty(scroller, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(scroller, 'clientHeight', { value: 100, configurable: true });
    scroller.scrollTop = 500;

    const btn = container.querySelector('.scroll-to-bottom') as HTMLButtonElement;
    fireEvent.scroll(scroller);
    expect(btn).toHaveClass('visible');

    fireEvent.click(btn);
    expect(btn).not.toHaveClass('visible');
    expect(scroller.scrollTo).toHaveBeenCalled();
  });

  it('在底部附近滚动 → 按钮保持隐藏', () => {
    const { container } = renderList(makeMsgs(3));
    const scroller = container.querySelector('.messages') as HTMLElement;
    Object.defineProperty(scroller, 'scrollHeight', { value: 100, configurable: true });
    Object.defineProperty(scroller, 'clientHeight', { value: 100, configurable: true });
    scroller.scrollTop = 0;
    fireEvent.scroll(scroller);

    const btn = container.querySelector('.scroll-to-bottom') as HTMLButtonElement;
    expect(btn).not.toHaveClass('visible');
  });

  it('submitted 状态 → 显示流式占位；streaming 且末条为 assistant → 不显示（防双头像）', () => {
    const { rerender } = renderList(makeMsgs(2), { status: 'submitted' });
    expect(screen.getByTestId('streaming-footer')).toBeInTheDocument();

    // 末条是 assistant（index 1）→ 占位隐藏
    rerender(<ChatMessageList messages={makeMsgs(2)} status="streaming" onRegenerate={noop} />);
    expect(screen.queryByTestId('streaming-footer')).toBeNull();

    // 末条是 user（奇数长度）→ 占位显示
    rerender(<ChatMessageList messages={makeMsgs(3)} status="streaming" onRegenerate={noop} />);
    expect(screen.getByTestId('streaming-footer')).toBeInTheDocument();
  });

  it('用户消息 ≥2 → 显示导航轨；点击锚点滚动到对应消息', () => {
    const spy = vi.spyOn(window.HTMLElement.prototype, 'scrollIntoView');
    const { container } = renderList(makeMsgs(5));

    const bar = container.querySelector('nav.jump-bar') as HTMLElement;
    expect(bar).not.toBeNull();
    const items = bar.querySelectorAll('.jump-item');
    expect(items).toHaveLength(3); // 索引 0/2/4 三条用户消息

    fireEvent.mouseDown(items[1] as HTMLElement);
    expect(spy).toHaveBeenCalled();
  });

  it('导航轨 mousemove → 预览气泡显示最近锚点文本', () => {
    const { container } = renderList(makeMsgs(5));
    const rail = container.querySelector('.jump-scroll') as HTMLElement;

    fireEvent.mouseMove(rail, { clientY: 10 });
    const preview = container.querySelector('.jump-preview');
    expect(preview).not.toBeNull();
    expect(preview?.textContent).toBe('q0');
  });

  it('导航轨 mouseleave → 预览气泡消失', () => {
    const { container } = renderList(makeMsgs(5));
    const rail = container.querySelector('.jump-scroll') as HTMLElement;
    fireEvent.mouseMove(rail, { clientY: 10 });
    expect(container.querySelector('.jump-preview')).not.toBeNull();

    fireEvent.mouseLeave(rail);
    expect(container.querySelector('.jump-preview')).toBeNull();
  });
});
