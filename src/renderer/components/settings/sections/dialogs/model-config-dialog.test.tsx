import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ModelConfigDialog } from './model-config-dialog';
import { formatTokenLabel, parseTokenLabel } from './model-config-fields';

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
  readonly timeoutMs?: number | null;
  readonly capabilities?: Record<string, unknown> | null;
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

/** 编辑对象：原 baseUrl = https://old.example.com，原超时 = 1500ms */
const EDITING_MODEL = {
  modelId: 'my-coder',
  providerKind: 'deepseek',
  baseUrl: 'https://old.example.com',
  displayName: '我的编码器',
  timeoutMs: 1500,
  isEnabled: true,
  createdAt: 1,
} as const;

/** 编辑对象（带原能力覆盖）：512Ki（二进制语义存储，商 2 幂——现实存储形态） */
const EDITING_MODEL_WITH_CAPS = {
  ...EDITING_MODEL,
  capabilities: { contextWindowSize: 524_288 },
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

    const urlInput = await screen.findByPlaceholderText('https://api.openai.com/v1');
    await user.clear(urlInput);
    await user.type(urlInput, 'https://new.example.com');

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
  }, 15_000);

  it('不改地址：连通性测试用表单预填的模型自身 baseUrl（而非厂商默认端点）', async () => {
    const user = userEvent.setup();
    renderDialog();

    await screen.findByPlaceholderText('https://api.openai.com/v1');
    await user.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => {
      expect(mocks.modelsTest).toHaveBeenCalledTimes(1);
    });
    expect(testArg().baseUrl).toBe('https://old.example.com');
  }, 15_000);

  it('modelId 只读：编辑模式锁定主键（改动会让 update 命中不到行）', async () => {
    renderDialog();

    const modelIdInput = (await screen.findByPlaceholderText('请输入模型 ID')) as HTMLInputElement;
    expect(modelIdInput.value).toBe('my-coder');
    expect(modelIdInput.disabled).toBe(true);
  });

  it('超时字段：毫秒预填换算为秒回显（1500ms → 1.5）', async () => {
    renderDialog();

    const timeoutInput = (await screen.findByPlaceholderText(
      '留空不限制，如：3600',
    )) as HTMLInputElement;
    expect(timeoutInput.value).toBe('1.5');
  }, 15_000);

  it('超时字段：保存携带毫秒（120 秒 → 120000ms）', async () => {
    const user = userEvent.setup();
    renderDialog();

    const timeoutInput = await screen.findByPlaceholderText('留空不限制，如：3600');
    await user.clear(timeoutInput);
    await user.type(timeoutInput, '120');
    await user.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => {
      expect(mocks.updateRuntimeModel).toHaveBeenCalledTimes(1);
    });
    expect(updateArg().timeoutMs).toBe(120_000);
  }, 15_000);

  it('超时字段：清空后保存发送 null（清除语义，回不限制）', async () => {
    const user = userEvent.setup();
    renderDialog();

    const timeoutInput = await screen.findByPlaceholderText('留空不限制，如：3600');
    await user.clear(timeoutInput);
    await user.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => {
      expect(mocks.updateRuntimeModel).toHaveBeenCalledTimes(1);
    });
    expect(updateArg().timeoutMs).toBeNull();
  }, 15_000);

  it('能力覆盖：原覆盖存在且清空三项 → 保存携带 null（显式清除，非「不修改」）', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <ModelConfigDialog
          open
          mode="edit"
          providerKind={undefined}
          editingModel={EDITING_MODEL_WITH_CAPS}
          onClose={vi.fn()}
          onSaved={vi.fn()}
        />
      </QueryClientProvider>,
    );
    const user = userEvent.setup();

    // 展开高级配置折叠区（上下文窗口输入在折叠区内）
    await user.click(await screen.findByRole('button', { name: '高级配置' }));
    const contextInput = await screen.findByPlaceholderText('872000');
    const contextOutput = screen.getByPlaceholderText('128000');
    await user.clear(contextInput);
    await user.clear(contextOutput);
    await user.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => {
      expect(mocks.updateRuntimeModel).toHaveBeenCalledTimes(1);
    });
    expect(updateArg().capabilities).toBeNull();
  }, 15_000);

  it('能力覆盖：编辑未改动回显值 → 原样携带（512Ki 回显 "512k"，parse 精确往返）', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <ModelConfigDialog
          open
          mode="edit"
          providerKind={undefined}
          editingModel={EDITING_MODEL_WITH_CAPS}
          onClose={vi.fn()}
          onSaved={vi.fn()}
        />
      </QueryClientProvider>,
    );
    const user = userEvent.setup();

    // 展开高级配置折叠区（上下文窗口输入在折叠区内）
    await user.click(await screen.findByRole('button', { name: '高级配置' }));
    await screen.findByPlaceholderText('872000');
    await user.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => {
      expect(mocks.updateRuntimeModel).toHaveBeenCalledTimes(1);
    });
    expect(updateArg().capabilities).toMatchObject({ contextWindowSize: 524_288 });
  }, 15_000);
});

describe('formatTokenLabel 换算口径', () => {
  it('Ki 档位：商为 2 的幂才按二进制 K 显示（131072 → 128k）', () => {
    expect(formatTokenLabel(131_072)).toBe('128k');
    expect(formatTokenLabel(8_192)).toBe('8k');
  });

  it('十进制标称：384000（=375×1024，整除但商非 2 幂）→ 384k，不再显示 375k', () => {
    expect(formatTokenLabel(384_000)).toBe('384k');
    expect(formatTokenLabel(200_000)).toBe('200k');
    expect(formatTokenLabel(1_000_000)).toBe('1000k');
    expect(formatTokenLabel(872_000)).toBe('872k');
  });

  it('M 档位：2 的 Mi 整数倍按 M 显示', () => {
    expect(formatTokenLabel(1_048_576)).toBe('1M');
  });

  it('回环自校验：超上限死角回退纯 Token 数（10000000 → "10000k" 解析超限）', () => {
    expect(formatTokenLabel(10_000_000)).toBe('10000000');
    expect(parseTokenLabel(formatTokenLabel(10_000_000))).toBe(10_000_000);
  });
});
