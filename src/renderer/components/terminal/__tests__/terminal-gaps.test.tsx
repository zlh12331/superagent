// src/renderer/components/terminal/__tests__/terminal-gaps.test.tsx
// terminal 域批次5 缺口补全：TerminalTabs 交互 + TerminalView xterm 生命周期
//
// 测试要点：
// 1. TerminalTabs：tab 渲染/激活高亮/点击选择/键盘导航/关闭/新建/空列表
// 2. TerminalView：xterm 挂载/历史 buffer/输出订阅过滤/退出标记与输入拦截/
//    onData 转发/ResizeObserver 防抖 resize/卸载清理（xterm 外部库 mock）

import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TerminalMeta } from '@/stores/transient/terminal-store';
import { useTerminalStore } from '@/stores/transient/terminal-store';
import { TerminalTabs } from '../TerminalTabs';
import { TerminalView } from '../TerminalView';

// ── xterm 外部库 mock（项目已有先例：TerminalPanel.test.tsx）──
const { MockTerminal, mockTerm, mockFitAddon, fitAddon } = vi.hoisted(() => {
  const mockTerm = {
    write: vi.fn(),
    onData: vi.fn((_cb: (data: string) => void) => {}),
    loadAddon: vi.fn(),
    open: vi.fn(),
    dispose: vi.fn(),
    cols: 80,
    rows: 24,
  };
  // class 构造返回 mockTerm 对象（new Terminal(...) 得到同一实例）
  class MockTerminalClass {
    static instances = 0;
    constructor() {
      MockTerminalClass.instances += 1;
      // biome-ignore lint/correctness/noConstructorReturn: mock 构造返回共享实例（new 语义）
      return mockTerm as never;
    }
  }
  const mockFitAddon = { fit: vi.fn() };
  // FitAddon 同样需要可 new 的 class
  class MockFitAddonClass {
    constructor() {
      // biome-ignore lint/correctness/noConstructorReturn: mock 构造返回共享实例（new 语义）
      return mockFitAddon as never;
    }
  }
  return {
    ['MockTerminal']: MockTerminalClass,
    mockTerm,
    mockFitAddon: MockFitAddonClass,
    fitAddon: mockFitAddon,
  };
});
vi.mock('@xterm/xterm', () => ({ ['Terminal']: MockTerminal }));
vi.mock('@xterm/addon-fit', () => ({ ['FitAddon']: mockFitAddon }));

/** 可手动触发回调的 ResizeObserver（jsdom 无布局，手动驱动） */
const { roInstances } = vi.hoisted(() => ({
  roInstances: [] as { callback: ResizeObserverCallback }[],
}));
class FakeResizeObserver {
  callback: ResizeObserverCallback;
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    roInstances.push(this);
  }
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

describe('terminal 批次5 缺口补全', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    roInstances.length = 0;
    useTerminalStore.setState({ terminals: [], buffers: new Map() });
    window.ResizeObserver = FakeResizeObserver as never;
  });

  describe('TerminalTabs', () => {
    const terminals: readonly TerminalMeta[] = [
      { id: 't1', sessionId: 's1', title: 'zsh', pid: 1, cwd: '', alive: true, createdAt: 0 },
      { id: 't2', sessionId: 's1', title: '构建任务', pid: 2, cwd: '', alive: false, createdAt: 1 },
    ];

    it('渲染 tab 列表 + 激活高亮 + 标题', () => {
      render(
        <TerminalTabs
          terminals={terminals}
          activeId="t1"
          onSelect={vi.fn()}
          onClose={vi.fn()}
          onAdd={vi.fn()}
        />,
      );
      expect(screen.getByRole('tablist')).toBeDefined();
      const tabs = screen.getAllByRole('tab');
      expect(tabs).toHaveLength(2);
      expect(tabs[0]?.getAttribute('aria-selected')).toBe('true');
      expect(tabs[1]?.getAttribute('aria-selected')).toBe('false');
      expect(screen.getByText('zsh')).toBeDefined();
      expect(screen.getByText('构建任务')).toBeDefined();
    });

    it('点击 tab：触发 onSelect', () => {
      const onSelect = vi.fn();
      render(
        <TerminalTabs
          terminals={terminals}
          activeId="t1"
          onSelect={onSelect}
          onClose={vi.fn()}
          onAdd={vi.fn()}
        />,
      );
      fireEvent.click(screen.getAllByRole('tab')[1] as HTMLElement);
      expect(onSelect).toHaveBeenCalledWith('t2');
    });

    it('键盘 Enter/Space：切换 tab；Delete/Backspace：关闭 tab', () => {
      const onSelect = vi.fn();
      const onClose = vi.fn();
      render(
        <TerminalTabs
          terminals={terminals}
          activeId="t1"
          onSelect={onSelect}
          onClose={onClose}
          onAdd={vi.fn()}
        />,
      );
      const tab = screen.getAllByRole('tab')[1] as HTMLElement;
      fireEvent.keyDown(tab, { key: 'Enter' });
      expect(onSelect).toHaveBeenCalledWith('t2');
      fireEvent.keyDown(tab, { key: ' ' });
      expect(onSelect).toHaveBeenCalledTimes(2);
      fireEvent.keyDown(tab, { key: 'Delete' });
      expect(onClose).toHaveBeenCalledWith('t2');
      fireEvent.keyDown(tab, { key: 'Backspace' });
      expect(onClose).toHaveBeenCalledTimes(2);
    });

    it('点击关闭按钮：onClose 且不触发 onSelect（stopPropagation）', () => {
      const onSelect = vi.fn();
      const onClose = vi.fn();
      render(
        <TerminalTabs
          terminals={terminals}
          activeId="t1"
          onSelect={onSelect}
          onClose={onClose}
          onAdd={vi.fn()}
        />,
      );
      fireEvent.click(screen.getAllByLabelText('关闭终端')[0] as HTMLElement);
      expect(onClose).toHaveBeenCalledWith('t1');
      expect(onSelect).not.toHaveBeenCalled();
    });

    it('点击 + 按钮：触发 onAdd', () => {
      const onAdd = vi.fn();
      render(
        <TerminalTabs
          terminals={terminals}
          activeId={null}
          onSelect={vi.fn()}
          onClose={vi.fn()}
          onAdd={onAdd}
        />,
      );
      fireEvent.click(screen.getByLabelText('新建终端'));
      expect(onAdd).toHaveBeenCalled();
    });

    it('空列表：仅渲染新建按钮', () => {
      render(
        <TerminalTabs
          terminals={[]}
          activeId={null}
          onSelect={vi.fn()}
          onClose={vi.fn()}
          onAdd={vi.fn()}
        />,
      );
      expect(screen.queryAllByRole('tab')).toHaveLength(0);
      expect(screen.getByLabelText('新建终端')).toBeDefined();
    });
  });

  describe('TerminalView', () => {
    const session: TerminalMeta = {
      id: 'term-1',
      sessionId: 's1',
      title: 'zsh',
      pid: 1,
      cwd: '',
      alive: true,
      createdAt: 0,
    };

    beforeEach(() => {
      (window.api as unknown as Record<string, unknown>)['terminal'] = {
        subscribeOutputEvent: vi.fn(() => vi.fn()),
        subscribeExitEvent: vi.fn(() => vi.fn()),
        input: vi.fn(),
        resize: vi.fn(),
      };
    });

    it('挂载：创建 xterm + open + fit + 加载 addon', () => {
      render(<TerminalView session={session} />);
      expect(MockTerminal.instances).toBe(1);
      expect(mockTerm.open).toHaveBeenCalled();
      expect(fitAddon.fit).toHaveBeenCalled();
      expect(mockTerm.loadAddon).toHaveBeenCalled();
    });

    it('历史 buffer 非空：挂载时写入（按行拼接）', () => {
      useTerminalStore.setState({
        buffers: new Map([['term-1', ['line1', 'line2']]]),
      });
      render(<TerminalView session={session} />);
      expect(mockTerm.write).toHaveBeenCalledWith('line1\nline2');
    });

    it('历史 buffer 空：不写入', () => {
      render(<TerminalView session={session} />);
      expect(mockTerm.write).not.toHaveBeenCalled();
    });

    it('output 事件：匹配 terminalId 写入；不匹配过滤', () => {
      render(<TerminalView session={session} />);
      const subscribeOutputEvent = (
        window.api.terminal as unknown as {
          subscribeOutputEvent: ReturnType<typeof vi.fn>;
        }
      ).subscribeOutputEvent;
      const callback = subscribeOutputEvent.mock.calls[0]?.[0] as (p: {
        terminalId: string;
        data: string;
      }) => void;
      callback({ terminalId: 'term-1', data: 'hello' });
      expect(mockTerm.write).toHaveBeenCalledWith('hello');
      callback({ terminalId: 'other', data: 'ignore' });
      expect(mockTerm.write).not.toHaveBeenCalledWith('ignore');
    });

    it('exit 事件：追加退出提示；退出后输入被拦截', () => {
      render(<TerminalView session={session} />);
      const subscribeExitEvent = (
        window.api.terminal as unknown as {
          subscribeExitEvent: ReturnType<typeof vi.fn>;
        }
      ).subscribeExitEvent;
      const exitCb = subscribeExitEvent.mock.calls[0]?.[0] as (p: {
        terminalId: string;
        exitCode: number;
      }) => void;
      act(() => exitCb({ terminalId: 'term-1', exitCode: 0 }));
      expect(mockTerm.write).toHaveBeenCalledWith(expect.stringContaining('exit code: 0'));

      // onData 回调注册后触发（已退出 → 不发送 input）
      const onDataCb = mockTerm.onData.mock.calls[0]?.[0] as (data: string) => void;
      act(() => onDataCb('ls'));
      expect(window.api.terminal.input).not.toHaveBeenCalled();
    });

    it('onData：未退出时转发 input IPC', () => {
      render(<TerminalView session={session} />);
      const onDataCb = mockTerm.onData.mock.calls[0]?.[0] as (data: string) => void;
      act(() => onDataCb('ls\r'));
      expect(window.api.terminal.input).toHaveBeenCalledWith({
        terminalId: 'term-1',
        data: 'ls\r',
      });
    });

    it('ResizeObserver 触发：防抖后 fit + resize IPC', async () => {
      vi.useFakeTimers();
      try {
        render(<TerminalView session={session} />);
        expect(roInstances).toHaveLength(1);
        act(() => {
          roInstances[0]?.callback([], roInstances[0] as never);
        });
        vi.advanceTimersByTime(100);
        await act(async () => {});
        expect(fitAddon.fit).toHaveBeenCalled();
        expect(window.api.terminal.resize).toHaveBeenCalledWith({
          terminalId: 'term-1',
          cols: 80,
          rows: 24,
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it('卸载：取消订阅 + dispose + 清定时器', () => {
      const unsubscribeOutput = vi.fn();
      const unsubscribeExit = vi.fn();
      (window.api.terminal as unknown as Record<string, unknown>)['subscribeOutputEvent'] = vi.fn(
        () => unsubscribeOutput,
      );
      (window.api.terminal as unknown as Record<string, unknown>)['subscribeExitEvent'] = vi.fn(
        () => unsubscribeExit,
      );
      const { unmount } = render(<TerminalView session={session} />);
      unmount();
      expect(unsubscribeOutput).toHaveBeenCalled();
      expect(unsubscribeExit).toHaveBeenCalled();
      expect(mockTerm.dispose).toHaveBeenCalled();
    });

    it('alive=false：显示已结束标识', () => {
      render(<TerminalView session={{ ...session, alive: false }} />);
      expect(screen.getByText('已结束')).toBeDefined();
    });
  });
});
