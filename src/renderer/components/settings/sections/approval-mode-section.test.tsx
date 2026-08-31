// src/renderer/components/settings/sections/approval-mode-section.test.tsx
// ApprovalModeSection 单测：审批模式单选 / 白名单增删 / 工具权限分组
// 数据源：window.api.whitelist.* / tool.list / settings.getApprovalMode（全部 stub）
// i18n 已加载 zh-CN，用中文文案断言。业务交互保持真实实现。

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApprovalModeSection } from './approval-mode-section';

const mocks = vi.hoisted(() => ({
  getApprovalMode: vi.fn(async () => ({ data: { mode: 'ask' } })),
  setApprovalMode: vi.fn(async () => ({ data: { ok: true } })),
  whitelistList: vi.fn(async () => ({ data: { entries: [] } })),
  whitelistAdd: vi.fn(async () => ({ data: { ok: true } })),
  whitelistRemove: vi.fn(async () => ({ data: { ok: true } })),
  toolList: vi.fn(async () => ({
    data: {
      tools: [
        { name: 'run_command', permission: 'auto' },
        { name: 'edit_file', permission: 'ask' },
      ],
    },
  })),
}));

function renderSection(): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <ApprovalModeSection />
    </QueryClientProvider>,
  );
}

describe('ApprovalModeSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getApprovalMode.mockResolvedValue({ data: { mode: 'ask' } });
    mocks.whitelistList.mockResolvedValue({ data: { entries: [] } });
    mocks.whitelistAdd.mockResolvedValue({ data: { ok: true } });
    mocks.whitelistRemove.mockResolvedValue({ data: { ok: true } });
    mocks.toolList.mockResolvedValue({
      data: {
        tools: [
          { name: 'run_command', permission: 'auto' },
          { name: 'edit_file', permission: 'ask' },
        ],
      },
    });
    // setup.ts 的 window.api 是宽松 MockApi；但 TS 会按 IpcApi 推断对象字面量，
    // 用 as unknown as 收敛（mock 返回体与真实 IpcResponse 结构对不上，属常态）
    window.api = {
      settings: {
        getApprovalMode: mocks.getApprovalMode,
        setApprovalMode: mocks.setApprovalMode,
      },
      whitelist: {
        list: mocks.whitelistList,
        add: mocks.whitelistAdd,
        remove: mocks.whitelistRemove,
      },
      tool: { list: mocks.toolList },
    } as unknown as typeof window.api;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('渲染四个审批模式单选', () => {
    renderSection();
    expect(screen.getByText('Ask（全部审批）')).toBeInTheDocument();
    expect(screen.getByText('Plan（只读探索）')).toBeInTheDocument();
    expect(screen.getByText('Auto（自动放行）')).toBeInTheDocument();
    expect(screen.getByText('YOLO（全自动）')).toBeInTheDocument();
  });

  it('切换模式 → 调 settings.setApprovalMode', async () => {
    renderSection();
    const autoRadio = screen.getByText('Auto（自动放行）').closest('label');
    expect(autoRadio).not.toBeNull();
    await userEvent.click(autoRadio as HTMLElement);
    await waitFor(() => expect(mocks.setApprovalMode).toHaveBeenCalledWith({ mode: 'auto' }));
  });

  it('白名单空态显示占位文案', async () => {
    renderSection();
    await waitFor(() => expect(screen.getByText('暂无白名单条目')).toBeInTheDocument());
  });

  it('白名单有条目 → 渲染条目并支持移除', async () => {
    mocks.whitelistList.mockResolvedValue({
      data: { entries: [{ toolName: 'run_command', pattern: 'ls *' }] },
    } as never);
    renderSection();
    // run_command 同时出现在白名单条目与工具分组 → 用 findAllByText 断言存在
    const matches = await screen.findAllByText(/run_command/);
    expect(matches.length).toBeGreaterThan(0);
    const removeBtn = screen.getByLabelText('移除');
    await userEvent.click(removeBtn);
    await waitFor(() => expect(mocks.whitelistRemove).toHaveBeenCalled());
  });

  it('添加白名单 → 填写模式并点击添加', async () => {
    renderSection();
    const patternInput = screen.getByPlaceholderText('命令片段（留空 = 全部放行）');
    await userEvent.type(patternInput, 'npm run build');
    const addBtn = screen.getByText('添加');
    await userEvent.click(addBtn);
    await waitFor(() => expect(mocks.whitelistAdd).toHaveBeenCalled());
  });

  it('工具权限分组：auto 与 ask 各渲染工具名', async () => {
    renderSection();
    // 工具名同时出现在白名单输入（default 'run_command'）与分组 → 用 findAllByText
    const autoHits = await screen.findAllByText(/run_command/);
    const askHits = await screen.findAllByText(/edit_file/);
    expect(autoHits.length).toBeGreaterThan(0);
    expect(askHits.length).toBeGreaterThan(0);
  });
});
