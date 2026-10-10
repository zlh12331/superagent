import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { closeDb, type DrizzleDB, initDb, resetDb } from '../../../src/main/infra/storage/db';

/** setup.ts 注册的共享状态（electron mock 的可变引用） */
interface ItState {
  userData: string;
  dialogResult: { canceled: boolean; filePath?: string };
}

function getItState(): ItState {
  return (globalThis as Record<string, unknown>)['__itState'] as ItState;
}

/** 设置 dialog 返回结果（exportAll 用例用；默认取消） */
export function setDialogResult(result: { canceled: boolean; filePath?: string }): void {
  getItState().dialogResult = result;
}

/**
 * 每用例独立临时 userData + 真实初始化 DB，执行回调后清理。
 *
 * @param fn 用例逻辑（收到真实 drizzle 实例）
 */
export async function withTempUserData<T>(fn: (db: DrizzleDB) => Promise<T> | T): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'code-agent-it-'));
  getItState().userData = dir;
  try {
    await closeDb();
    resetDb();
    const db = initDb();
    return await fn(db);
  } finally {
    await closeDb();
    resetDb();
    rmSync(dir, { recursive: true, maxRetries: 5 });
  }
}
