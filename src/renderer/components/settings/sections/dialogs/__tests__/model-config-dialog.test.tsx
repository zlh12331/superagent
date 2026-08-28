// src/renderer/components/settings/sections/dialogs/__tests__/model-config-dialog.test.tsx
// ModelConfigDialog 单测：编辑模式连通性测试用「表单里的请求地址」而非默认端点
// ──────────────────────────────────────────────────────────────
// 回归背景：runConnectivityTest 曾以 !isEdit 守卫传 baseUrl，导致编辑模式改了
// 请求地址后，连通性测试仍打默认端点（改动不生效）。本测试锁定修复后行为。
// 数据源 mock：window.api.models.test/listBuiltin + settings.updateRuntimeModel 全 stub；
// 表单交互（改地址 → 保存 → 测试 → 保存）保持真实实现断言。
// ──────────────────────────────────────────────────────────────

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ModelConfigDialog } from '../model-config-dialog';

/** models:test 入参形状（契约子集，够断言用） */
interface TestModelCallArg {
  readonly providerKind: string;
  readonly modelId?: string;
  readonly baseUrl?: string;
  readonly apiKey?: string;
}

/** settings:updateRuntimeModel 入参形状（契约子集） */
interface UpdateRuntimeModelCallArg {
  readonly modelId: string;
  readonly baseUrl?: string;
}

const mocks = vi.hoisted(() => ({
  modelsTest: vi.fn(
    async (_input: TestModelCallArg): Promise<{ data: { ok: true } }> => ({ data: { ok: true } }),
  ),
  listBuiltin: vi.fn(async () => ({ data: { models: [] } })),
  updateRuntimeModel: vi.fn(
    async (_input: UpdateRuntimeModelCallArg): Promise<{ data: { ok: true } }> => ({
      data: { ok: true },
    }),
  ),
  setApiKey: vi.fn(async () => ({ data: { ok: true } })),
}));

/** 编辑对象：原 baseUrl = https://old.example.com */
const EDITING_MODEL = {
  modelId: 'my-coder',
  providerKind: 'deepseek',
  baseUrl: 'https://old.example.com',
  displayName: '我的编码器',
  isEnabled: true,
  createdAt: 1,
} as const;

function renderDialog(): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <ModelConfigDialog
        open
        mode="edit"
        providerKind={undefined}
        editingModel={EDITING_MODEL}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />
    </QueryClientProvider>,
  );
}

/** 取 models:test 的入参（第一个调用；未调用时返回空形状） */
function testArg(): TestModelCallArg {
  return mocks.modelsTest.mock.calls[0]?.[0] ?? { providerKind: '' };
}

/** 取 settings:updateRuntimeModel 的入参（第一个调用；未调用时返回空形状） */
function updateArg(): UpdateRuntimeModelCallArg {
  return mocks.updateRuntimeModel.mock.calls[0]?.[0] ?? { modelId: '' };
}

describe('ModelConfigDialog 编辑模式连通性测试', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.api = {
      models: { test: mocks.modelsTest, listBuiltin: mocks.listBuiltin },
      settings: { updateRuntimeModel: mocks.updateRuntimeModel, setApiKey: mocks.setApiKey },
    } as never;
  });

  afterEach(() => {
    window.api = undefined as never;
  });

  it('改了请求地址：连通性测试与保存都用新地址（回归：此前编辑模式永远测默认端点）', async () => {
    const user = userEvent.setup();
    renderDialog();

    // 表单预填原地址 → 改成新地址
    const urlInput = await screen.findByPlaceholderText('https://api.openai.com/v1');
    await user.clear(urlInput);
    await user.type(urlInput, 'https://new.example.com');

    // 保存流程：校验 → 连通性测试 → 更新
    await user.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => {
      expect(mocks.modelsTest).toHaveBeenCalledTimes(1);
    });
    expect(testArg().providerKind).toBe('deepseek');
    expect(testArg().modelId).toBe('my-coder');
    expect(testArg().baseUrl).toBe('https://new.example.com');

    await waitFor(() => {
      expect(mocks.updateRuntimeModel).toHaveBeenCalledTimes(1);
    });
    expect(updateArg().baseUrl).toBe('https://new.example.com');
  });

  it('不改地址：连通性测试用表单预填的模型自身 baseUrl（而非厂商默认端点）', async () => {
    const user = userEvent.setup();
    renderDialog();

    await screen.findByPlaceholderText('https://api.openai.com/v1');
    await user.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => {
      expect(mocks.modelsTest).toHaveBeenCalledTimes(1);
    });
    expect(testArg().baseUrl).toBe('https://old.example.com');
  });

  it('modelId 只读：编辑模式锁定主键（改动会让 update 命中不到行）', async () => {
    renderDialog();

    const modelIdInput = (await screen.findByPlaceholderText('请输入模型 ID')) as HTMLInputElement;
    expect(modelIdInput.value).toBe('my-coder');
    expect(modelIdInput.disabled).toBe(true);
  });
});
