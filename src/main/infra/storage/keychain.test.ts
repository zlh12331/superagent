// src/main/infra/storage/keychain.test.ts
// keychain 单测：safeStorage 加密存储（mock safeStorage + 真实文件 IO）

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSafeStorage, mockApp } = vi.hoisted(() => ({
  mockSafeStorage: {
    isEncryptionAvailable: vi.fn(() => true),
    getSelectedStorageBackend: vi.fn(() => 'basic_text'),
    encryptString: vi.fn((s: string) => Buffer.from(`enc:${s}`)),
    decryptString: vi.fn((b: Buffer) => b.toString('utf8').replace(/^enc:/, '')),
  },
  mockApp: { getPath: vi.fn(() => '/tmp/keychain-test') },
}));

vi.mock('electron', () => ({
  safeStorage: mockSafeStorage,
  app: mockApp,
}));

import { deleteSecret, getSecret, listSecrets, setSecret } from './keychain';

let tempDir: string;

describe('keychain', () => {
  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'code-agent-keychain-test-'));
    mockApp.getPath.mockReturnValue(tempDir);
  });

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('setSecret + getSecret：加密写入后解密读取一致', async () => {
    await setSecret('deepseek-api-key', 'sk-secret-1');
    const value = await getSecret('deepseek-api-key');
    expect(value).toBe('sk-secret-1');
    expect(mockSafeStorage.encryptString).toHaveBeenCalledWith('sk-secret-1');
    expect(mockSafeStorage.decryptString).toHaveBeenCalled();
  });

  it('getSecret（未设置）：返回 null', async () => {
    expect(await getSecret('nonexistent-key')).toBeNull();
  });

  it('deleteSecret：删除后 get 返回 null', async () => {
    await setSecret('tmp-key', 'v');
    await deleteSecret('tmp-key');
    expect(await getSecret('tmp-key')).toBeNull();
  });

  it('deleteSecret（不存在）：幂等不抛错', async () => {
    await expect(deleteSecret('missing-key')).resolves.toBeUndefined();
  });

  it('listSecrets：返回已存储的 key 列表', async () => {
    await setSecret('key-a', '1');
    await setSecret('key-b', '2');
    const keys = await listSecrets();
    expect(keys).toContain('key-a');
    expect(keys).toContain('key-b');
  });

  it('多个 key 独立存储互不覆盖', async () => {
    await setSecret('k1', 'v1');
    await setSecret('k2', 'v2');
    expect(await getSecret('k1')).toBe('v1');
    expect(await getSecret('k2')).toBe('v2');
  });
});
