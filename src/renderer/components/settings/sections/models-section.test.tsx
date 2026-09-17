// src/renderer/components/settings/sections/__tests__/models-section.test.tsx
// ModelsSection 单测：模型管理列表页（表格/开关/增删改入口/空态/删除确认）
// ──────────────────────────────────────────────────────────────
// 数据源 mock：window.api.settings.listRuntimeModels 等 IPC 全部 stub；
// 业务交互（开关切换/删除确认/弹窗打开）保持真实实现断言。
// ──────────────────────────────────────────────────────────────

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ModelsSection } from './models-section';

// 删除确认收敛至命令式 confirm() store：测试默认确认通过
vi.mock('@/stores/transient/confirm-dialog-store', () => ({
  confirm: vi.fn().mockResolvedValue(true),
}));

const mocks = vi.hoisted(() => ({
  listRuntimeModels: vi.fn(async () => ({ data: { models: [] } })),
  updateRuntimeModel: vi.fn(async () => ({ data: { ok: true } })),
  removeRuntimeModel: vi.fn(async () => ({ data: { ok: true } })),
  addRuntimeModel: vi.fn(async () => ({ data: { ok: true } })),
  modelsList: vi.fn(async () => ({ data: { models: [] } })),
  modelsTest: vi.fn(async () => ({ data: { ok: true } })),
}));

function renderSection(): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <ModelsSection />
    </QueryClientProvider>,
  );
}

describe('ModelsSection 模型管理列表页', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listRuntimeModels.mockResolvedValue({ data: { models: [] } });
    mocks.modelsList.mockResolvedValue({ data: { models: [] } });
    window.api = {
      settings: {
        listRuntimeModels: mocks.listRuntimeModels,
        updateRuntimeModel: mocks.updateRuntimeModel,
        removeRuntimeModel: mocks.removeRuntimeModel,
        addRuntimeModel: mocks.addRuntimeModel,
        setApiKey: vi.fn(async () => ({ data: { ok: true } })),
      },
      models: { list: mocks.modelsList, test: mocks.modelsTest },
    } as never;
  });

  afterEach(() => {
    window.api = undefined as never;
  });

  it('空列表：显示空态提示', async () => {
    renderSection();
    await waitFor(() => {
      expect(screen.getByText('暂无模型，点击「添加模型」开始使用')).toBeTruthy();
    });
  });

  it('列表渲染：展示名 + 模型 id + 服务商显示名', async () => {
    mocks.listRuntimeModels.mockResolvedValue({
      data: {
        models: [
          {
            modelId: 'my-coder',
            providerKind: 'deepseek',
            baseUrl: undefined,
            displayName: '我的编码器',
            isEnabled: true,
            createdAt: 1,
          },
        ],
      },
    } as never);
    renderSection();
    await waitFor(() => {
      expect(screen.getByText('我的编码器')).toBeTruthy();
      expect(screen.getByText('my-coder')).toBeTruthy();
      // 服务商列（提供商行区块已拆出，DeepSeek 仅出现一次）
      expect(screen.getByText('DeepSeek')).toBeTruthy();
    });
  });

  it('开关切换：调 updateRuntimeModel（isEnabled=false）', async () => {
    mocks.listRuntimeModels.mockResolvedValue({
      data: {
        models: [
          {
            modelId: 'my-coder',
            providerKind: 'deepseek',
            baseUrl: undefined,
            displayName: undefined,
            isEnabled: true,
            createdAt: 1,
          },
        ],
      },
    } as never);
    renderSection();
    const toggle = await screen.findByRole('switch');
    await userEvent.click(toggle);
    await waitFor(() => {
      expect(mocks.updateRuntimeModel).toHaveBeenCalledWith(
        expect.objectContaining({ modelId: 'my-coder', isEnabled: false }),
      );
    });
  });

  it('删除流程：确认弹窗 → 确认 → removeRuntimeModel', async () => {
    mocks.listRuntimeModels.mockResolvedValue({
      data: {
        models: [
          {
            modelId: 'my-coder',
            providerKind: 'deepseek',
            baseUrl: undefined,
            displayName: undefined,
            isEnabled: true,
            createdAt: 1,
          },
        ],
      },
    } as never);
    renderSection();
    // confirm() store mock 默认确认通过：点行内删除按钮即触发删除
    const deleteBtn = await screen.findByRole('button', { name: '删除' });
    await userEvent.click(deleteBtn);
    await waitFor(() => {
      expect(mocks.removeRuntimeModel).toHaveBeenCalledWith(
        expect.objectContaining({ modelId: 'my-coder' }),
      );
    });
  });

  it('添加按钮：打开添加模型弹窗（含自定义模型入口）', async () => {
    renderSection();
    const addBtn = await screen.findByRole('button', { name: '添加模型' });
    await userEvent.click(addBtn);
    expect(await screen.findByText('自定义模型')).toBeTruthy();
  });
});
