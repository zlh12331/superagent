// src/renderer/components/terminal/TerminalView.test.tsx
// TerminalView xterm 生命周期测试：挂载/历史 buffer/输出订阅过滤/退出标记与
// 输入拦截/onData 转发/ResizeObserver 防抖 resize/卸载清理（xterm 外部库 mock）
import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TerminalMeta } from '@/stores/transient/terminal-store';
import { useTerminalStore } from '@/stores/transient/terminal-store';
import { TerminalView } from './TerminalView';

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
    vi.clearAllMocks();
    MockTerminal.instances = 0;
    roInstances.length = 0;
    useTerminalStore.setState({ terminals: [], buffers: new Map() });
    window.ResizeObserver = FakeResizeObserver as never;
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

  it('历史 buffer 非空：挂载时原样写入（P3：原始 ANSI 字符串）', () => {
    useTerminalStore.setState({
      buffers: new Map([['term-1', 'line1\r\nline2\r\n']]),
    });
    render(<TerminalView session={session} />);
    expect(mockTerm.write).toHaveBeenCalledWith('line1\r\nline2\r\n');
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
