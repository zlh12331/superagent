import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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

const { mockToastError } = vi.hoisted(() => ({
  mockToastError: vi.fn(),
}));
vi.mock('sonner', () => ({
  toast: {
    error: mockToastError,
  },
}));

import { i18n } from '@/i18n';
import { useTerminalStore } from '@/stores/transient/terminal-store';
import { TerminalPanel } from './TerminalPanel';

/** 装配 window.api.terminal（create 行为由用例决定）——审计回归用例专用 */
function setupApi(create: ReturnType<typeof vi.fn>) {
  window.api = {
    terminal: {
      create,
      kill: vi.fn().mockResolvedValue({ data: { ok: true } }),
      input: vi.fn(),
      resize: vi.fn(),
      subscribeOutputEvent: vi.fn(() => () => {}),
      subscribeExitEvent: vi.fn(() => () => {}),
    },
  } as never;
}

/** 面板 + QueryClientProvider（useWorkingDir 底层是 useInfiniteQuery，无 provider 会直接抛错） */
function withQueryPanel(sessionId: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={client}>
      <TerminalPanel sessionId={sessionId} />
    </QueryClientProvider>
  );
}

describe('TerminalPanel', () => {
  beforeEach(() => {
    useTerminalStore.setState({
      terminals: [],
      activeTerminalId: null,
      buffers: new Map(),
    });

    vi.clearAllMocks();

    window.api.terminal = {
      create: vi.fn(),
      kill: vi.fn(),
      input: vi.fn(),
      resize: vi.fn(),
      subscribeOutputEvent: vi.fn(() => () => {}),
      subscribeExitEvent: vi.fn(() => () => {}),
    } as never;
  });

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

      render(withQueryPanel('session-1'));

      expect(screen.getByText('pwsh')).toBeInTheDocument();
      expect(screen.getByTitle('关闭终端')).toBeInTheDocument();
    });

    it('alive=true 时不显示「已结束」标识', () => {
      seedTerminal({ alive: true });

      render(withQueryPanel('session-1'));

      expect(screen.queryByText('已结束')).not.toBeInTheDocument();
    });

    it('alive=false 时显示「已结束」标识', () => {
      seedTerminal({ alive: false });

      render(withQueryPanel('session-1'));

      expect(screen.getByText('已结束')).toBeInTheDocument();
    });

    it('点击关闭按钮 → 调用 IPC kill + 移除 store', async () => {
      seedTerminal();
      (window.api.terminal.kill as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: { ok: true },
      });

      render(withQueryPanel('session-1'));
      const closeButton = screen.getByTitle('关闭终端');
      fireEvent.click(closeButton);

      await waitFor(() => {
        expect(window.api.terminal.kill).toHaveBeenCalledWith({ terminalId: 'term-1' });
      });

      await waitFor(() => {
        expect(useTerminalStore.getState().terminals).toHaveLength(0);
      });
    });

    it('IPC kill 抛异常 → toast.error 提示，但仍从 store 移除', async () => {
      seedTerminal();
      (window.api.terminal.kill as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('kill failed'),
      );

      render(withQueryPanel('session-1'));
      fireEvent.click(screen.getByTitle('关闭终端'));

      await waitFor(() => {
        expect(mockToastError).toHaveBeenCalledWith('关闭终端失败: kill failed');
      });

      await waitFor(() => {
        expect(useTerminalStore.getState().terminals).toHaveLength(0);
      });
    });
  });

  describe('sessionId 切换', () => {
    it('切换 sessionId 后查找新会话的终端', () => {
      useTerminalStore.getState().createTerminal({
        id: 'term-2',
        sessionId: 'session-2',
        title: 'bash',
        pid: null,
        cwd: '/tmp',
        alive: true,
      });

      const { rerender } = render(withQueryPanel('session-1'));
      expect(screen.queryByText('新建终端')).not.toBeInTheDocument();

      rerender(withQueryPanel('session-2'));
      expect(screen.getByText('bash')).toBeInTheDocument();
    });
  });

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

      render(withQueryPanel('session-1'));

      expect(screen.getByText('bash')).toBeInTheDocument();
      expect(screen.getByText('pwsh')).toBeInTheDocument();
      expect(screen.getAllByRole('tab')).toHaveLength(2);
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
      useTerminalStore.getState().setActiveTerminal('term-1');

      render(withQueryPanel('session-1'));
      const tabs = screen.getAllByRole('tab');
      expect(tabs[0]).toHaveAttribute('aria-selected', 'true');

      const targetTab = tabs[1];
      expect(targetTab).toBeDefined();
      await user.click(targetTab as HTMLElement);
      expect(useTerminalStore.getState().activeTerminalId).toBe('term-2');
      expect(screen.getAllByRole('tab')[1]).toHaveAttribute('aria-selected', 'true');
    });
  });
});

describe('TerminalPanel · 创建失败不再无限重试（IPC 风暴回归）', () => {
  beforeEach(() => {
    useTerminalStore.setState({ terminals: [], activeTerminalId: null, buffers: new Map() });
  });

  it('create 持续失败：连续 flush 20 轮后仅调用 1 次（此前 12157 次）', async () => {
    const create = vi
      .fn()
      .mockResolvedValue({ error: { code: 'TERMINAL_SPAWN_FAILED', message: 'boom' } });
    setupApi(create);

    render(withQueryPanel('session-1'));

    for (let i = 0; i < 20; i++) {
      // eslint-disable-next-line no-await-in-loop
      await act(async () => {
        await Promise.resolve();
      });
    }

    expect(create).toHaveBeenCalledTimes(1);
  });

  it('失败后显示错误文案 + 重试按钮（不再静默自动重试）', async () => {
    const create = vi
      .fn()
      .mockResolvedValue({ error: { code: 'TERMINAL_SPAWN_FAILED', message: 'boom' } });
    setupApi(create);

    render(withQueryPanel('session-1'));

    await waitFor(() => expect(mockToastError).toHaveBeenCalled());
    const retry = await screen.findByRole('button', { name: i18n.t('common.retry') });
    expect(retry).toBeDefined();
  });

  it('点击重试 → 重新发起创建（仅用户显式触发才重试）', async () => {
    const create = vi
      .fn()
      .mockResolvedValue({ error: { code: 'TERMINAL_SPAWN_FAILED', message: 'boom' } });
    setupApi(create);
    render(withQueryPanel('session-1'));

    const retry = await screen.findByRole('button', { name: i18n.t('common.retry') });
    await userEvent.click(retry);

    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
  });
});

describe('TerminalPanel · 使用主进程返回的真实 title/pid', () => {
  beforeEach(() => {
    useTerminalStore.setState({ terminals: [], activeTerminalId: null, buffers: new Map() });
  });

  it('创建成功：store 中的 title/pid 来自 IPC 响应（不再硬编码 bash/null）', async () => {
    const create = vi.fn().mockResolvedValue({
      data: { terminalId: 'term-9', pid: 4321, title: 'powershell.exe' },
    });
    setupApi(create);

    render(withQueryPanel('session-1'));

    await waitFor(() => expect(useTerminalStore.getState().terminals).toHaveLength(1));
    const [term] = useTerminalStore.getState().terminals;
    expect(term?.title).toBe('powershell.exe');
    expect(term?.pid).toBe(4321);
  });
});

describe('TerminalPanel · 浏览器模式（无桥）', () => {
  beforeEach(() => {
    useTerminalStore.setState({ terminals: [], activeTerminalId: null, buffers: new Map() });
  });

  it('无 window.api：不发起创建、不进入错误态、不弹 toast', async () => {
    (window as unknown as { api: undefined }).api = undefined;

    render(withQueryPanel('session-1'));

    for (let i = 0; i < 5; i++) {
      // eslint-disable-next-line no-await-in-loop
      await act(async () => {
        await Promise.resolve();
      });
    }

    expect(mockToastError).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: i18n.t('common.retry') })).toBeNull();
    expect(screen.getByText(i18n.t('terminal.creating'))).toBeDefined();
  });
});
