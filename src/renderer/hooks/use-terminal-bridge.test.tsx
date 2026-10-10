import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useTerminalStore } from '@/stores/transient/terminal-store';
import { useTerminalBridge } from './use-terminal-bridge';

let unsubscribeOutputMock: ReturnType<typeof vi.fn>;
let unsubscribeExitMock: ReturnType<typeof vi.fn>;
let outputCallback: ((payload: { terminalId: string; data: string }) => void) | null = null;
let exitCallback:
  | ((payload: { terminalId: string; exitCode: number; signal?: string }) => void)
  | null = null;

describe('useTerminalBridge', () => {
  beforeEach(() => {
    useTerminalStore.setState({
      terminals: [],
      activeTerminalId: null,
      buffers: new Map(),
    });

    outputCallback = null;
    exitCallback = null;
    unsubscribeOutputMock = vi.fn();
    unsubscribeExitMock = vi.fn();

    window.api.terminal = {
      subscribeOutputEvent: vi.fn((cb) => {
        outputCallback = cb;
        return unsubscribeOutputMock;
      }),
      subscribeExitEvent: vi.fn((cb) => {
        exitCallback = cb;
        return unsubscribeExitMock;
      }),
      create: vi.fn(),
      input: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
    } as never;
  });

  it('挂载时订阅 output 和 exit 事件', () => {
    renderHook(() => {
      useTerminalBridge();
    });

    expect(window.api.terminal.subscribeOutputEvent).toHaveBeenCalledTimes(1);
    expect(window.api.terminal.subscribeExitEvent).toHaveBeenCalledTimes(1);
  });

  it('卸载时退订所有事件', () => {
    const { unmount } = renderHook(() => {
      useTerminalBridge();
    });

    unmount();

    expect(unsubscribeOutputMock).toHaveBeenCalledTimes(1);
    expect(unsubscribeExitMock).toHaveBeenCalledTimes(1);
  });

  describe('output 事件处理', () => {
    it('带末尾 \\n 的 data 切分后移除末尾空字符串', () => {
      renderHook(() => {
        useTerminalBridge();
      });

      useTerminalStore.getState().createTerminal({
        id: 'term-1',
        sessionId: 'session-1',
        title: 'bash',
        pid: null,
        cwd: '/tmp',
        alive: true,
      });

      act(() => {
        outputCallback?.({ terminalId: 'term-1', data: 'line1\nline2\n' });
      });

      expect(useTerminalStore.getState().buffers.get('term-1')).toBe('line1\nline2\n');
    });

    it('不带 \\n 的部分行直接追加为单独一行', () => {
      renderHook(() => {
        useTerminalBridge();
      });

      useTerminalStore.getState().createTerminal({
        id: 'term-1',
        sessionId: 'session-1',
        title: 'bash',
        pid: null,
        cwd: '/tmp',
        alive: true,
      });

      act(() => {
        outputCallback?.({ terminalId: 'term-1', data: 'partial line' });
      });

      expect(useTerminalStore.getState().buffers.get('term-1')).toBe('partial line');
    });

    it('多次 output 事件追加到同一 buffer', () => {
      renderHook(() => {
        useTerminalBridge();
      });

      useTerminalStore.getState().createTerminal({
        id: 'term-1',
        sessionId: 'session-1',
        title: 'bash',
        pid: null,
        cwd: '/tmp',
        alive: true,
      });

      act(() => {
        outputCallback?.({ terminalId: 'term-1', data: 'line1\n' });
        outputCallback?.({ terminalId: 'term-1', data: 'line2\n' });
        outputCallback?.({ terminalId: 'term-1', data: 'line3' });
      });

      expect(useTerminalStore.getState().buffers.get('term-1')).toBe('line1\nline2\nline3');
    });

    it('多行 data 一次追加', () => {
      renderHook(() => {
        useTerminalBridge();
      });

      useTerminalStore.getState().createTerminal({
        id: 'term-1',
        sessionId: 'session-1',
        title: 'bash',
        pid: null,
        cwd: '/tmp',
        alive: true,
      });

      act(() => {
        outputCallback?.({ terminalId: 'term-1', data: 'a\nb\nc\nd\n' });
      });

      expect(useTerminalStore.getState().buffers.get('term-1')).toBe('a\nb\nc\nd\n');
    });

    it('对未注册的 terminalId 也能追加（store 容错）', () => {
      renderHook(() => {
        useTerminalBridge();
      });

      act(() => {
        outputCallback?.({ terminalId: 'unknown-id', data: 'hello\n' });
      });

      expect(useTerminalStore.getState().buffers.get('unknown-id')).toBe('hello\n');
    });
  });

  describe('exit 事件处理', () => {
    it('标记 terminal alive=false（保留 buffer）', () => {
      renderHook(() => {
        useTerminalBridge();
      });

      useTerminalStore.getState().createTerminal({
        id: 'term-1',
        sessionId: 'session-1',
        title: 'bash',
        pid: null,
        cwd: '/tmp',
        alive: true,
      });
      useTerminalStore.getState().appendOutput('term-1', 'some output');

      act(() => {
        exitCallback?.({ terminalId: 'term-1', exitCode: 0 });
      });

      const state = useTerminalStore.getState();
      const term = state.terminals.find((t) => t.id === 'term-1');
      expect(term?.alive).toBe(false);
      expect(state.buffers.get('term-1')).toBe('some output');
    });

    it('非零 exitCode 也标记 alive=false', () => {
      renderHook(() => {
        useTerminalBridge();
      });

      useTerminalStore.getState().createTerminal({
        id: 'term-1',
        sessionId: 'session-1',
        title: 'bash',
        pid: null,
        cwd: '/tmp',
        alive: true,
      });

      act(() => {
        exitCallback?.({ terminalId: 'term-1', exitCode: 1, signal: 'SIGTERM' });
      });

      const term = useTerminalStore.getState().terminals.find((t) => t.id === 'term-1');
      expect(term?.alive).toBe(false);
    });
  });

  it('window.api 未定义时直接 return（不报错）', () => {
    const originalApi = window.api;
    // biome-ignore lint/suspicious/noExplicitAny: 测试环境需要删除 window 属性
    delete (window as any).api;

    expect(() => {
      renderHook(() => {
        useTerminalBridge();
      });
    }).not.toThrow();

    Object.defineProperty(window, 'api', {
      value: originalApi,
      writable: true,
      configurable: true,
    });
  });
});
