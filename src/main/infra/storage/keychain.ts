// src/main/infra/storage/keychain.ts
// 敏感数据加密存储（API Key 等）
// 设计文档 §1.2 决策 5：API Key 存钥匙串
//
// 使用 Electron 内置 safeStorage API（替代 keytar）：
// - 基于 OS 加密（Windows DPAPI / macOS Keychain / Linux libsecret）
// - 不需要 native rebuild，符合 Electron 官方安全建议
// - 加密后的数据存储到 keychain.dat 文件（JSON 格式）
//
// 设计文档 §2.2 列出 keytar ^7，但 safeStorage 更优：
// 1. 内置于 Electron，无需额外依赖
// 2. 不需要 native rebuild（keytar 需要）
// 3. 跨平台一致 API

import { promises as fs } from 'node:fs';
import { safeStorage } from 'electron';
import { getKeychainPath } from './app-data';

/**
 * 互斥锁（用于保护 keychain 文件的并发读写）
 *
 * 场景：多个 IPC 请求同时调用 setSecret 时，若没有锁保护，
 * readStore() 可能读取到旧数据，writeStore() 会覆盖其他请求的写入，
 * 导致数据丢失。
 *
 * 实现：用 Promise 链式调用实现简单的互斥锁，
 * 每个操作必须等待前一个操作完成才能执行。
 */
let lock: Promise<void> = Promise.resolve();

/**
 * 获取互斥锁
 *
 * @returns 释放锁的函数
 */
function acquireLock(): () => void {
  const releaseRef: { value: () => void } = { value: () => {} };
  const next = new Promise<void>((resolve) => {
    releaseRef.value = resolve;
  });
  const current = lock;
  lock = current.then(() => next);
  return releaseRef.value;
}

/**
 * Keychain 存储结构
 *
 * key: secret 名称（如 'deepseek-api-key'）
 * value: 加密后的 Buffer 转换为 number[]（JSON 可序列化）
 */
type KeychainStore = Record<string, number[]>;

/**
 * 读取 keychain 文件
 *
 * 文件不存在时返回空对象
 */
async function readStore(): Promise<KeychainStore> {
  const filePath = getKeychainPath();
  try {
    const content = await fs.readFile(filePath, 'utf8');
    return JSON.parse(content) as KeychainStore;
  } catch (error: unknown) {
    // 文件不存在（ENOENT）或解析失败，返回空存储
    if (error instanceof Error && error.message.includes('ENOENT')) {
      return {};
    }
    // 其他错误（如 JSON 解析失败）也返回空存储，避免阻塞应用
    return {};
  }
}

/**
 * 写入 keychain 文件
 */
async function writeStore(store: KeychainStore): Promise<void> {
  const filePath = getKeychainPath();
  const content = JSON.stringify(store, null, 2);
  await fs.writeFile(filePath, content, 'utf8');
}

/**
 * 存储加密的敏感数据
 *
 * @param key secret 名称（如 'deepseek-api-key'）
 * @param value 原始值（会被加密后存储）
 */
export async function setSecret(key: string, value: string): Promise<void> {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('safeStorage 加密不可用，无法存储敏感数据');
  }

  const release = acquireLock();
  try {
    const encrypted = safeStorage.encryptString(value);
    const store = await readStore();
    store[key] = Array.from(encrypted);
    await writeStore(store);
  } finally {
    release();
  }
}

/**
 * 读取并解密敏感数据
 *
 * @param key secret 名称
 * @returns 原始值，不存在时返回 null
 */
export async function getSecret(key: string): Promise<string | null> {
  if (!safeStorage.isEncryptionAvailable()) {
    return null;
  }

  const store = await readStore();
  const encryptedArray = store[key];
  if (encryptedArray === undefined) {
    return null;
  }

  const encrypted = Buffer.from(encryptedArray);
  return safeStorage.decryptString(encrypted);
}

/**
 * 删除指定 secret
 *
 * @param key secret 名称
 */
export async function deleteSecret(key: string): Promise<void> {
  const store = await readStore();
  if (store[key] !== undefined) {
    delete store[key];
    await writeStore(store);
  }
}

/**
 * 列出所有已存储的 secret 名称
 *
 * @returns secret key 数组
 */
export async function listSecrets(): Promise<string[]> {
  const store = await readStore();
  return Object.keys(store);
}
