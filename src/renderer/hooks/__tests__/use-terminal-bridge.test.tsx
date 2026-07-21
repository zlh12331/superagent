// src/renderer/hooks/__tests__/use-terminal-bridge.test.tsx
// use-terminal-bridge 单元测试
// ──────────────────────────────────────────────────────────────
// 测试要点：
// 1. 挂载时订阅 terminal:event:output / terminal:event:exit
// 2. output 事件：按 \n 切分后追加到 store buffer
//    - 末尾 \n 产生的空字符串应被移除（避免多一个空行）
//    - 无 \n 的部分行直接追加为单独一行
// 3. exit 事件：标记 terminal alive=false
// 4. 卸载时退订所有事件
// 5. window.api 未定义时不报错（SSR 兼容）
// ──────────────────────────────────────────────────────────────

import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useTerminalStore } from '@/stores/transient/terminal-store';
import { useTerminalBridge } from '../use-terminal-bridge';

// ── mock window.api.terminal ────────────────────────────────
//
// 测试需要捕获 subscribe 的回调，并在测试中手动触发以验证行为

// 创建 mock unsubscribe 函数（每个测试重新创建）
let unsubscribeOutputMock: ReturnType<typeof vi.fn>;
let unsubscribeExitMock: ReturnType<typeof vi.fn>;
// 捕获 subscribe 时传入的回调
let outputCallback: ((payload: { terminalId: string; data: string }) => void) | null = null;
let exitCallback:
  | ((payload: { terminalId: string; exitCode: number; signal?: string }) => void)
  | null = null;

describe('useTerminalBridge', () => {
  beforeEach(() => {
    // 重置 store
    useTerminalStore.setState({
      terminals: [],
      activeTerminalId: null,
      buffers: new Map(),
    });

    // 重置捕获的回调
    outputCallback = null;
    exitCallback = null;
    unsubscribeOutputMock = vi.fn();
    unsubscribeExitMock = vi.fn();

    // 注入 window.api.terminal 的 mock 实现
    window.api.terminal = {
      subscribeOutputEvent: vi.fn((cb) => {
        outputCallback = cb;
        return unsubscribeOutputMock;
      }),
      subscribeExitEvent: vi.fn((cb) => {
        exitCallback = cb;
        return unsubscribeExitMock;
      }),
      // 以下方法本测试不使用，仅占位避免类型报错
      create: vi.fn(),
      input: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
    } as never;
  });

  // ── 订阅行为 ──────────────────────────────────────────
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

  // ── output 事件处理：按 \n 切分 ────────────────────────
  describe('output 事件处理', () => {
    it('带末尾 \\n 的 data 切分后移除末尾空字符串', () => {
      renderHook(() => {
        useTerminalBridge();
      });

      // 先注册一个终端（让 store 有对应 terminalId 的 buffer entry）
      useTerminalStore.getState().createTerminal({
        id: 'term-1',
        sessionId: 'session-1',
        title: 'bash',
        pid: null,
        cwd: '/tmp',
        alive: true,
      });

      // 模拟 output 事件：「line1\nline2\n」
      act(() => {
        outputCallback?.({ terminalId: 'term-1', data: 'line1\nline2\n' });
      });

      // 切分后应为 ['line1', 'line2']（末尾空字符串被移除）
      expect(useTerminalStore.getState().buffers.get('term-1')).toEqual(['line1', 'line2']);
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

      expect(useTerminalStore.getState().buffers.get('term-1')).toEqual(['partial line']);
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

      expect(useTerminalStore.getState().buffers.get('term-1')).toEqual([
        'line1',
        'line2',
        'line3',
      ]);
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

      expect(useTerminalStore.getState().buffers.get('term-1')).toEqual(['a', 'b', 'c', 'd']);
    });

    it('对未注册的 terminalId 也能追加（store 容错）', () => {
      renderHook(() => {
        useTerminalBridge();
      });

      act(() => {
        outputCallback?.({ terminalId: 'unknown-id', data: 'hello\n' });
      });

      expect(useTerminalStore.getState().buffers.get('unknown-id')).toEqual(['hello']);
    });
  });

  // ── exit 事件处理：标记 alive=false ───────────────────
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
      useTerminalStore.getState().appendOutput('term-1', ['some output']);

      act(() => {
        exitCallback?.({ terminalId: 'term-1', exitCode: 0 });
      });

      const state = useTerminalStore.getState();
      const term = state.terminals.find((t) => t.id === 'term-1');
      expect(term?.alive).toBe(false);
      // buffer 应保留（用于退出后查看历史）
      expect(state.buffers.get('term-1')).toEqual(['some output']);
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

  // ── window.api 未定义时不报错 ─────────────────────────
  it('window.api 未定义时直接 return（不报错）', () => {
    // 临时移除 window.api
    const originalApi = window.api;
    // biome-ignore lint/suspicious/noExplicitAny: 测试环境需要删除 window 属性
    delete (window as any).api;

    expect(() => {
      renderHook(() => {
        useTerminalBridge();
      });
    }).not.toThrow();

    // 恢复 window.api（避免影响后续测试）
    Object.defineProperty(window, 'api', {
      value: originalApi,
      writable: true,
      configurable: true,
    });
  });
});
