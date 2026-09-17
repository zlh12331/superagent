// src/renderer/components/$1/TerminalPanel.test.tsx
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
// - 面板经 useWorkingDir 读会话工作目录（底层 useInfiniteQuery），渲染需 QueryClientProvider
// ──────────────────────────────────────────────────────────────

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

      render(withQueryPanel('session-1'));

      // 标题渲染
      expect(screen.getByText('pwsh')).toBeInTheDocument();
      // 关闭按钮（aria-label）
      expect(screen.getByRole('button', { name: '关闭终端' })).toBeInTheDocument();
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

      render(withQueryPanel('session-1'));
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

      const { rerender } = render(withQueryPanel('session-1'));
      // session-1 无终端 → 自动创建（用户要求：点击终端直接打开——无需新建按钮）
      expect(screen.queryByText('新建终端')).not.toBeInTheDocument();

      // 切换到 session-2
      rerender(withQueryPanel('session-2'));
      // session-2 有终端 → 显示标题
      expect(screen.getByText('bash')).toBeInTheDocument();
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

      render(withQueryPanel('session-1'));

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

// ── 审计回归（2026-09，原 terminal-audit.test.tsx 并入） ─────────
// 1. 创建失败不再无限重试（原为 IPC 风暴：失败后 isCreating 翻回 false、
//    terminals 仍空 → effect 立刻重触发。实证 20 个微任务周期内 12157 次
//    create 调用）。现为「每轮空态只自动试一次」，失败给错误 + 重试按钮。
// 2. 创建成功后用主进程返回的真实 title/pid（此前硬编码 'bash' + pid:null，
//    Windows 上实际跑 powershell.exe）。
// 3. 浏览器模式（无 window.api）不发起创建、不进入错误态。
describe('TerminalPanel · 创建失败不再无限重试（IPC 风暴回归）', () => {
  // 顶层 describe 拿不到外层的 store 重置——这里必须自带（否则前序用例的
  // 终端残留会让空态守卫不触发，create 0 次调用）
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

    // 关键断言：每轮空态只自动尝试一次
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('失败后显示错误文案 + 重试按钮（不再静默自动重试）', async () => {
    const create = vi
      .fn()
      .mockResolvedValue({ error: { code: 'TERMINAL_SPAWN_FAILED', message: 'boom' } });
    setupApi(create);

    render(withQueryPanel('session-1'));

    // toast 仍提示（与既有行为一致）
    await waitFor(() => expect(mockToastError).toHaveBeenCalled());
    // 面板内提供重试入口
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
    // 此前硬编码 'bash' / pid: null —— Windows 实际是 powershell.exe
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
    // 仍显示创建中占位（无终端且无错误）
    expect(screen.getByText(i18n.t('terminal.creating'))).toBeDefined();
  });
});
