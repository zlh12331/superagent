// src/renderer/components/settings/sections/mcp-section.dom.test.tsx
// McpSection DOM 测试：服务列表渲染 / 展开工具 / 停止 / 空态
// 数据源：window.api.mcp.list/start/stop（全部 stub）
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { McpSection } from './mcp-section';

const mocks = vi.hoisted(() => ({
  list: vi.fn(async () => ({
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
  })),
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
    const toolsBtn = await screen.findByText('2 tools');
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
});
