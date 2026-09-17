// src/renderer/components/chat/ChatMessageList.test.tsx
// ChatMessageList 组件逻辑回归（分页渲染窗口 / 滚动定位 / 导航轨 / 流式占位 / 组装层结构）
// ──────────────────────────────────────────────
// 覆盖动机：组件行覆盖 46%/分支 43%——分页窗口边界（loadEarlier / clamp 兜底）、
// 搜索定位（窗口外扩展滚动）、滚动到底按钮、QuestionJumpBar 磁性吸附均无回归锚；
// 另锁定 2026-08 聊天区布局修复（.messages-inner 居中限宽容器必须真实渲染、
// 连续 assistant 消息透传 isContinuation、流式尾条透传 isStreaming）。
//
// 2026-09 结构调整：原顶层版（分页/滚动/导航轨交互）与 __tests__/ 版（组装层
// 结构/props 透传）合并为本文件——MessageItem 用可记录 props 的轻量桩
// （vi.fn + data-testid="mi"），隔离 Markdown/shiki 重依赖，同时支持
// 「透传断言」（mock.calls）与「DOM 标记断言」（data-mid）两类用例。
// ──────────────────────────────────────────────

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { UIMessage } from 'ai';
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { ChatMessageList } from './ChatMessageList';
import { MSG_INDEX_ATTR } from './use-message-nav-rail';

// vi.hoisted：mock 工厂有提升限制，用 hoisted 对象承载可断言的 mock
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
    // jsdom 未实现 scrollTo，组件挂载即调用（自动滚动 effect）
    window.HTMLElement.prototype.scrollTo = vi.fn();
    // 轻量桩：暴露消息 id（data-mid）供 DOM 断言；调用记录供 props 透传断言
    mocks.MessageItem.mockImplementation(({ message }: { message: { id: string } }) => (
      <div data-testid="mi" data-mid={message.id} />
    ));
  });

  // ── 渲染门控与组装层结构 ─────────────────────────────────────

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
    // .messages-inner 必须是 .messages 的直接子元素（CSS 选择器依赖此层级）
    expect(inner?.parentElement).toBe(scroller);
    // 消息渲染在 .messages-inner 内部
    expect(inner?.querySelectorAll('[data-testid="mi"]')).toHaveLength(1);
    // 滚动容器保留 overflow-y-auto
    expect(scroller?.className).toContain('overflow-y-auto');
  });

  it('滚动到底部按钮常驻渲染（初始隐藏）', () => {
    const { container } = renderList(makeMsgs(1));
    const btn = container.querySelector('.scroll-to-bottom') as HTMLButtonElement;
    expect(btn).not.toBeNull();
    expect(btn.className).not.toContain('visible');
  });

  // ── 分页窗口 ────────────────────────────────────────────────

  it('长会话首屏只渲染最近一页（200 条），索引基线与分页提示计数同源', () => {
    const { container } = renderList(makeMsgs(521));
    const items = screen.getAllByTestId('mi');
    expect(items).toHaveLength(200);
    // 窗口起点 321：首条渲染的是索引 321 的消息
    expect(items[0]).toHaveAttribute('data-mid', 'm321');
    // 分页提示（"已加载 200/521"）
    expect(
      screen.getByText(i18n.t('chat.loadedMessages', { count: 200, total: 521 })),
    ).toBeInTheDocument();
    // DOM 层索引基线（data-msg-index）与渲染条数对齐
    const indexes = Array.from(container.querySelectorAll(`[${MSG_INDEX_ATTR}]`)).map((el) =>
      Number(el.getAttribute(MSG_INDEX_ATTR)),
    );
    expect(indexes).toHaveLength(200);
    expect(indexes[0]).toBe(321);
    expect(indexes.at(-1)).toBe(520);
  });

  it('短会话（<200 条）全量渲染，无分页提示', () => {
    renderList(makeMsgs(3));
    expect(screen.getAllByTestId('mi')).toHaveLength(3);
    expect(screen.queryByText(i18n.t('chat.loadedMessages', { count: 3, total: 3 }))).toBeNull();
  });

  it('滚动到顶 → 向上扩展一页（加载更早消息）', async () => {
    const { container } = renderList(makeMsgs(521));
    const scroller = container.querySelector('.messages') as HTMLElement;
    scroller.scrollTop = 0;
    fireEvent.scroll(scroller);

    // 合帧（rAF）后 loadEarlier 生效，窗口起点 321 → 121，渲染 400 条
    await waitFor(() => expect(screen.getAllByTestId('mi')).toHaveLength(400));
    const items = screen.getAllByTestId('mi');
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

  // ── 搜索定位 / 滚动到底按钮 ──────────────────────────────────

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
    // 按钮显隐为 rAF 合帧后生效
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

  // ── 流式占位 ────────────────────────────────────────────────

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

  // ── 消息 props 透传（组装层契约） ────────────────────────────
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
  });

  // ── 导航轨（消息圆点） ──────────────────────────────────────

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

  // ── 单击只跳一次（2026-09 审计修复的回归锚） ──────────────────
  //
  // 背景：条目 button 的 mousedown 未 stopPropagation，会继续冒泡到轨道的
  // onMouseDown；且轨道同时绑了 mousedown 与 click 到同一处理器。于是单击一个
  // 圆点最多触发 3 次 onJump，后续调用打断前一次的 smooth 滚动（落点抖动）。
  // 修复：条目 mousedown 加 stopPropagation，轨道去掉重复的 onClick。

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

    // 只由 mousedown 触发一次（click 已解除绑定）
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
