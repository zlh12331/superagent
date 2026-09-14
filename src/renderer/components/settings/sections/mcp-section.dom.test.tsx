// src/renderer/components/settings/sections/mcp-section.dom.test.tsx
// McpSection DOM 测试：服务列表渲染 / 展开工具 / 停止 / 空态
// 数据源：window.api.mcp.list/start/stop（全部 stub）
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { McpSection } from './mcp-section';

const mocks = vi.hoisted(() => ({
  // 类型从 IPC 契约推导（与 mcp-section 组件同源）；IpcResponse 本身即
  // { data } | { error } 联合，故成功/失败两种赋值都合法
  list: vi.fn(
    async (): Promise<Awaited<ReturnType<typeof window.api.mcp.list>>> => ({
      data: {
        servers: [
          {
            config: {
              name: 'filesystem',
              transport: 'stdio',
              command: 'npx',
              args: ['-y', '@modelcontextprotocol/server-filesystem'],
            },
            status: 'running',
            toolNames: ['read_file', 'write_file'],
          },
        ],
      },
    }),
  ),
  start: vi.fn(async () => ({ data: { ok: true } })),
  stop: vi.fn(async () => ({ data: { ok: true } })),
}));

function renderSection(): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <McpSection />
    </QueryClientProvider>,
  );
}

describe('McpSection DOM', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.list.mockResolvedValue({
      data: {
        servers: [
          {
            config: {
              name: 'filesystem',
              transport: 'stdio',
              command: 'npx',
              args: ['-y', '@modelcontextprotocol/server-filesystem'],
            },
            status: 'running',
            toolNames: ['read_file', 'write_file'],
          },
        ],
      },
    });
    mocks.start.mockResolvedValue({ data: { ok: true } });
    mocks.stop.mockResolvedValue({ data: { ok: true } });
    window.api = {
      mcp: { list: mocks.list, start: mocks.start, stop: mocks.stop },
    } as unknown as typeof window.api;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('渲染 MCP 服务列表（名称/传输/状态）', async () => {
    renderSection();
    expect(await screen.findByText('filesystem')).toBeInTheDocument();
    expect(screen.getAllByText('stdio').length).toBeGreaterThan(0);
    expect(screen.getByText('running')).toBeInTheDocument();
  });

  it('工具数量按钮：点击展开工具列表', async () => {
    renderSection();
    const toolsBtn = await screen.findByText('2 个工具');
    await userEvent.click(toolsBtn);
    expect(await screen.findByText('read_file')).toBeInTheDocument();
    expect(screen.getByText('write_file')).toBeInTheDocument();
  });

  it('停止服务 → 调 mcp.stop', async () => {
    renderSection();
    await screen.findByText('filesystem');
    const stopBtn = screen.getByLabelText('停止');
    await userEvent.click(stopBtn);
    await waitFor(() => expect(mocks.stop).toHaveBeenCalledWith({ name: 'filesystem' }));
  });

  it('无服务器 → 显示空态', async () => {
    mocks.list.mockResolvedValue({ data: { servers: [] } });
    renderSection();
    await waitFor(() => expect(screen.getByText('暂无已启动的 MCP 服务器')).toBeInTheDocument());
  });

  // 回归：查询失败必须显示 error 态而非空态
  // （此前 isLoading=false 且 servers=[] 会落入空态分支 → 把加载失败误导为「没有服务器」）
  it('查询失败 → 显示错误提示与重试，不显示空态', async () => {
    mocks.list.mockResolvedValue({
      error: { code: 'INTERNAL_ERROR', message: 'mcp list failed' },
    });
    renderSection();
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    // 文案真源见 i18n locales 的 common.sectionLoadFailed / common.retry
    expect(screen.getByText('区块加载失败，请重试')).toBeInTheDocument();
    expect(screen.getByText('重试')).toBeInTheDocument();
    // 关键：不得把失败渲染成「空列表」
    expect(screen.queryByText('暂无已启动的 MCP 服务器')).not.toBeInTheDocument();
  });
});
