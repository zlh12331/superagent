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

import { AppError, ErrorCode } from '@code-agent/shared';
import { describe, expect, it } from 'vitest';

import { resolveWithinWorkspace } from './path-guard';

const WORKSPACE = 'C:\\projects\\my-app';

describe('resolveWithinWorkspace', () => {
  it('相对路径：基于 workingDir 解析为绝对路径', () => {
    const result = resolveWithinWorkspace('src/main.ts', WORKSPACE);
    expect(result).toBe('C:\\projects\\my-app\\src\\main.ts');
  });

  it('相对路径带子目录：正常解析', () => {
    const result = resolveWithinWorkspace('packages/shared/src/index.ts', WORKSPACE);
    expect(result).toBe('C:\\projects\\my-app\\packages\\shared\\src\\index.ts');
  });

  it('绝对路径：直接使用（在 workingDir 内则通过）', () => {
    const result = resolveWithinWorkspace('C:\\projects\\my-app\\src\\main.ts', WORKSPACE);
    expect(result).toBe('C:\\projects\\my-app\\src\\main.ts');
  });

  it('路径遍历（../etc/passwd）：越界 → UNAUTHORIZED', () => {
    expect(() => resolveWithinWorkspace('../etc/passwd', WORKSPACE)).toThrow(AppError);
    expect(() => resolveWithinWorkspace('../etc/passwd', WORKSPACE)).toThrowError(
      expect.objectContaining({ code: ErrorCode.UNAUTHORIZED }),
    );
  });

  it('深层路径遍历（../../..）：越界 → UNAUTHORIZED', () => {
    expect(() => resolveWithinWorkspace('../../../outside', WORKSPACE)).toThrowError(
      expect.objectContaining({ code: ErrorCode.UNAUTHORIZED }),
    );
  });

  it('空路径：→ INVALID_INPUT', () => {
    expect(() => resolveWithinWorkspace('', WORKSPACE)).toThrowError(
      expect.objectContaining({ code: ErrorCode.INVALID_INPUT }),
    );
  });

  it('仅空白路径：→ INVALID_INPUT', () => {
    expect(() => resolveWithinWorkspace('   ', WORKSPACE)).toThrowError(
      expect.objectContaining({ code: ErrorCode.INVALID_INPUT }),
    );
  });

  it('Windows 跨盘符绝对路径（D:\\）：越界 → UNAUTHORIZED', () => {
    expect(() => resolveWithinWorkspace('D:\\secret\\key.txt', WORKSPACE)).toThrowError(
      expect.objectContaining({ code: ErrorCode.UNAUTHORIZED }),
    );
  });

  it('工作区根路径本身：通过（rel 为空字符串）', () => {
    const result = resolveWithinWorkspace('.', WORKSPACE);
    expect(result).toBe(WORKSPACE);
  });

  it('工作区内部回溯（src\\..\\package.json）：解析后仍在区内 → 通过', () => {
    const result = resolveWithinWorkspace('src\\..\\package.json', WORKSPACE);
    expect(result).toBe('C:\\projects\\my-app\\package.json');
  });

  it('路径含 Unicode 中文目录：正常解析且不误判', () => {
    const result = resolveWithinWorkspace('笔记/第一章.md', WORKSPACE);
    expect(result).toBe('C:\\projects\\my-app\\笔记\\第一章.md');
  });
});
