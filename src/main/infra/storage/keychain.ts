import { execFileSync } from 'node:child_process';
import { chmodSync, promises as fs } from 'node:fs';
import { join } from 'node:path';
import { AppError, ErrorCode } from '@code-agent/shared/main';
import { safeStorage } from 'electron';
import { logger } from '../../utils/logger';
import { getKeychainPath } from './app-data';

let lock: Promise<void> = Promise.resolve();

let warnedEncryptionUnavailable = false;

export function isEncryptionAvailable(): boolean {
  return safeStorage.isEncryptionAvailable();
}

function acquireLock(): Promise<() => void> {
  const waiting = lock;
  let release: () => void = () => {};
  const slot = new Promise<void>((resolve) => {
    release = resolve;
  });
  lock = waiting.then(() => slot);
  return waiting.then(() => release);
}

type KeychainStore = Record<string, number[]>;

export interface KeychainIntegrity {
  readonly corrupted: boolean;
  readonly recoverable: boolean;
  readonly salvaged: number;
  readonly lost: number;
}

let lastIntegrity: KeychainIntegrity | null = null;

export function getKeychainIntegrity(): KeychainIntegrity | null {
  return lastIntegrity;
}

function isEncryptedArray(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.every((n) => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 255)
  );
}

function isKeychainStore(value: unknown): value is KeychainStore {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  return Object.values(value).every(isEncryptedArray);
}

const ENTRY_FRAGMENT_PATTERN = /"((?:[^"\\]|\\.)+)"\s*:\s*(\[[^\][]*\])/g;

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
    } catch {}
  }
  return { store, candidates };
}

function throwKeychainReadError(error: unknown, filePath: string): never {
  const message = error instanceof Error ? error.message : String(error);
  logger.error(
    { error: message, filePath },
    'keychain.dat 读取失败（拒绝以降级空库继续，避免覆盖既有密钥）',
  );
  throw new AppError(
    ErrorCode.INTERNAL_ERROR,
    `密钥库读取失败，已中止本次操作以保护既有密钥：${message}`,
  );
}

async function readStore(): Promise<KeychainStore> {
  const filePath = getKeychainPath();
  let content: string;
  try {
    content = await fs.readFile(filePath, 'utf8');
  } catch (error: unknown) {
    if (error instanceof Error && error.message.includes('ENOENT')) {
      return {};
    }
    throwKeychainReadError(error, filePath);
  }

  try {
    const parsed = JSON.parse(content) as unknown;
    if (isKeychainStore(parsed)) {
      return parsed;
    }
    throw new Error('keychain.dat 结构不符合契约');
  } catch {
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
    } catch {}
    if (report.recoverable) {
      await writeStore(salvaged);
    }
    return salvaged;
  }
}

async function writeStore(store: KeychainStore): Promise<void> {
  const filePath = getKeychainPath();
  const content = JSON.stringify(store, null, 2);
  const tmpPath = `${filePath}.tmp`;
  try {
    const handle = await fs.open(tmpPath, 'w', 0o600);
    try {
      await handle.writeFile(content, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(tmpPath, filePath);
  } catch (error) {
    await fs.rm(tmpPath, { force: true }).catch(() => undefined);
    throw error;
  }
  restrictKeychainPermissions(filePath);
}

function resolveWindowsAccount(): string {
  const systemRoot = process.env['SystemRoot'];
  const whoamiExe =
    systemRoot !== undefined ? join(systemRoot, 'System32', 'whoami.exe') : 'whoami';
  try {
    return execFileSync(whoamiExe, [], { encoding: 'utf8', timeout: 3000 }).trim();
  } catch {
    return '';
  }
}

function restrictKeychainPermissions(filePath: string): void {
  if (process.platform !== 'win32') {
    try {
      chmodSync(filePath, 0o600);
    } catch {}
    return;
  }
  const user = resolveWindowsAccount();
  if (user.length === 0) {
    logger.warn({ filePath }, 'keychain.dat Windows ACL 收紧跳过（whoami 未解析到账户）');
    return;
  }
  try {
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

export { restrictKeychainPermissions as restrictFileAccessWin32 };

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

export async function getSecret(key: string): Promise<string | null> {
  if (!safeStorage.isEncryptionAvailable()) {
    if (!warnedEncryptionUnavailable) {
      warnedEncryptionUnavailable = true;
      logger.warn(
        { key },
        'safeStorage 加密不可用：已保存的 API Key 均不可读取（getSecret 返回 null）',
      );
    }
    return null;
  }

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

export async function deleteSecret(key: string): Promise<void> {
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

export async function listSecrets(): Promise<string[]> {
  const release = await acquireLock();
  try {
    const store = await readStore();
    return Object.keys(store);
  } finally {
    release();
  }
}
