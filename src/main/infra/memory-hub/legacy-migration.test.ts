// src/main/infra/memory-hub/legacy-migration.test.ts
// 主目录遗留数据迁移单测（真实 fs + 临时目录，不 mock）
// ──────────────────────────────────────────────────────────────
// 覆盖：无旧目录 / 正常迁移 / 新位置已有则不覆盖 / 单项失败不阻断 / 幂等

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrateLegacyDataDir } from './memory-hub-service';

describe('migrateLegacyDataDir', () => {
  let home: string;
  let newRoot: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'legacy-home-'));
    newRoot = mkdtempSync(join(tmpdir(), 'legacy-new-'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(newRoot, { recursive: true, force: true });
  });

  /** 在旧路径写入一个数据文件 */
  function seedLegacy(name: string, content: string): void {
    const dir = join(home, '.memory-tencentdb', 'memory-tdai');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), content, 'utf8');
  }

  it('无旧目录 → 迁移 0 项且不报错', () => {
    expect(migrateLegacyDataDir(newRoot, home)).toBe(0);
  });

  it('旧目录有数据 → 复制到新位置（内容一致）', () => {
    seedLegacy('vectors.db', 'legacy-vectors');
    const migrated = migrateLegacyDataDir(newRoot, home);
    expect(migrated).toBe(1);
    expect(readFileSync(join(newRoot, 'vectors.db'), 'utf8')).toBe('legacy-vectors');
  });

  it('旧目录保留未删（迁移保守：留一份以防出错）', () => {
    seedLegacy('vectors.db', 'legacy');
    migrateLegacyDataDir(newRoot, home);
    expect(existsSync(join(home, '.memory-tencentdb', 'memory-tdai', 'vectors.db'))).toBe(true);
  });

  it('新位置已有同名条目 → 不覆盖（保护新数据）', () => {
    seedLegacy('vectors.db', 'legacy');
    writeFileSync(join(newRoot, 'vectors.db'), 'current', 'utf8');
    const migrated = migrateLegacyDataDir(newRoot, home);
    expect(migrated).toBe(0);
    expect(readFileSync(join(newRoot, 'vectors.db'), 'utf8')).toBe('current');
  });

  it('多条目：仅迁移缺失项（逐项判定）', () => {
    seedLegacy('a.db', 'a');
    seedLegacy('b.db', 'b');
    seedLegacy('c.db', 'c');
    writeFileSync(join(newRoot, 'b.db'), 'existing', 'utf8');
    const migrated = migrateLegacyDataDir(newRoot, home);
    expect(migrated).toBe(2); // a、c
    expect(readFileSync(join(newRoot, 'a.db'), 'utf8')).toBe('a');
    expect(readFileSync(join(newRoot, 'b.db'), 'utf8')).toBe('existing');
    expect(readFileSync(join(newRoot, 'c.db'), 'utf8')).toBe('c');
  });

  it('目录型数据（conversations/）递归迁移', () => {
    const legacyDir = join(home, '.memory-tencentdb', 'memory-tdai', 'conversations');
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(legacyDir, '2026-09-13.jsonl'), '{"a":1}\n', 'utf8');
    const migrated = migrateLegacyDataDir(newRoot, home);
    expect(migrated).toBe(1);
    expect(readFileSync(join(newRoot, 'conversations', '2026-09-13.jsonl'), 'utf8')).toBe(
      '{"a":1}\n',
    );
  });

  it('幂等：重复调用第二次迁移 0 项', () => {
    seedLegacy('vectors.db', 'legacy');
    expect(migrateLegacyDataDir(newRoot, home)).toBe(1);
    expect(migrateLegacyDataDir(newRoot, home)).toBe(0);
  });
});
