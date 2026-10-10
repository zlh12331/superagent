import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ModelsSection } from './models-section';

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
