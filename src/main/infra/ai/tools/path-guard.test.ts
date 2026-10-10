import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { AppError, ErrorCode } from '@code-agent/shared/main';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveWithinWorkspace } from './path-guard';

const SYMLINK_TYPE = process.platform === 'win32' ? 'junction' : 'dir';
/** 跨平台用例用平台分隔符 `sep` 构造路径；Windows 专属语义用例按平台门控 */
const IS_WIN = process.platform === 'win32';

describe('resolveWithinWorkspace', () => {
  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'path-guard-'));
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it('相对路径：基于 workingDir 解析为绝对路径', () => {
    const result = resolveWithinWorkspace('src/main.ts', workspace);
    expect(result.resolved).toBe(join(workspace, 'src', 'main.ts'));
  });

  it('相对路径带子目录：正常解析', () => {
    const result = resolveWithinWorkspace('packages/shared/src/index.ts', workspace);
    expect(result.resolved).toBe(join(workspace, 'packages', 'shared', 'src', 'index.ts'));
  });

  it('绝对路径：直接使用（在 workingDir 内则通过）', () => {
    const abs = join(workspace, 'src', 'main.ts');
    const result = resolveWithinWorkspace(abs, workspace);
    expect(result.resolved).toBe(abs);
  });

  it('路径遍历（../etc/passwd）：越界 → UNAUTHORIZED', () => {
    expect(() => resolveWithinWorkspace('../etc/passwd', workspace)).toThrow(AppError);
    expect(() => resolveWithinWorkspace('../etc/passwd', workspace)).toThrowError(
      expect.objectContaining({ code: ErrorCode.UNAUTHORIZED }),
    );
  });

  it('深层路径遍历（../../..）：越界 → UNAUTHORIZED', () => {
    expect(() => resolveWithinWorkspace('../../../outside', workspace)).toThrowError(
      expect.objectContaining({ code: ErrorCode.UNAUTHORIZED }),
    );
  });

  it('空路径：→ INVALID_INPUT', () => {
    expect(() => resolveWithinWorkspace('', workspace)).toThrowError(
      expect.objectContaining({ code: ErrorCode.INVALID_INPUT }),
    );
  });

  it('仅空白路径：→ INVALID_INPUT', () => {
    expect(() => resolveWithinWorkspace('   ', workspace)).toThrowError(
      expect.objectContaining({ code: ErrorCode.INVALID_INPUT }),
    );
  });

  it.skipIf(!IS_WIN)('Windows 跨盘符绝对路径（D:\\）：越界 → UNAUTHORIZED', () => {
    expect(() => resolveWithinWorkspace('D:\\secret\\key.txt', workspace)).toThrowError(
      expect.objectContaining({ code: ErrorCode.UNAUTHORIZED }),
    );
  });

  it('工作区根路径本身：通过（rel 为空字符串）', () => {
    const result = resolveWithinWorkspace('.', workspace);
    expect(result.resolved).toBe(workspace);
  });

  it('工作区内部回溯（父目录回溯）：解析后仍在区内 → 通过', () => {
    const trackback = `src${sep}..${sep}package.json`;
    const result = resolveWithinWorkspace(trackback, workspace);
    expect(result.resolved).toBe(join(workspace, 'package.json'));
  });

  it('路径含 Unicode 中文目录：正常解析且不误判', () => {
    const result = resolveWithinWorkspace('笔记/第一章.md', workspace);
    expect(result.resolved).toBe(join(workspace, '笔记', '第一章.md'));
  });

  it('新建文件（父目录已存在）：通过（祖先 realpath 解析）', () => {
    mkdirSync(join(workspace, 'src'));
    const result = resolveWithinWorkspace('src/new-file.ts', workspace);
    expect(result.resolved).toBe(join(workspace, 'src', 'new-file.ts'));
  });

  it('无 symlink：realTarget 为真实落点（realpath 意义下与 resolved 同指）', () => {
    mkdirSync(join(workspace, 'src'));
    writeFileSync(join(workspace, 'src', 'main.ts'), 'x');
    const result = resolveWithinWorkspace('src/main.ts', workspace);
    expect(result.realTarget).toBe(realpathSync(join(workspace, 'src', 'main.ts')));
  });

  it('symlink 指向工作区外：读取外部文件 → UNAUTHORIZED', () => {
    const outside = mkdtempSync(join(tmpdir(), 'path-guard-outside-'));
    try {
      symlinkSync(outside, join(workspace, 'external'), SYMLINK_TYPE);
      expect(() => resolveWithinWorkspace('external/secret.txt', workspace)).toThrowError(
        expect.objectContaining({ code: ErrorCode.UNAUTHORIZED }),
      );
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('symlink 指向工作区内：合法路径 → 通过（不误伤 pnpm 结构）', () => {
    mkdirSync(join(workspace, 'src'));
    symlinkSync(join(workspace, 'src'), join(workspace, 'alias'), SYMLINK_TYPE);
    const result = resolveWithinWorkspace('alias/main.ts', workspace);
    expect(result.resolved).toBe(join(workspace, 'alias', 'main.ts'));
  });

  it('TOCTOU（debt.md#d1）：symlink 场景 realTarget 为真实落点，resolved 保持输入形态', () => {
    mkdirSync(join(workspace, 'src'));
    writeFileSync(join(workspace, 'src', 'main.ts'), 'x');
    symlinkSync(join(workspace, 'src'), join(workspace, 'alias'), SYMLINK_TYPE);
    const result = resolveWithinWorkspace('alias/main.ts', workspace);
    expect(result.resolved).toBe(join(workspace, 'alias', 'main.ts'));
    expect(result.realTarget).toBe(realpathSync(join(workspace, 'src', 'main.ts')));
  });

  it('新建文件经 symlink 祖先（祖先指向工作区外）→ UNAUTHORIZED', () => {
    const outside = mkdtempSync(join(tmpdir(), 'path-guard-outside2-'));
    try {
      symlinkSync(outside, join(workspace, 'evil'), SYMLINK_TYPE);
      expect(() => resolveWithinWorkspace('evil/new.txt', workspace)).toThrowError(
        expect.objectContaining({ code: ErrorCode.UNAUTHORIZED }),
      );
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('symlink 指向真实存在的外部文件（经链接读取）→ UNAUTHORIZED', () => {
    const outside = mkdtempSync(join(tmpdir(), 'path-guard-outside3-'));
    try {
      const secret = join(outside, 'secret.txt');
      writeFileSync(secret, 'top secret');
      symlinkSync(outside, join(workspace, 'leak'), SYMLINK_TYPE);
      expect(() => resolveWithinWorkspace('leak/secret.txt', workspace)).toThrowError(
        expect.objectContaining({ code: ErrorCode.UNAUTHORIZED }),
      );
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
