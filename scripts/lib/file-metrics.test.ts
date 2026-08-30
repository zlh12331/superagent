// scripts/lib/file-metrics.test.ts
// 体积度量与文件收集单测（棘轮门禁的口径基础）
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  collectSourceFiles,
  discoverPackageSrcDirs,
  isSourceFile,
  isViolating,
  measureLines,
  splitLines,
  toPosixRelative,
} from './file-metrics';

describe('splitLines', () => {
  it('去掉文件末尾换行产生的一行空白（wc -l 口径）', () => {
    expect(splitLines('a\nb\nc\n')).toHaveLength(3);
    expect(splitLines('a\nb\nc')).toHaveLength(3);
    expect(splitLines('')).toHaveLength(0);
  });

  it('CRLF 与孤立 CR 都按换行处理', () => {
    expect(splitLines('a\r\nb\r\nc')).toHaveLength(3);
    expect(splitLines('a\rb')).toHaveLength(2);
  });

  it('保留纯空白行（空行由 measureLines 负责剔除）', () => {
    expect(splitLines('a\n\nb')).toHaveLength(3);
  });
});

describe('measureLines', () => {
  it('raw 计全部物理行，net 去空行与纯注释行', () => {
    const source = [
      '// 头注释',
      'const a = 1; // 行尾注释计为代码行',
      '',
      '/* 块注释',
      ' * 第二行',
      ' */',
      'const b = 2;',
    ].join('\n');
    expect(measureLines(source)).toEqual({ raw: 7, net: 2 });
  });

  it('单行块注释 /* x */ 只算注释行', () => {
    expect(measureLines('/* x */\ncode').net).toBe(1);
  });

  it('星号起始的续行算注释（JSDoc 风格）', () => {
    expect(measureLines('/**\n * doc\n */\nconst a = 1;').net).toBe(1);
  });

  it('注释刷量不会降低 raw（棘轮无法靠加注释规避）', () => {
    const padded = `${'// 说明\n'.repeat(50)}const a = 1;`;
    const m = measureLines(padded);
    expect(m.net).toBe(1);
    expect(m.raw).toBe(51);
  });
});

describe('isSourceFile', () => {
  it('接受 .ts/.tsx，排除测试文件', () => {
    expect(isSourceFile('a.ts')).toBe(true);
    expect(isSourceFile('a.tsx')).toBe(true);
    expect(isSourceFile('a.test.ts')).toBe(false);
    expect(isSourceFile('a.md')).toBe(false);
  });
});

describe('isViolating', () => {
  it('任一口径超限即违规', () => {
    expect(isViolating({ raw: 601, net: 1 }, 600, 600)).toBe(true);
    expect(isViolating({ raw: 1, net: 601 }, 600, 600)).toBe(true);
    expect(isViolating({ raw: 600, net: 600 }, 600, 600)).toBe(false);
  });
});

describe('toPosixRelative', () => {
  it('反斜杠归一为正斜杠（基线跨平台一致）', () => {
    expect(toPosixRelative('/root', '/root\\src\\main\\a.ts')).toBe('src/main/a.ts');
  });
});

describe('collectSourceFiles / discoverPackageSrcDirs', () => {
  it('递归收集源码并跳过产物目录与测试文件', () => {
    const files = collectSourceFiles(join(import.meta.dirname, '..', '..'));
    const rel = files.map((f) => toPosixRelative(join(import.meta.dirname, '..', '..'), f));
    // 真实仓库必须有内容（防「扫描集静默为空 → 门禁假绿」）
    expect(rel.some((p) => p === 'src/main/service-container.ts')).toBe(true);
    expect(rel.some((p) => p === 'packages/shared/src/ipc/definitions.ts')).toBe(true);
    expect(rel.some((p) => p.includes('_template'))).toBe(false);
    expect(rel.some((p) => p.includes('node_modules'))).toBe(false);
    expect(rel.some((p) => p.endsWith('.test.ts') || p.endsWith('.test.tsx'))).toBe(false);
  });

  it('无测试文件豁免时 src/ 与 packages/ 同时受辖（回归：曾漏掉契约层）', () => {
    const dirs = [
      join(import.meta.dirname, '..', '..', 'src'),
      ...discoverPackageSrcDirs(join(import.meta.dirname, '..', '..')),
    ];
    const all = dirs.flatMap((d) => collectSourceFiles(d));
    const allPosix = all.map((f) => f.replace(/\\/g, '/'));
    expect(allPosix.some((p) => p.includes('/packages/shared/src/'))).toBe(true);
    expect(all.length).toBeGreaterThan(300);
  });

  it('目录不存在时返回空集而不抛错', () => {
    expect(collectSourceFiles('/definitely/not/here')).toEqual([]);
    expect(discoverPackageSrcDirs('/definitely/not/here')).toEqual([]);
  });

  it('递归时跳过 __tests__ / out 目录（fixture 建在系统临时目录）', () => {
    const base = mkdtempSync(join(tmpdir(), 'file-metrics-'));
    try {
      mkdirSync(join(base, '__tests__'), { recursive: true });
      mkdirSync(join(base, 'out'), { recursive: true });
      mkdirSync(join(base, 'kept'), { recursive: true });
      writeFileSync(join(base, '__tests__', 'a.ts'), 'x', 'utf8');
      writeFileSync(join(base, 'out', 'b.ts'), 'x', 'utf8');
      writeFileSync(join(base, 'kept', 'c.ts'), 'x', 'utf8');
      const rel = collectSourceFiles(base).map((f) => toPosixRelative(base, f));
      expect(rel).toEqual(['kept/c.ts']);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
