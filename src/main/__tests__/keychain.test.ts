// src/main/__tests__/keychain.test.ts
// keychain 加密存储单测
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Vitest 4 的 vi.mock 会被 hoist，工厂函数内不能引用外部 const
// 必须用 vi.hoisted 导出 mock 对象
const { mockSafeStorage, fsMocks } = vi.hoisted(() => {
  // safeStorage mock：模拟加密/解密
  const mockSafeStorage = {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((s: string) => Buffer.from(`encrypted:${s}`)),
    decryptString: vi.fn((b: Buffer) => {
      const str = b.toString();
      return str.startsWith('encrypted:') ? str.slice('encrypted:'.length) : '';
    }),
  };
  // node:fs promises mock：避免真实文件 IO
  // 必须用 vi.mock 整体替换 node:fs，因为 ESM import binding 不可被 spyOn 修改
  const fsMocks = {
    readFile: vi.fn(),
    writeFile: vi.fn(),
    unlink: vi.fn(),
  };
  return { mockSafeStorage, fsMocks };
});

vi.mock('electron', () => ({
  safeStorage: mockSafeStorage,
  app: { getPath: vi.fn((name: string) => `/tmp/test-userdata/${name}`) },
}));

// mock node:fs 的 promises 命名空间（keychain.ts 通过 `import { promises as fs } from 'node:fs'` 引用）
vi.mock('node:fs', () => ({
  promises: fsMocks,
}));

import { deleteSecret, getSecret, listSecrets, setSecret } from '../infra/storage/keychain';

describe('keychain', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // 默认：文件不存在（ENOENT）
    fsMocks.readFile.mockRejectedValue(new Error('ENOENT'));
    fsMocks.writeFile.mockResolvedValue(undefined);
    fsMocks.unlink.mockResolvedValue(undefined);
  });

  it('setSecret 加密并存储', async () => {
    await setSecret('deepseek-api-key', 'sk-test-123');
    expect(mockSafeStorage.encryptString).toHaveBeenCalledWith('sk-test-123');
    expect(fsMocks.writeFile).toHaveBeenCalled();
  });

  it('getSecret 解密返回原值', async () => {
    // 模拟已存储的加密数据
    const encrypted = Buffer.from('encrypted:sk-test-123');
    fsMocks.readFile.mockResolvedValue(
      JSON.stringify({
        'deepseek-api-key': Array.from(encrypted),
      }),
    );

    const result = await getSecret('deepseek-api-key');
    expect(result).toBe('sk-test-123');
    expect(mockSafeStorage.decryptString).toHaveBeenCalledWith(encrypted);
  });

  it('getSecret 不存在的 key 返回 null', async () => {
    fsMocks.readFile.mockResolvedValue('{}');

    const result = await getSecret('nonexistent');
    expect(result).toBeNull();
  });

  it('deleteSecret 删除指定 key', async () => {
    fsMocks.readFile.mockResolvedValue(
      JSON.stringify({
        'deepseek-api-key': [1, 2, 3],
        'other-key': [4, 5, 6],
      }),
    );

    await deleteSecret('deepseek-api-key');
    expect(fsMocks.writeFile).toHaveBeenCalled();
    // 写入的内容应该只包含 other-key
    // noUncheckedIndexedAccess：calls[0] 类型为 T | undefined，需显式 if 检查抛错
    // 不能用非空断言 `!`（biome noNonNullAssertion 禁止）
    const writeCall = vi.mocked(fsMocks.writeFile).mock.calls[0];
    if (!writeCall) {
      throw new Error('writeFile 应该被调用至少一次');
    }
    const written = JSON.parse(writeCall[1] as string);
    expect(written['deepseek-api-key']).toBeUndefined();
    expect(written['other-key']).toBeDefined();
  });

  it('listSecrets 返回所有 key', async () => {
    fsMocks.readFile.mockResolvedValue(
      JSON.stringify({
        'deepseek-api-key': [1, 2, 3],
        'other-key': [4, 5, 6],
      }),
    );

    const keys = await listSecrets();
    expect(keys).toEqual(['deepseek-api-key', 'other-key']);
  });

  it('加密不可用时抛错', async () => {
    mockSafeStorage.isEncryptionAvailable.mockReturnValueOnce(false);
    await expect(setSecret('test', 'value')).rejects.toThrow();
  });
});
