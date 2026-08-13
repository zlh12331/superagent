// src/main/ipc/settings.handler.test.ts
// settings.handler 单测：10 个 settings:* 方法（三件套）
// ──────────────────────────────────────────────────────────────
// 测试策略（遵循"业务逻辑不 mock、外部依赖注入 fake"）：
// - keychain/telemetry-pref/approval-pref/runtimeModelStore 为文件存储
//   外部依赖（与 fetch/WebSocket 同类）→ vi.mock
// - toKeychainKey（纯函数）保持真实实现
// - permissionService 经 deps 注入 fake
// ──────────────────────────────────────────────────────────────

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSettingsHandlers } from './settings.handler';

const mocks = vi.hoisted(() => ({
  getSecret: vi.fn(async () => undefined),
  setSecret: vi.fn(async () => {}),
  deleteSecret: vi.fn(async () => {}),
  readTelemetryLevelSync: vi.fn(() => 'off'),
  writeTelemetryLevel: vi.fn(async () => {}),
  readApprovalModeSync: vi.fn(() => 'auto'),
  writeApprovalMode: vi.fn(async () => {}),
  runtimeAdd: vi.fn(async () => {}),
  runtimeRemove: vi.fn(async () => {}),
  runtimeList: vi.fn(async () => []),
  invalidateModel: vi.fn(() => {}),
  readAllSettings: vi.fn(() => ({})),
  writeSetting: vi.fn(() => {}),
}));

vi.mock('../infra/storage/keychain', () => ({
  getSecret: mocks.getSecret,
  setSecret: mocks.setSecret,
  deleteSecret: mocks.deleteSecret,
}));

vi.mock('../infra/storage/telemetry-pref', () => ({
  readTelemetryLevelSync: mocks.readTelemetryLevelSync,
  writeTelemetryLevel: mocks.writeTelemetryLevel,
}));

vi.mock('../infra/storage/approval-pref', () => ({
  readApprovalModeSync: mocks.readApprovalModeSync,
  writeApprovalMode: mocks.writeApprovalMode,
}));

vi.mock('../infra/storage/settings-pref', () => ({
  readAllSettings: mocks.readAllSettings,
  writeSetting: mocks.writeSetting,
}));

vi.mock('../infra/ai/llm-client/ai-provider', () => ({
  llmClient: { invalidateModel: mocks.invalidateModel },
  runtimeModelStore: {
    add: mocks.runtimeAdd,
    remove: mocks.runtimeRemove,
    list: mocks.runtimeList,
  },
}));

const EMPTY_CTX = {} as never;

describe('settings.handler 渲染层设置（S1：SQLite 单一真源）', () => {
  const permissionService = { setApprovalMode: vi.fn() };
  const handlers = createSettingsHandlers({
    permissionService: permissionService as never,
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('getAll：返回 readAllSettings 快照', async () => {
    mocks.readAllSettings.mockReturnValueOnce({ theme: 'light', ai: { temperature: 0.9 } });
    const res = await handlers.getAll({}, EMPTY_CTX);
    expect(res).toEqual({ settings: { theme: 'light', ai: { temperature: 0.9 } } });
  });

  it('set：写穿透调用 writeSetting + 返回 ok', async () => {
    const res = await handlers.set({ key: 'theme', value: 'dark' }, EMPTY_CTX);
    expect(mocks.writeSetting).toHaveBeenCalledWith('theme', 'dark');
    expect(res).toEqual({ ok: true });
  });
});

describe('settings.handler API Key（三件套）', () => {
  const permissionService = { setApprovalMode: vi.fn() };
  const handlers = createSettingsHandlers({
    permissionService: permissionService as never,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSecret.mockResolvedValue(undefined);
    mocks.readTelemetryLevelSync.mockReturnValue('off');
    mocks.readApprovalModeSync.mockReturnValue('auto');
    mocks.runtimeList.mockResolvedValue([]);
  });

  it('getApiKey：provider → keychain key 转换 + 读取（只返回配置状态，不回传明文）', async () => {
    mocks.getSecret.mockResolvedValueOnce('sk-123' as never);
    const res = await handlers.getApiKey({ provider: 'deepseek' }, EMPTY_CTX);
    expect(mocks.getSecret).toHaveBeenCalledWith('deepseek-api-key');
    expect(res).toEqual({ configured: true });
    // P0 安全：响应中不得包含明文
    expect(JSON.stringify(res)).not.toContain('sk-123');
  });

  it('getApiKey：未配置 → configured 为 false', async () => {
    mocks.getSecret.mockResolvedValueOnce(null as never);
    const res = await handlers.getApiKey({ provider: 'deepseek' }, EMPTY_CTX);
    expect(res).toEqual({ configured: false });
  });

  it('setApiKey：加密存储 + ok:true', async () => {
    const res = await handlers.setApiKey({ provider: 'deepseek', apiKey: 'sk-new' }, EMPTY_CTX);
    expect(mocks.setSecret).toHaveBeenCalledWith('deepseek-api-key', 'sk-new');
    expect(res).toEqual({ ok: true });
  });

  it('deleteApiKey：删除 + ok:true（未配置也幂等）', async () => {
    const res = await handlers.deleteApiKey({ provider: 'deepseek' }, EMPTY_CTX);
    expect(mocks.deleteSecret).toHaveBeenCalledWith('deepseek-api-key');
    expect(res).toEqual({ ok: true });
  });

  it('异常：keychain 抛错 → 透传', async () => {
    mocks.getSecret.mockRejectedValueOnce(new Error('safeStorage unavailable'));
    await expect(handlers.getApiKey({ provider: 'deepseek' }, EMPTY_CTX)).rejects.toThrow(
      'safeStorage unavailable',
    );
  });
});

describe('settings.handler 遥测/审批（三件套）', () => {
  const permissionService = { setApprovalMode: vi.fn() };
  const handlers = createSettingsHandlers({
    permissionService: permissionService as never,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readTelemetryLevelSync.mockReturnValue('off');
    mocks.readApprovalModeSync.mockReturnValue('auto');
  });

  it('getTelemetryLevel：同步读取返回', async () => {
    const res = await handlers.getTelemetryLevel(undefined, EMPTY_CTX);
    expect(mocks.readTelemetryLevelSync).toHaveBeenCalled();
    expect(res).toEqual({ level: 'off' });
  });

  it('setTelemetryLevel：写入 + 返回新值', async () => {
    const res = await handlers.setTelemetryLevel({ level: 'error-only' }, EMPTY_CTX);
    expect(mocks.writeTelemetryLevel).toHaveBeenCalledWith('error-only');
    expect(res).toEqual({ ok: true, level: 'error-only' });
  });

  it('getApprovalMode：同步读取返回', async () => {
    const res = await handlers.getApprovalMode(undefined, EMPTY_CTX);
    expect(mocks.readApprovalModeSync).toHaveBeenCalled();
    expect(res).toEqual({ mode: 'auto' });
  });

  it('setApprovalMode：持久化 + 通知 PermissionService 运行时更新', async () => {
    const res = await handlers.setApprovalMode({ mode: 'ask' }, EMPTY_CTX);
    expect(mocks.writeApprovalMode).toHaveBeenCalledWith('ask');
    expect(permissionService.setApprovalMode).toHaveBeenCalledWith('ask');
    expect(res).toEqual({ ok: true, mode: 'ask' });
  });
});

describe('settings.handler 运行时模型（三件套）', () => {
  const permissionService = { setApprovalMode: vi.fn() };
  const handlers = createSettingsHandlers({
    permissionService: permissionService as never,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.runtimeList.mockResolvedValue([]);
  });

  it('addRuntimeModel：add + 缓存失效；baseUrl/apiKey 条件展开', async () => {
    await handlers.addRuntimeModel(
      {
        modelId: 'custom-1',
        providerKind: 'deepseek',
        baseUrl: 'http://localhost:8080',
        apiKey: 'k',
      },
      EMPTY_CTX,
    );
    expect(mocks.runtimeAdd).toHaveBeenCalledWith({
      modelId: 'custom-1',
      providerKind: 'deepseek',
      baseUrl: 'http://localhost:8080',
      apiKey: 'k',
    });
    expect(mocks.invalidateModel).toHaveBeenCalledWith('custom-1');
  });

  it('addRuntimeModel：baseUrl/apiKey 未传 → 不包含该字段', async () => {
    await handlers.addRuntimeModel({ modelId: 'm', providerKind: 'deepseek' } as never, EMPTY_CTX);
    expect(mocks.runtimeAdd).toHaveBeenCalledWith({ modelId: 'm', providerKind: 'deepseek' });
  });

  it('removeRuntimeModel：remove + 缓存失效', async () => {
    const res = await handlers.removeRuntimeModel({ modelId: 'm' }, EMPTY_CTX);
    expect(mocks.runtimeRemove).toHaveBeenCalledWith('m');
    expect(mocks.invalidateModel).toHaveBeenCalledWith('m');
    expect(res).toEqual({ ok: true });
  });

  it('listRuntimeModels：list → 领域形状映射（剔除敏感字段）', async () => {
    mocks.runtimeList.mockResolvedValueOnce([
      {
        modelId: 'm1',
        providerKind: 'deepseek',
        baseUrl: 'http://x',
        apiKey: 'secret',
        createdAt: 123,
      },
    ] as never);
    const res = await handlers.listRuntimeModels(undefined, EMPTY_CTX);
    expect(res).toEqual({
      models: [{ modelId: 'm1', providerKind: 'deepseek', baseUrl: 'http://x', createdAt: 123 }],
    });
  });

  it('listRuntimeModels：空列表 → 空数组', async () => {
    const res = await handlers.listRuntimeModels(undefined, EMPTY_CTX);
    expect(res).toEqual({ models: [] });
  });
});
