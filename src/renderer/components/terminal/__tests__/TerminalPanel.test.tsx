// src/renderer/components/terminal/__tests__/TerminalPanel.test.tsx
// TerminalPanel 组件测试
// ──────────────────────────────────────────────────────────────
// 测试要点：
// 1. 无终端时渲染「新建终端」按钮
// 2. 点击「新建终端」按钮 → 调用 IPC create + 写入 store
// 3. 创建中状态：按钮禁用 + 显示「创建中...」
// 4. IPC create 返回 error → toast 提示
// 5. 有终端时渲染工具栏（标题 + 关闭按钮）
// 6. 点击关闭按钮 → 调用 IPC kill + 移除 store
// 7. 终端已结束时显示「已结束」标识
//
// 注意：
// - xterm.js 在 jsdom 中无法渲染（依赖 canvas），通过 mock Terminal + FitAddon 跳过
// - 测试聚焦于组件交互逻辑（按钮点击、store 同步），不测试 xterm 内部渲染
// ──────────────────────────────────────────────────────────────

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── mock xterm.js（避免 jsdom canvas 报错） ──────────────────
//
// Terminal 实例方法都是 no-op，只保证调用不抛错
// 使用 class 形式确保 new Terminal() 能正常构造（vi.fn().mockImplementation 不被视为 constructor）
vi.mock('@xterm/xterm', () => {
  class MockTerminal {
    cols = 80;
    rows = 24;
    loadAddon = vi.fn();
    open = vi.fn();
    write = vi.fn();
    onData = vi.fn();
    dispose = vi.fn();
  }
  // biome-ignore lint/style/useNamingConvention: 保持与 xterm.js 模块导出名一致
  return { Terminal: MockTerminal };
});

vi.mock('@xterm/addon-fit', () => {
  class MockFitAddon {
    fit = vi.fn();
  }
  // biome-ignore lint/style/useNamingConvention: 保持与 addon-fit 模块导出名一致
  return { FitAddon: MockFitAddon };
});

// ── mock toast（sonner） ────────────────────────────────────
//
// 不依赖 sonner 实际实现，仅验证是否被调用
// vi.hoisted 确保 mock 变量在 vi.mock factory 执行前完成初始化
const { mockToastError } = vi.hoisted(() => ({
  mockToastError: vi.fn(),
}));
vi.mock('sonner', () => ({
  toast: {
    error: mockToastError,
  },
}));

import { useTerminalStore } from '@/stores/transient/terminal-store';
import { TerminalPanel } from '../TerminalPanel';

describe('TerminalPanel', () => {
  beforeEach(() => {
    // 重置 store
    useTerminalStore.setState({
      terminals: [],
      activeTerminalId: null,
      buffers: new Map(),
    });

    // 重置 mock
    vi.clearAllMocks();

    // 重置 window.api.terminal（每个测试按需重新设置）
    window.api.terminal = {
      create: vi.fn(),
      kill: vi.fn(),
      input: vi.fn(),
      resize: vi.fn(),
      subscribeOutputEvent: vi.fn(() => () => {}),
      subscribeExitEvent: vi.fn(() => () => {}),
    } as never;
  });

  // ── 无终端时显示「新建终端」按钮 ───────────────────────
  describe('无终端状态', () => {
    it('渲染「新建终端」按钮', () => {
      render(<TerminalPanel sessionId="session-1" />);

      expect(screen.getByText('新建终端')).toBeInTheDocument();
    });

    it('点击「新建终端」按钮 → 调用 IPC create + 写入 store', async () => {
      const user = userEvent.setup();
      (window.api.terminal.create as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: { terminalId: 'term-1' },
      });

      render(<TerminalPanel sessionId="session-1" />);
      await user.click(screen.getByText('新建终端'));

      // 验证 IPC 调用参数
      expect(window.api.terminal.create).toHaveBeenCalledWith({
        cwd: 'f:\\TraeProjects\\1',
        command: undefined,
        env: undefined,
        cols: 80,
        rows: 24,
      });

      // 验证 store 写入
      await waitFor(() => {
        const state = useTerminalStore.getState();
        expect(state.terminals).toHaveLength(1);
        expect(state.terminals[0]?.id).toBe('term-1');
        expect(state.terminals[0]?.sessionId).toBe('session-1');
        expect(state.terminals[0]?.alive).toBe(true);
      });
    });

    it('创建中显示终端光标动画并禁用按钮', async () => {
      const user = userEvent.setup();
      // 让 create 永远 pending（不 resolve）
      (window.api.terminal.create as ReturnType<typeof vi.fn>).mockImplementation(
        () => new Promise(() => {}),
      );

      render(<TerminalPanel sessionId="session-1" />);
      await user.click(screen.getByText('新建终端'));

      // 创建中：按钮禁用 + 终端光标动画（loading-ui，role=status，sr-only 文本 Loading）
      const button = screen.getByRole('button', { name: /Loading/ });
      expect(button).toBeDisabled();
      expect(screen.getByRole('status')).toBeInTheDocument();
    });

    it('IPC create 返回 error → toast.error 提示', async () => {
      const user = userEvent.setup();
      (window.api.terminal.create as ReturnType<typeof vi.fn>).mockResolvedValue({
        error: { code: 'PTY_ERROR', message: 'Failed to spawn' },
      });

      render(<TerminalPanel sessionId="session-1" />);
      await user.click(screen.getByText('新建终端'));

      await waitFor(() => {
        expect(mockToastError).toHaveBeenCalledWith('创建终端失败: [PTY_ERROR] Failed to spawn');
      });

      // 创建失败后 store 应未写入
      expect(useTerminalStore.getState().terminals).toHaveLength(0);
    });

    it('IPC create 抛异常 → toast.error 提示', async () => {
      const user = userEvent.setup();
      (window.api.terminal.create as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Network error'),
      );

      render(<TerminalPanel sessionId="session-1" />);
      await user.click(screen.getByText('新建终端'));

      await waitFor(() => {
        expect(mockToastError).toHaveBeenCalledWith('创建终端失败: Network error');
      });
    });
  });

  // ── 有终端时显示工具栏 ─────────────────────────────────
  describe('有终端状态', () => {
    function seedTerminal(overrides?: Partial<{ alive: boolean; title: string }>): void {
      useTerminalStore.getState().createTerminal({
        id: 'term-1',
        sessionId: 'session-1',
        title: overrides?.title ?? 'bash',
        pid: null,
        cwd: '/tmp',
        alive: overrides?.alive ?? true,
      });
    }

    it('渲染工具栏（标题 + 关闭按钮）', () => {
      seedTerminal({ title: 'pwsh' });

      render(<TerminalPanel sessionId="session-1" />);

      // 标题渲染
      expect(screen.getByText('pwsh')).toBeInTheDocument();
      // 关闭按钮（aria-label）
      expect(screen.getByRole('button', { name: '关闭终端' })).toBeInTheDocument();
    });

    it('alive=true 时不显示「已结束」标识', () => {
      seedTerminal({ alive: true });

      render(<TerminalPanel sessionId="session-1" />);

      expect(screen.queryByText('已结束')).not.toBeInTheDocument();
    });

    it('alive=false 时显示「已结束」标识', () => {
      seedTerminal({ alive: false });

      render(<TerminalPanel sessionId="session-1" />);

      expect(screen.getByText('已结束')).toBeInTheDocument();
    });

    it('点击关闭按钮 → 调用 IPC kill + 移除 store', async () => {
      seedTerminal();
      (window.api.terminal.kill as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: { ok: true },
      });

      render(<TerminalPanel sessionId="session-1" />);
      const closeButton = screen.getByRole('button', { name: '关闭终端' });
      fireEvent.click(closeButton);

      await waitFor(() => {
        expect(window.api.terminal.kill).toHaveBeenCalledWith({ terminalId: 'term-1' });
      });

      // store 应被清空（无论 IPC 是否成功，都从 store 移除）
      await waitFor(() => {
        expect(useTerminalStore.getState().terminals).toHaveLength(0);
      });
    });

    it('IPC kill 抛异常 → toast.error 提示，但仍从 store 移除', async () => {
      seedTerminal();
      (window.api.terminal.kill as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('kill failed'),
      );

      render(<TerminalPanel sessionId="session-1" />);
      fireEvent.click(screen.getByRole('button', { name: '关闭终端' }));

      await waitFor(() => {
        expect(mockToastError).toHaveBeenCalledWith('关闭终端失败: kill failed');
      });

      // 即使 IPC 失败，仍从 store 移除（避免 UI 卡住）
      await waitFor(() => {
        expect(useTerminalStore.getState().terminals).toHaveLength(0);
      });
    });
  });

  // ── sessionId 切换 ─────────────────────────────────────
  describe('sessionId 切换', () => {
    it('切换 sessionId 后查找新会话的终端', () => {
      // 为 session-2 注册终端
      useTerminalStore.getState().createTerminal({
        id: 'term-2',
        sessionId: 'session-2',
        title: 'bash',
        pid: null,
        cwd: '/tmp',
        alive: true,
      });

      const { rerender } = render(<TerminalPanel sessionId="session-1" />);
      // session-1 无终端 → 显示「新建终端」
      expect(screen.getByText('新建终端')).toBeInTheDocument();

      // 切换到 session-2
      rerender(<TerminalPanel sessionId="session-2" />);
      // session-2 有终端 → 显示标题
      expect(screen.getByText('bash')).toBeInTheDocument();
      expect(screen.queryByText('新建终端')).not.toBeInTheDocument();
    });
  });

  // ── 多终端（对齐参考项目 TerminalTabs 多 tab 结构）────────────────
  describe('多终端标签页', () => {
    it('同一会话多个终端 → 渲染全部 tab（可切换）', () => {
      useTerminalStore.getState().createTerminal({
        id: 'term-1',
        sessionId: 'session-1',
        title: 'bash',
        pid: null,
        cwd: '/tmp',
        alive: true,
      });
      useTerminalStore.getState().createTerminal({
        id: 'term-2',
        sessionId: 'session-1',
        title: 'pwsh',
        pid: null,
        cwd: '/tmp',
        alive: true,
      });

      render(<TerminalPanel sessionId="session-1" />);

      // 两个 tab 标题都渲染
      expect(screen.getByText('bash')).toBeInTheDocument();
      expect(screen.getByText('pwsh')).toBeInTheDocument();
      // 标签栏语义（tablist 含两个 tab）
      expect(screen.getAllByRole('tab')).toHaveLength(2);
      // 激活 tab：store activeTerminalId 指向最后创建的 term-2
      expect(screen.getAllByRole('tab')[1]).toHaveAttribute('aria-selected', 'true');
    });

    it('点击非激活 tab → 切换激活终端', async () => {
      const user = userEvent.setup();
      useTerminalStore.getState().createTerminal({
        id: 'term-1',
        sessionId: 'session-1',
        title: 'bash',
        pid: null,
        cwd: '/tmp',
        alive: true,
      });
      useTerminalStore.getState().createTerminal({
        id: 'term-2',
        sessionId: 'session-1',
        title: 'pwsh',
        pid: null,
        cwd: '/tmp',
        alive: true,
      });
      // 先切到 term-1，再点击 term-2 tab
      useTerminalStore.getState().setActiveTerminal('term-1');

      render(<TerminalPanel sessionId="session-1" />);
      const tabs = screen.getAllByRole('tab');
      expect(tabs[0]).toHaveAttribute('aria-selected', 'true');

      const targetTab = tabs[1];
      expect(targetTab).toBeDefined();
      await user.click(targetTab as HTMLElement);
      expect(useTerminalStore.getState().activeTerminalId).toBe('term-2');
      expect(screen.getAllByRole('tab')[1]).toHaveAttribute('aria-selected', 'true');
    });

    it('点击「+」按钮 → 创建第二个终端并写入 store', async () => {
      const user = userEvent.setup();
      useTerminalStore.getState().createTerminal({
        id: 'term-1',
        sessionId: 'session-1',
        title: 'bash',
        pid: null,
        cwd: '/tmp',
        alive: true,
      });
      (window.api.terminal.create as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: { terminalId: 'term-2' },
      });

      render(<TerminalPanel sessionId="session-1" />);
      await user.click(screen.getByRole('button', { name: '新建终端' }));

      await waitFor(() => {
        const state = useTerminalStore.getState();
        expect(state.terminals).toHaveLength(2);
        expect(state.terminals[1]?.id).toBe('term-2');
        expect(state.terminals[1]?.sessionId).toBe('session-1');
      });
    });
  });
});
