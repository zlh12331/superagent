// src/main/infra/ai/tools/path-guard.test.ts
// path-guard 单测：路径越权防护（安全关键模块）
//
// 测试要点：
// 1. 相对路径基于 workingDir 解析
// 2. 绝对路径直接使用（仍通过边界检查）
// 3. 路径遍历（../）越界 → UNAUTHORIZED
// 4. 空路径 → INVALID_INPUT
// 5. Windows 盘符跨盘越界 → UNAUTHORIZED
// 6. 工作区内部路径（含子目录回溯后仍在区内）→ 通过
// 7. 符号链接（P1 安全修复）：工作区内 symlink 指向外部 → UNAUTHORIZED；
//    指向工作区内 → 通过；新建文件经 symlink 祖先 → UNAUTHORIZED
//
// 注：realpath 校验需要真实文件系统（2026-08 安全修复引入），
// 测试使用真实临时目录（与 file-service 测试同一模式）。

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppError, ErrorCode } from '@code-agent/shared/main';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveWithinWorkspace } from './path-guard';

// Windows 用 junction（目录链接，无需管理员权限）；其他平台用目录 symlink
const SYMLINK_TYPE = process.platform === 'win32' ? 'junction' : 'dir';

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
    expect(result).toBe(join(workspace, 'src', 'main.ts'));
  });

  it('相对路径带子目录：正常解析', () => {
    const result = resolveWithinWorkspace('packages/shared/src/index.ts', workspace);
    expect(result).toBe(join(workspace, 'packages', 'shared', 'src', 'index.ts'));
  });

  it('绝对路径：直接使用（在 workingDir 内则通过）', () => {
    const abs = join(workspace, 'src', 'main.ts');
    const result = resolveWithinWorkspace(abs, workspace);
    expect(result).toBe(abs);
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

  it('Windows 跨盘符绝对路径（D:\\）：越界 → UNAUTHORIZED', () => {
    expect(() => resolveWithinWorkspace('D:\\secret\\key.txt', workspace)).toThrowError(
      expect.objectContaining({ code: ErrorCode.UNAUTHORIZED }),
    );
  });

  it('工作区根路径本身：通过（rel 为空字符串）', () => {
    const result = resolveWithinWorkspace('.', workspace);
    expect(result).toBe(workspace);
  });

  it('工作区内部回溯（src\\..\\package.json）：解析后仍在区内 → 通过', () => {
    const result = resolveWithinWorkspace('src\\..\\package.json', workspace);
    expect(result).toBe(join(workspace, 'package.json'));
  });

  it('路径含 Unicode 中文目录：正常解析且不误判', () => {
    const result = resolveWithinWorkspace('笔记/第一章.md', workspace);
    expect(result).toBe(join(workspace, '笔记', '第一章.md'));
  });

  it('新建文件（父目录已存在）：通过（祖先 realpath 解析）', () => {
    mkdirSync(join(workspace, 'src'));
    const result = resolveWithinWorkspace('src/new-file.ts', workspace);
    expect(result).toBe(join(workspace, 'src', 'new-file.ts'));
  });

  // ── 符号链接（P1 安全修复，2026-08 安全审计） ──────────────

  it('symlink 指向工作区外：读取外部文件 → UNAUTHORIZED', () => {
    const outside = mkdtempSync(join(tmpdir(), 'path-guard-outside-'));
    try {
      // 工作区内建 external 链接 → 外部目录
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
    expect(result).toBe(join(workspace, 'alias', 'main.ts'));
  });

  it('新建文件经 symlink 祖先（祖先指向工作区外）→ UNAUTHORIZED', () => {
    const outside = mkdtempSync(join(tmpdir(), 'path-guard-outside2-'));
    try {
      symlinkSync(outside, join(workspace, 'evil'), SYMLINK_TYPE);
      // evil/new.txt 不存在（新建场景）——祖先 evil 是 symlink 指向外部 → 拦截
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
