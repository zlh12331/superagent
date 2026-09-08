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

import { execFileSync } from 'node:child_process';
import { chmodSync, promises as fs } from 'node:fs';
import { join } from 'node:path';
import { safeStorage } from 'electron';
import { logger } from '../../utils/logger';
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
 *
 * P1 修复：旧实现只在链上登记槽位后**同步返回 release**，调用方从未等待
 * 前一个持有者——链形同虚设，并发 setSecret 的「读-改-写」互相覆盖（丢更新）。
 * 现在返回 `Promise<release>`，必须 `await` 才算真正进入临界区。
 */
let lock: Promise<void> = Promise.resolve();

/**
 * 获取互斥锁（等待前一个持有者释放）
 *
 * @returns resolve 后即为「已持锁」，resolve 值为释放锁的函数
 */
function acquireLock(): Promise<() => void> {
  // 登记必须同步完成（保证 FIFO），只有「等待」是异步的
  const waiting = lock;
  let release: () => void = () => {};
  const slot = new Promise<void>((resolve) => {
    release = resolve;
  });
  lock = waiting.then(() => slot);
  return waiting.then(() => release);
}

/**
 * Keychain 存储结构
 *
 * key: secret 名称（如 'deepseek-api-key'）
 * value: 加密后的 Buffer 转换为 number[]（JSON 可序列化）
 */
type KeychainStore = Record<string, number[]>;

/**
 * 文件损坏处置结果（供上层向用户显式告警，而非静默返回空）
 *
 * - corrupted：本次读取遇到无法整体解析的 keychain.dat
 * - recoverable：至少一条条目经解密校验后已回写恢复
 * - salvaged / lost： salvage 存活条目数 / 无法恢复条目数
 */
export interface KeychainIntegrity {
  readonly corrupted: boolean;
  readonly recoverable: boolean;
  readonly salvaged: number;
  readonly lost: number;
}

/** 最近一次损坏处置报告（未发生损坏为 null；设置页可据此提示用户重新录入密钥） */
let lastIntegrity: KeychainIntegrity | null = null;

/** 读取最近一次 keychain 完整性报告（无损坏历史时 null） */
export function getKeychainIntegrity(): KeychainIntegrity | null {
  return lastIntegrity;
}

/** 值是否为「加密字节数组」形状（number[] 且元素在 0..255） */
function isEncryptedArray(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.every((n) => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 255)
  );
}

/** 整体结构校验：仅接受 key → 字节数组 的平对象（其余按损坏处理） */
function isKeychainStore(value: unknown): value is KeychainStore {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  return Object.values(value).every(isEncryptedArray);
}

/** 条目片段正则：`"key": [ 1,2,3 ]`——截断写入时仍能逐条捞出完整配对（忽略未闭合尾巴） */
const ENTRY_FRAGMENT_PATTERN = /"((?:[^"\\]|\\.)+)"\s*:\s*(\[[^\][]*\])/g;

/**
 * 逐条抢救损坏文件（P1 修复：此前整文件判损坏即弃，全部 API Key 静默消失）
 *
 * 只保留「能解析出字节数组」且「safeStorage 能解开」的条目——解不开的
 * （跨系统用户 / DPAPI 主密钥轮换）留也只会反复报错，计入 lost。
 */
function salvageEntries(raw: string): { store: KeychainStore; candidates: number } {
  const store: KeychainStore = {};
  let candidates = 0;
  for (const match of raw.matchAll(ENTRY_FRAGMENT_PATTERN)) {
    const [, rawKey, rawArray] = match;
    if (rawKey === undefined || rawArray === undefined) {
      continue;
    }
    candidates += 1;
    try {
      const parsed = JSON.parse(rawArray) as unknown;
      if (!isEncryptedArray(parsed)) {
        continue;
      }
      safeStorage.decryptString(Buffer.from(parsed));
      store[JSON.parse(`"${rawKey}"`) as string] = parsed;
    } catch {
      // 单条不可解析/不可解密：跳过（计入 lost），不阻断其余条目
    }
  }
  return { store, candidates };
}

/**
 * 读取 keychain 文件（损坏时逐条抢救并回写健康子集）
 *
 * 文件不存在时返回空对象（首次使用，不算损坏）。
 */
async function readStore(): Promise<KeychainStore> {
  const filePath = getKeychainPath();
  let content: string;
  try {
    content = await fs.readFile(filePath, 'utf8');
  } catch (error: unknown) {
    // ENOENT = 首次使用；其他读错误（权限等）不谎报损坏，静默按空处理由写入覆盖
    if (!(error instanceof Error && error.message.includes('ENOENT'))) {
      logger.error(
        { error: error instanceof Error ? error.message : String(error), filePath },
        'keychain.dat 读取失败',
      );
    }
    return {};
  }

  try {
    const parsed = JSON.parse(content) as unknown;
    if (isKeychainStore(parsed)) {
      return parsed;
    }
    throw new Error('keychain.dat 结构不符合契约');
  } catch {
    // 结构损坏（半截写入 / 手工改坏）：先逐条抢救，再隔离原件，最后回写健康子集
    const { store: salvaged, candidates } = salvageEntries(content);
    const report: KeychainIntegrity = {
      corrupted: true,
      recoverable: Object.keys(salvaged).length > 0,
      salvaged: Object.keys(salvaged).length,
      lost: Math.max(candidates - Object.keys(salvaged).length, 0),
    };
    lastIntegrity = report;
    logger.error(
      { filePath, ...report },
      'keychain.dat 已损坏——按条目抢救（salvaged/lost），原件保留为 .corrupt',
    );
    try {
      await fs.rename(filePath, `${filePath}.corrupt`);
    } catch {
      // 重命名失败（权限等）不阻断：仍继续回写健康子集
    }
    if (report.recoverable) {
      await writeStore(salvaged);
    }
    return salvaged;
  }
}

/**
 * 写入 keychain 文件（原子写）
 *
 * 安全修复：keychain.dat 含加密的 API Key，限制为仅属主可读写（0o600）。
 * - writeFile mode 仅对新建文件生效，后续覆盖写入需显式 chmod 兜底
 *
 * 原子性（2026-09-06 审计修复）：先写同目录 `.tmp` → fsync → rename 覆盖。
 * 此前直接覆盖主文件，写入过程中断电/强杀会留下半截 JSON——读侧虽有逐条
 * salvage 抢救，但正在写入的那条 Key 会丢，且抢救结果依赖正则对截断内容的容忍度。
 */
async function writeStore(store: KeychainStore): Promise<void> {
  const filePath = getKeychainPath();
  const content = JSON.stringify(store, null, 2);
  const tmpPath = `${filePath}.tmp`;
  try {
    const handle = await fs.open(tmpPath, 'w', 0o600);
    try {
      await handle.writeFile(content, 'utf8');
      // fsync：确保内容真正落盘后再 rename（rename 本身是原子的）
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(tmpPath, filePath);
  } catch (error) {
    // 失败清理临时文件，避免残留（读路径只认 keychain.dat，不受影响）
    await fs.rm(tmpPath, { force: true }).catch(() => undefined);
    throw error;
  }
  restrictKeychainPermissions(filePath);
}

/**
 * 收紧 keychain.dat 权限（POSIX chmod 0600 / Windows icacls 仅当前用户）
 *
 * DPAPI/Keychain 加密是主防线，文件权限是纵深防御——失败仅告警不阻断。
 */
function restrictKeychainPermissions(filePath: string): void {
  if (process.platform !== 'win32') {
    try {
      chmodSync(filePath, 0o600);
    } catch {
      // 权限设置失败不阻断写入（只读文件系统等场景）
    }
    return;
  }
  try {
    const user = process.env['USERNAME'] ?? process.env['USER'] ?? '';
    if (user.length === 0) {
      return;
    }
    // 解析系统绝对路径（不依赖 PATH）：%SystemRoot%\System32\icacls.exe
    const icaclsExe =
      process.env['SystemRoot'] !== undefined
        ? join(process.env['SystemRoot'], 'System32', 'icacls.exe')
        : 'icacls';
    execFileSync(icaclsExe, [filePath, '/inheritance:r', '/grant:r', `${user}:F`], {
      stdio: 'ignore',
    });
  } catch {
    logger.warn({ filePath }, 'keychain.dat Windows ACL 收紧失败（DPAPI 仍为主防线）');
  }
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

  const release = await acquireLock();
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

  // P1 修复：读路径同样持锁——此前 get 无锁，可与 set/delete 的「读-改-写」
  // 以及损坏文件的 rename 交错，读到随即被隔离的孤儿快照（甚至丢条目）
  const release = await acquireLock();
  try {
    const store = await readStore();
    const encryptedArray = store[key];
    if (encryptedArray === undefined) {
      return null;
    }

    const encrypted = Buffer.from(encryptedArray);
    return safeStorage.decryptString(encrypted);
  } finally {
    release();
  }
}

/**
 * 删除指定 secret
 *
 * @param key secret 名称
 */
export async function deleteSecret(key: string): Promise<void> {
  // P1 修复：delete 是读改写，必须与 setSecret 同锁——否则运行时模型删除密钥
  // 与设置页保存密钥并发时，delete 的旧读会覆盖 set 刚写入的 key（丢更新）
  const release = await acquireLock();
  try {
    const store = await readStore();
    if (store[key] !== undefined) {
      delete store[key];
      await writeStore(store);
    }
  } finally {
    release();
  }
}

/**
 * 列出所有已存储的 secret 名称
 *
 * @returns secret key 数组
 */
export async function listSecrets(): Promise<string[]> {
  // 读路径持锁：readStore 可能触发损坏抢救（rename + 回写），不能与 set/delete 交错
  const release = await acquireLock();
  try {
    const store = await readStore();
    return Object.keys(store);
  } finally {
    release();
  }
}
