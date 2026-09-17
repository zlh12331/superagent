// src/renderer/components/terminal/__tests__/terminal-audit.test.tsx
// terminal 域审计回归测试（2026-09）
// ──────────────────────────────────────────────────────────────
// 锁定三个本轮修复的行为：
// 1. **创建失败不再无限重试**（原为 IPC 风暴：失败后 isCreating 翻回 false、
//    terminals 仍空 → effect 立刻重触发。实证 20 个微任务周期内触发 12157 次
//    create 调用）。现为「每轮空态只自动试一次」，失败给错误 + 重试按钮。
// 2. 创建成功后用主进程返回的**真实 title/pid**（此前硬编码 'bash' + pid:null，
//    Windows 上实际跑 powershell.exe）。
// 3. 浏览器模式（无 window.api）不发起创建、不进入错误态。
// ──────────────────────────────────────────────────────────────

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { useTerminalStore } from '@/stores/transient/terminal-store';

// xterm 在 jsdom 无法渲染（依赖 canvas）——与既有测试同策略
vi.mock('@xterm/xterm', () => {
  class MockTerminal {
    cols = 80;
    rows = 24;
    loadAddon = vi.fn();
    open = vi.fn();
    write = vi.fn();
    onData = vi.fn();
    dispose = vi.fn();
    options = {};
  }
  // biome-ignore lint/style/useNamingConvention: 与 xterm.js 导出名一致
  return { Terminal: MockTerminal };
});
vi.mock('@xterm/addon-fit', () => {
  class MockFitAddon {
    fit = vi.fn();
  }
  // biome-ignore lint/style/useNamingConvention: 与 addon-fit 导出名一致
  return { FitAddon: MockFitAddon };
});

const { mockToastError } = vi.hoisted(() => ({ mockToastError: vi.fn() }));
vi.mock('sonner', () => ({ toast: { error: mockToastError, success: vi.fn() } }));

import { TerminalPanel } from './TerminalPanel';

function renderPanel(sessionId = 'session-1') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <TerminalPanel sessionId={sessionId} />
    </QueryClientProvider>,
  );
}

/** 装配 window.api.terminal（create 行为由用例决定） */
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

beforeEach(() => {
  vi.clearAllMocks();
  useTerminalStore.setState({ terminals: [], activeTerminalId: null, buffers: new Map() });
});

describe('TerminalPanel · 创建失败不再无限重试（IPC 风暴回归）', () => {
  it('create 持续失败：连续 flush 20 轮后仅调用 1 次（此前 12157 次）', async () => {
    const create = vi
      .fn()
      .mockResolvedValue({ error: { code: 'TERMINAL_SPAWN_FAILED', message: 'boom' } });
    setupApi(create);

    renderPanel();

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

    renderPanel();

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
    renderPanel();

    const retry = await screen.findByRole('button', { name: i18n.t('common.retry') });
    await userEvent.click(retry);

    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
  });
});

describe('TerminalPanel · 使用主进程返回的真实 title/pid', () => {
  it('创建成功：store 中的 title/pid 来自 IPC 响应（不再硬编码 bash/null）', async () => {
    const create = vi.fn().mockResolvedValue({
      data: { terminalId: 'term-9', pid: 4321, title: 'powershell.exe' },
    });
    setupApi(create);

    renderPanel();

    await waitFor(() => expect(useTerminalStore.getState().terminals).toHaveLength(1));
    const [term] = useTerminalStore.getState().terminals;
    // 此前硬编码 'bash' / pid: null —— Windows 实际是 powershell.exe
    expect(term?.title).toBe('powershell.exe');
    expect(term?.pid).toBe(4321);
  });
});

describe('TerminalPanel · 浏览器模式（无桥）', () => {
  it('无 window.api：不发起创建、不进入错误态、不弹 toast', async () => {
    (window as unknown as { api: undefined }).api = undefined;

    renderPanel();

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
