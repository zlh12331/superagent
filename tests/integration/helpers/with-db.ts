// tests/integration/helpers/with-db.ts
// 集成测试共享基建：真实 db.ts + 临时 userData（简化环境 Medium Test）
// ──────────────────────────────────────────────────────────────
// electron 替身由 setup.ts 全局注册（app.getPath → 本模块切换的临时目录）；
// 此处仅负责：每用例创建独立临时目录、真实初始化 DB、用后关闭清理。
// 对应用例：await withTempUserData(async (db) => { ... })
// ──────────────────────────────────────────────────────────────

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
    // 真正关闭连接释放句柄（resetDb 仅清缓存不 close）——否则 Windows 下临时目录清理 EPERM
    await closeDb();
    resetDb();
    rmSync(dir, { recursive: true, maxRetries: 5 });
  }
}
