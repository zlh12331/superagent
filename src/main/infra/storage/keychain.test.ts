// src/main/infra/storage/keychain.test.ts
// keychain 单测：safeStorage 加密存储（mock safeStorage + 真实文件 IO）
//
// 覆盖 P1 加固：
// - 读路径（getSecret / listSecrets）同样持互斥锁，不会与 set 的「读-改-写」交错
// - 文件损坏时逐条抢救（salvage）而非整库丢弃，并显式上报完整性报告

import {
  existsSync,
  promises as fsPromises,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSafeStorage, mockApp, mockLogger } = vi.hoisted(() => ({
  mockSafeStorage: {
    isEncryptionAvailable: vi.fn(() => true),
    getSelectedStorageBackend: vi.fn(() => 'basic_text'),
    encryptString: vi.fn((s: string) => Buffer.from(`enc:${s}`)),
    // 真实 safeStorage 对非本主密钥密文会抛错——测试桩必须同样抛，
    // 否则「不可解密条目计入 lost」的抢救语义无法被验证
    decryptString: vi.fn((b: Buffer) => {
      const text = b.toString('utf8');
      if (!text.startsWith('enc:')) {
        throw new Error('DPAPI decrypt failed');
      }
      return text.slice(4);
    }),
  },
  mockApp: { getPath: vi.fn(() => '/tmp/keychain-test') },
  mockLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withTrace: vi.fn(),
  },
}));

vi.mock('electron', () => ({
  safeStorage: mockSafeStorage,
  app: mockApp,
}));

vi.mock('../../utils/logger', () => ({ logger: mockLogger }));

import { deleteSecret, getKeychainIntegrity, getSecret, listSecrets, setSecret } from './keychain';

/** 明文字符串 → keychain.dat 中存储的密文数组（与 encryptString 桩一致） */
function cipherBytes(plaintext: string): number[] {
  return Array.from(Buffer.from(`enc:${plaintext}`));
}

function keychainFile(): string {
  return join(tempDir, 'keychain.dat');
}

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
    rmSync(tempDir, { recursive: true, force: true });
    mkdirSync(tempDir, { recursive: true });
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

  it('首次使用（文件不存在）：不谎报损坏', async () => {
    expect(await getSecret('any')).toBeNull();
    expect(getKeychainIntegrity()).toBeNull();
    expect(mockLogger.error).not.toHaveBeenCalled();
  });

  describe('并发保护（读路径持锁）', () => {
    it('get-while-set：get 必须等 set 释放锁，读到新值而非旧快照', async () => {
      await setSecret('lock-key', 'before');

      // 让 setSecret 的第一次 readFile 挂起 → set 处于「持锁未写完」窗口
      let releaseGate: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        releaseGate = resolve;
      });
      let firstRead = true;
      // readFile 是 overload 集合，无法直接透传 unknown[]：显式收窄为宽松签名
      const originalRead = fsPromises.readFile as (
        this: typeof fsPromises,
        ...args: unknown[]
      ) => Promise<string>;
      const spy = vi
        .spyOn(fsPromises, 'readFile')
        .mockImplementation(async (...args: unknown[]) => {
          if (firstRead) {
            firstRead = false;
            await gate;
          }
          return originalRead.call(fsPromises, ...args);
        });

      try {
        const setPromise = setSecret('lock-key', 'after');
        // setSecret 同步进入锁并停在挂起的 readFile 上；此时并发发起读取
        const getPromise = getSecret('lock-key');
        releaseGate();

        await expect(getPromise).resolves.toBe('after');
        await setPromise;
      } finally {
        spy.mockRestore();
      }
    });

    it('并发 setSecret：两个 key 都存活（无丢更新）', async () => {
      await Promise.all([setSecret('c1', 'v1'), setSecret('c2', 'v2'), setSecret('c3', 'v3')]);
      expect((await listSecrets()).sort()).toEqual(['c1', 'c2', 'c3']);
    });
  });

  describe('损坏文件逐条抢救', () => {
    it('截断写入：完好条目解密回写，坏尾丢弃，原件隔离为 .corrupt', async () => {
      writeFileSync(
        keychainFile(),
        [
          '{',
          `  "good-a": ${JSON.stringify(cipherBytes('k1'))},`,
          `  "good-b": ${JSON.stringify(cipherBytes('k2'))},`,
          '  "undecryptable": [1,2,3],',
          '  "trunc',
        ].join('\n'),
        'utf8',
      );

      expect(await getSecret('good-a')).toBe('k1');
      expect(await getSecret('good-b')).toBe('k2');
      expect(await getSecret('undecryptable')).toBeNull();

      expect(getKeychainIntegrity()).toEqual({
        corrupted: true,
        recoverable: true,
        salvaged: 2,
        lost: 1,
      });
      // 显式告警（不再静默返回空）
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ filePath: keychainFile(), salvaged: 2, lost: 1 }),
        expect.stringContaining('已损坏'),
      );
      // 原件保留为 .corrupt，健康子集回写
      expect(existsSync(`${keychainFile()}.corrupt`)).toBe(true);
      const rewritten = JSON.parse(readFileSync(keychainFile(), 'utf8')) as Record<string, unknown>;
      expect(Object.keys(rewritten).sort()).toEqual(['good-a', 'good-b']);
    });

    it('结构非法（对象/字符串值）：按损坏处理且不可恢复时不回写', async () => {
      writeFileSync(
        keychainFile(),
        '{\n  "a": [1,2,3],\n  "b": "not-bytes",\n}\n...trailing-garbage',
        'utf8',
      );

      expect(await listSecrets()).toEqual([]);
      expect(getKeychainIntegrity()).toEqual({
        corrupted: true,
        recoverable: false,
        salvaged: 0,
        lost: 1,
      });
      // 无可救条目 → 不写回（避免把空库伪装成有效快照）
      expect(existsSync(keychainFile())).toBe(false);
      expect(existsSync(`${keychainFile()}.corrupt`)).toBe(true);
    });

    it('抢救后的文件可继续正常读写', async () => {
      writeFileSync(
        keychainFile(),
        `{\n  "good": ${JSON.stringify(cipherBytes('saved'))},\n  "dead": [9,9]`,
        'utf8',
      );
      expect(await getSecret('good')).toBe('saved');
      await setSecret('fresh', 'new-value');
      expect(await getSecret('fresh')).toBe('new-value');
      expect(await getSecret('good')).toBe('saved');
    });
  });
});
