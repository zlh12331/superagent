import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { UIMessage } from 'ai';
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { ChatMessageList } from './ChatMessageList';
import { MSG_INDEX_ATTR } from './use-message-nav-rail';

const mocks = vi.hoisted(() => ({
  // biome-ignore lint/style/useNamingConvention: mock 工厂必须保留组件原名（同名导出）
  MessageItem:
    vi.fn<
      (props: {
        message: { id: string };
        isContinuation?: boolean;
        isStreaming?: boolean;
      }) => ReactElement
    >(),
}));

vi.mock('./message-item', () => ({
  // biome-ignore lint/style/useNamingConvention: mock 工厂必须保留组件原名（同名导出）
  MessageItem: mocks.MessageItem,
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

/** 显式指定角色的最小消息（props 透传用例需要连续 assistant 的精确排布） */
function mkMsg(role: 'user' | 'assistant', id: string): UIMessage {
  return { id, role, parts: [{ type: 'text', text: `msg-${id}` }] } as UIMessage;
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
    vi.clearAllMocks();
    window.HTMLElement.prototype.scrollTo = vi.fn();
    mocks.MessageItem.mockImplementation(({ message }: { message: { id: string } }) => (
      <div data-testid="mi" data-mid={message.id} />
    ));
  });

  it('空消息 → EmptyState，不渲染任何消息行', () => {
    const { container } = renderList([]);
    expect(screen.queryByTestId('mi')).toBeNull();
    expect(container.querySelector('.messages')).toBeNull();
    expect(screen.getByText(i18n.t('chat.startNewChat'))).toBeInTheDocument();
  });

  it('非空列表渲染 .messages > .messages-inner（居中限宽容器真实渲染）', () => {
    const { container } = renderList(makeMsgs(1));
    const scroller = container.querySelector('.messages');
    const inner = container.querySelector('.messages-inner');
    expect(scroller).not.toBeNull();
    expect(inner).not.toBeNull();
    expect(inner?.parentElement).toBe(scroller);
    expect(inner?.querySelectorAll('[data-testid="mi"]')).toHaveLength(1);
    expect(scroller?.className).toContain('overflow-y-auto');
  });

  it('滚动到底部按钮常驻渲染（初始隐藏）', () => {
    const { container } = renderList(makeMsgs(1));
    const btn = container.querySelector('.scroll-to-bottom') as HTMLButtonElement;
    expect(btn).not.toBeNull();
    expect(btn.className).not.toContain('visible');
  });

  it('已加载消息全量渲染；hasEarlier 时顶部提示已加载数', () => {
    const { container } = renderList(makeMsgs(521), { hasEarlier: true });
    expect(screen.getAllByTestId('mi')).toHaveLength(521);
    expect(screen.getByText(i18n.t('chat.loadedMessages', { count: 521 }))).toBeInTheDocument();
    const indexes = Array.from(container.querySelectorAll(`[${MSG_INDEX_ATTR}]`)).map((el) =>
      Number(el.getAttribute(MSG_INDEX_ATTR)),
    );
    expect(indexes).toHaveLength(521);
    expect(indexes[0]).toBe(0);
    expect(indexes.at(-1)).toBe(520);
  });

  it('无更早回合（hasEarlier 缺省）→ 全量渲染且无提示', () => {
    renderList(makeMsgs(3));
    expect(screen.getAllByTestId('mi')).toHaveLength(3);
    expect(screen.queryByText(i18n.t('chat.loadedMessages', { count: 3 }))).toBeNull();
  });

  it('滚动到顶 → 触发 onLoadEarlier（rAF 合帧，一次）', async () => {
    const onLoadEarlier = vi.fn();
    const { container } = renderList(makeMsgs(30), { hasEarlier: true, onLoadEarlier });
    const scroller = container.querySelector('.messages') as HTMLElement;
    scroller.scrollTop = 0;
    fireEvent.scroll(scroller);
    await waitFor(() => expect(onLoadEarlier).toHaveBeenCalledTimes(1));
  });

  it('loadingEarlier 中 → 顶部加载指示，且不重复触发补页', async () => {
    const onLoadEarlier = vi.fn();
    const { container } = renderList(makeMsgs(30), {
      hasEarlier: true,
      loadingEarlier: true,
      onLoadEarlier,
    });
    expect(screen.getByText(i18n.t('chat.loadingEarlier'))).toBeInTheDocument();
    const scroller = container.querySelector('.messages') as HTMLElement;
    scroller.scrollTop = 0;
    fireEvent.scroll(scroller);
    await waitFor(() => {
      expect(Number(scroller.scrollTop)).toBe(0);
    });
    expect(onLoadEarlier).not.toHaveBeenCalled();
  });

  it('无更早回合时滚动到顶不触发补页', async () => {
    const onLoadEarlier = vi.fn();
    const { container } = renderList(makeMsgs(3), { onLoadEarlier });
    const scroller = container.querySelector('.messages') as HTMLElement;
    scroller.scrollTop = 0;
    fireEvent.scroll(scroller);
    await waitFor(() => {
      expect(Number(scroller.scrollTop)).toBe(0);
    });
    expect(onLoadEarlier).not.toHaveBeenCalled();
  });

  it('会话骤变（消息数变小）→ 全量渲染新消息，索引从 0 起算', () => {
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

  it('距底部超过阈值 → 显示滚动到底按钮；点击后隐藏并触发滚动', async () => {
    const { container } = renderList(makeMsgs(3));
    const scroller = container.querySelector('.messages') as HTMLElement;
    Object.defineProperty(scroller, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(scroller, 'clientHeight', { value: 100, configurable: true });
    scroller.scrollTop = 500;

    const btn = container.querySelector('.scroll-to-bottom') as HTMLButtonElement;
    fireEvent.scroll(scroller);
    await waitFor(() => expect(btn).toHaveClass('visible'));

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

    rerender(<ChatMessageList messages={makeMsgs(2)} status="streaming" onRegenerate={noop} />);
    expect(screen.queryByTestId('streaming-footer')).toBeNull();

    rerender(<ChatMessageList messages={makeMsgs(3)} status="streaming" onRegenerate={noop} />);
    expect(screen.getByTestId('streaming-footer')).toBeInTheDocument();
  });

  describe('消息 props 透传', () => {
    const propsFor = (id: string) =>
      mocks.MessageItem.mock.calls.filter((c) => c[0].message.id === id).at(-1)?.[0];

    it('连续 assistant 消息透传 isContinuation=true，首条为 false', () => {
      renderList([mkMsg('user', 'u1'), mkMsg('assistant', 'a1'), mkMsg('assistant', 'a2')]);
      expect(propsFor('u1')?.isContinuation).toBeUndefined();
      expect(propsFor('a1')?.isContinuation).toBeUndefined();
      expect(propsFor('a2')?.isContinuation).toBe(true);
    });

    it('streaming 状态：最后一条 assistant 消息透传 isStreaming=true', () => {
      renderList([mkMsg('user', 'u1'), mkMsg('assistant', 'a1')], { status: 'streaming' });
      expect(propsFor('u1')?.isStreaming).toBeUndefined();
      expect(propsFor('a1')?.isStreaming).toBe(true);
      expect(screen.queryByTestId('streaming-footer')).toBeNull();
    });
  });

  it('用户消息 ≥2 → 显示导航轨；点击锚点滚动到对应消息', () => {
    const spy = vi.spyOn(window.HTMLElement.prototype, 'scrollIntoView');
    const { container } = renderList(makeMsgs(5));

    const bar = container.querySelector('nav.jump-bar') as HTMLElement;
    expect(bar).not.toBeNull();
    const items = bar.querySelectorAll('.jump-item');
    expect(items).toHaveLength(3);

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

  it('点击锚点：onJump 只触发一次（不因冒泡重复跳转）', () => {
    const spy = vi.spyOn(window.HTMLElement.prototype, 'scrollIntoView');
    const { container } = renderList(makeMsgs(5));

    const items = container.querySelectorAll('.jump-item');
    spy.mockClear();
    fireEvent.mouseDown(items[1] as HTMLElement);

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('轨道空白区点击：也只听一次（mousedown 与 click 不再重复绑定）', () => {
    const spy = vi.spyOn(window.HTMLElement.prototype, 'scrollIntoView');
    const { container } = renderList(makeMsgs(5));
    const rail = container.querySelector('.jump-scroll') as HTMLElement;

    spy.mockClear();
    fireEvent.mouseDown(rail, { clientY: 10 });
    fireEvent.click(rail, { clientY: 10 });

    expect(spy).toHaveBeenCalledTimes(1);
  });
});
