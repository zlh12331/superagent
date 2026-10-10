import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  applyPendingRestore,
  BACKUP_KEEP,
  backupDirPath,
  createBackupFile,
  isBackupHealthy,
  listBackups,
  RESTORE_PENDING_FILENAME,
  stageRestore,
} from './backup-store';

let tempDir: string;
let dbPath: string;

/** 建一个真实 SQLite 库文件（可选写入一行以区分内容） */
function makeDbFile(path: string, marker?: string): Database.Database {
  const db = new Database(path);
  db.exec('CREATE TABLE IF NOT EXISTS t (v TEXT)');
  if (marker !== undefined) {
    db.prepare('INSERT INTO t (v) VALUES (?)').run(marker);
  }
  return db;
}

/** 读库内的 marker（验证恢复点内容确实生效） */
function readMarker(path: string): string | null {
  const db = new Database(path, { readonly: true });
  try {
    const row = db.prepare('SELECT v FROM t LIMIT 1').get() as { v: string } | undefined;
    return row?.v ?? null;
  } finally {
    db.close();
  }
}

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'code-agent-backup-test-'));
});

afterAll(() => {
  try {
    rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {}
});

beforeEach(() => {
  const caseDir = mkdtempSync(join(tempDir, 'case-'));
  dbPath = join(caseDir, 'sessions.db');
});

describe('createBackupFile（热备份 + 轮转）', () => {
  it('正向：备份落盘为 sessions-*.db、内容可读、返回裸名', async () => {
    const db = makeDbFile(dbPath, 'hello');
    try {
      const name = await createBackupFile(db, dbPath);

      expect(name).toMatch(/^sessions-.*\.db$/);
      const backupPath = join(backupDirPath(dbPath), name);
      expect(existsSync(backupPath)).toBe(true);
      expect(readMarker(backupPath)).toBe('hello');
    } finally {
      db.close();
    }
  });

  it('轮转：超出 BACKUP_KEEP 份时删除最旧（按名排序）', async () => {
    const db = makeDbFile(dbPath);
    try {
      for (let i = 0; i < BACKUP_KEEP + 2; i++) {
        await createBackupFile(db, dbPath);
      }
      const names = readdirSync(backupDirPath(dbPath)).filter(
        (n) => n.startsWith('sessions-') && n.endsWith('.db'),
      );
      expect(names).toHaveLength(BACKUP_KEEP);
      expect(names.some((n) => n.endsWith('.tmp'))).toBe(false);
    } finally {
      db.close();
    }
  });
});

describe('listBackups（恢复点列表）', () => {
  it('空目录 → 空数组（目录不存在与空列表同语义）', () => {
    expect(listBackups(dbPath)).toEqual([]);
  });

  it('正向：最新在前、含大小/时间/健康度', async () => {
    const db = makeDbFile(dbPath, 'x');
    try {
      await createBackupFile(db, dbPath);
      const dir = backupDirPath(dbPath);
      mkdirSync(dir, { recursive: true });
      const older = join(dir, 'sessions-2020-01-01T00-00-00.db');
      writeFileSync(older, 'not-a-db');

      const entries = listBackups(dbPath);
      expect(entries).toHaveLength(2);
      expect(entries[0]?.name.startsWith('sessions-20')).toBe(true);
      expect(entries[0]?.createdAtMs).toBeGreaterThan(entries[1]?.createdAtMs ?? 0);
      expect(entries[0]?.sizeBytes).toBeGreaterThan(0);
      expect(entries[0]?.healthy).toBe(true);
      expect(entries[1]?.healthy).toBe(false);
    } finally {
      db.close();
    }
  });
});

describe('isBackupHealthy', () => {
  it('真实 SQLite → true；垃圾文件 → false；不存在 → false', () => {
    const good = join(tempDir, 'good.db');
    const db = makeDbFile(good);
    db.close();
    const bad = join(tempDir, 'bad.db');
    writeFileSync(bad, 'garbage');

    expect(isBackupHealthy(good)).toBe(true);
    expect(isBackupHealthy(bad)).toBe(false);
    expect(isBackupHealthy(join(tempDir, 'missing.db'))).toBe(false);
  });

  it('伴生文件清理：WAL 备份被探针只读打开后不留 -shm/-wal（探针副作用）', async () => {
    const db = makeDbFile(dbPath, 'x');
    try {
      const name = await createBackupFile(db, dbPath);
      const backupPath = join(backupDirPath(dbPath), name);
      expect(existsSync(`${backupPath}-shm`)).toBe(false);
      expect(existsSync(`${backupPath}-wal`)).toBe(false);

      expect(isBackupHealthy(backupPath)).toBe(true);

      expect(existsSync(`${backupPath}-shm`)).toBe(false);
      expect(existsSync(`${backupPath}-wal`)).toBe(false);
    } finally {
      db.close();
    }
  });
});

describe('stageRestore（暂存 + 重启生效）', () => {
  it('正向：健康备份暂存为 restore-pending（主库未被触碰）', async () => {
    const db = makeDbFile(dbPath, 'original');
    try {
      const name = await createBackupFile(db, dbPath);
      stageRestore(dbPath, name);

      const pending = join(dirname(dbPath), RESTORE_PENDING_FILENAME);
      expect(existsSync(pending)).toBe(true);
      expect(readMarker(pending)).toBe('original');
    } finally {
      db.close();
    }
  });

  it('V6 路径穿越拒绝：含分隔符 / ../ / 绝对路径形态', () => {
    for (const evil of ['../evil.db', 'a/b.db', 'a\\b.db', '..', ' x.db', '']) {
      expect(() => stageRestore(dbPath, evil)).toThrowError(/非法备份名|备份不存在/);
    }
  });

  it('备份不存在 → BACKUP_INVALID', () => {
    expect(() => stageRestore(dbPath, 'sessions-2020-01-01T00-00-00.db')).toThrowError(
      /备份不存在/,
    );
  });

  it('备份损坏（quick_check 失败）→ 拒绝恢复', () => {
    const dir = backupDirPath(dbPath);
    mkdirSync(dir, { recursive: true });
    const corruptName = 'sessions-2020-01-01T00-00-00.db';
    writeFileSync(join(dir, corruptName), 'garbage');

    expect(() => stageRestore(dbPath, corruptName)).toThrowError(/备份损坏/);
  });

  it('V7 连续两次暂存 → 后者覆盖前者（最后一次确认的为准）', async () => {
    const db = makeDbFile(dbPath, 'first');
    try {
      const first = await createBackupFile(db, dbPath);
      stageRestore(dbPath, first);

      db.prepare('DELETE FROM t').run();
      db.prepare('INSERT INTO t (v) VALUES (?)').run('second');
      await createBackupFile(db, dbPath);
      const entries = listBackups(dbPath);
      const second = entries[0]?.name;
      expect(second).toBeDefined();
      stageRestore(dbPath, second as string);

      expect(readMarker(join(dirname(dbPath), RESTORE_PENDING_FILENAME))).toBe('second');
    } finally {
      db.close();
    }
  });
});

describe('applyPendingRestore（启动期应用）', () => {
  it('无暂存 → no-op 返回 false', () => {
    expect(applyPendingRestore(dbPath)).toBe(false);
  });

  it('V4/V7：暂存存在 → 替换主库、暂存消费后消失、恢复点内容生效', async () => {
    const db = makeDbFile(dbPath, 'recovered');
    try {
      const name = await createBackupFile(db, dbPath);
      stageRestore(dbPath, name);
    } finally {
      db.close();
    }

    const applied = applyPendingRestore(dbPath);

    expect(applied).toBe(true);
    expect(existsSync(join(dirname(dbPath), RESTORE_PENDING_FILENAME))).toBe(false);
    expect(readMarker(dbPath)).toBe('recovered');
    expect(applyPendingRestore(dbPath)).toBe(false);
  });
});
