// src/main/ipc/settings.handler.test.ts
// settings.handler 单测：API Key 管理 + 遥测级别（真实 keychain 文件 + mock safeStorage）
//
// 测试维度：正向（set/get/delete/telemetry）

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// mock electron：safeStorage（可逆 mock）+ app（userData 指向临时目录）
const { mockSafeStorage, mockApp } = vi.hoisted(() => ({
  mockSafeStorage: {
    isEncryptionAvailable: vi.fn(() => true),
    getSelectedStorageBackend: vi.fn(() => 'basic_text'),
    encryptString: vi.fn((s: string) => Buffer.from(`enc:${s}`)),
    decryptString: vi.fn((b: Buffer) => b.toString('utf8').replace(/^enc:/, '')),
  },
  mockApp: {
    getPath: vi.fn((name: string) => (name === 'userData' ? TEMP_DIR_PLACEHOLDER : `/tmp/${name}`)),
    isPackaged: false,
  },
}));

vi.mock('electron', () => ({
  safeStorage: mockSafeStorage,
  app: mockApp,
}));

import { settingsHandlers } from './settings.handler';

/** 临时 userData 目录（真实文件 IO，符合无 mock 测试原则） */
const TEMP_DIR_PLACEHOLDER = '';

let tempDir: string;

describe('settings.handler', () => {
  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'code-agent-settings-test-'));
    mockApp.getPath.mockImplementation((name: string) =>
      name === 'userData' ? tempDir : `/tmp/${name}`,
    );
  });

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('setApiKey + getApiKey：加密写入后解密读取一致', async () => {
    await settingsHandlers.setApiKey({ provider: 'deepseek', apiKey: 'sk-test-123' }, {} as never);
    const result = await settingsHandlers.getApiKey({ provider: 'deepseek' }, {} as never);
    expect(result.apiKey).toBe('sk-test-123');
    expect(mockSafeStorage.encryptString).toHaveBeenCalledWith('sk-test-123');
  });

  it('getApiKey（未设置）：返回 null', async () => {
    const result = await settingsHandlers.getApiKey({ provider: 'anthropic' }, {} as never);
    expect(result.apiKey).toBeNull();
  });

  it('deleteApiKey：删除后 get 返回 null', async () => {
    await settingsHandlers.setApiKey({ provider: 'openai', apiKey: 'sk-openai' }, {} as never);
    await settingsHandlers.deleteApiKey({ provider: 'openai' }, {} as never);
    const result = await settingsHandlers.getApiKey({ provider: 'openai' }, {} as never);
    expect(result.apiKey).toBeNull();
  });

  it('getTelemetryLevel：默认 full', async () => {
    const result = await settingsHandlers.getTelemetryLevel(undefined, {} as never);
    expect(result.level).toBe('full');
  });

  it('setTelemetryLevel：写入后读取一致', async () => {
    await settingsHandlers.setTelemetryLevel({ level: 'off' }, {} as never);
    const result = await settingsHandlers.getTelemetryLevel(undefined, {} as never);
    expect(result.level).toBe('off');
  });
});
