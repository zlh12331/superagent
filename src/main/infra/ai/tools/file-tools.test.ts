// src/main/infra/ai/tools/file-tools.test.ts
// 文件类工具单测：read/write/edit/list-directory（真实 FileService + 临时目录）

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { getFileService } from '../../file/file-service';
import type { ToolContext } from '../tool';
import { createEditFileTool } from './edit-file.tool';
import { createListDirectoryTool } from './list-directory.tool';
import { createReadFileTool } from './read-file.tool';
import { createWriteFileTool } from './write-file.tool';

let workDir: string;

/** 构造工具执行上下文 */
function createCtx(): ToolContext {
  return {
    workingDir: workDir,
    sessionId: 'session-tools',
    messageId: 'msg-1',
    callId: 'call-1',
    abortSignal: new AbortController().signal,
    webContents: {} as never,
    mode: 'build',
  };
}

describe('file 类工具（真实 FileService）', () => {
  beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), 'code-agent-tools-test-'));
  });

  afterAll(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  describe('read_file', () => {
    it('读取文件内容（相对路径基于 workingDir 解析）', async () => {
      writeFileSync(join(workDir, 'hello.txt'), 'line1\nline2\nline3\n', 'utf8');
      const tool = createReadFileTool(getFileService());
      const result = await tool.execute(
        { path: 'hello.txt', offset: undefined, limit: undefined },
        createCtx(),
      );
      expect(result.output).toContain('line2');
      expect(result.metadata).toMatchObject({ path: join(workDir, 'hello.txt') });
    });

    it('offset/limit：分段读取', async () => {
      writeFileSync(join(workDir, 'multi.txt'), 'a\nb\nc\nd\ne\n', 'utf8');
      const tool = createReadFileTool(getFileService());
      const result = await tool.execute({ path: 'multi.txt', offset: 2, limit: 2 }, createCtx());
      const lines = String(result.output).split('\n');
      expect(lines[0]).toBe('c');
      expect(lines[1]).toBe('d');
    });

    it('越界路径（../）：抛 UNAUTHORIZED', async () => {
      const tool = createReadFileTool(getFileService());
      await expect(
        tool.execute(
          { path: '../../etc/passwd', offset: undefined, limit: undefined },
          createCtx(),
        ),
      ).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
      });
    });
  });

  describe('write_file', () => {
    it('写入文件后内容正确', async () => {
      const tool = createWriteFileTool(getFileService());
      const result = await tool.execute(
        { path: 'out.txt', content: '写入内容', append: false, createDirs: true },
        createCtx(),
      );
      // metadata 结构：{ path, bytesWritten, append, createDirs }
      expect(result.metadata).toMatchObject({ path: join(workDir, 'out.txt') });
      expect((result.metadata as { bytesWritten?: number }).bytesWritten).toBeGreaterThan(0);
      const fs = await import('node:fs');
      expect(fs.readFileSync(join(workDir, 'out.txt'), 'utf8')).toBe('写入内容');
    });

    it('越界路径（../../）：抛 UNAUTHORIZED', async () => {
      const tool = createWriteFileTool(getFileService());
      await expect(
        tool.execute(
          { path: '../../escape.txt', content: 'x', append: false, createDirs: true },
          createCtx(),
        ),
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    });
  });

  describe('edit_file', () => {
    it('精确替换：oldString 匹配后替换', async () => {
      writeFileSync(join(workDir, 'edit.txt'), 'const a = 1;\n', 'utf8');
      const tool = createEditFileTool();
      const result = await tool.execute(
        {
          path: 'edit.txt',
          oldString: 'const a = 1;',
          newString: 'const a = 2;',
          replaceAll: false,
        },
        createCtx(),
      );
      // metadata 结构：{ path, bytesWritten, replacedCount, addedLines, removedLines }
      expect((result.metadata as { replacedCount?: number }).replacedCount).toBeGreaterThan(0);
      const fs = await import('node:fs');
      expect(fs.readFileSync(join(workDir, 'edit.txt'), 'utf8')).toBe('const a = 2;\n');
    });

    it('找不到 oldString：抛 AppError（INVALID_INPUT）且内容不变', async () => {
      writeFileSync(join(workDir, 'edit2.txt'), 'content', 'utf8');
      const tool = createEditFileTool();
      await expect(
        tool.execute(
          { path: 'edit2.txt', oldString: '不存在', newString: 'x', replaceAll: false },
          createCtx(),
        ),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      const fs = await import('node:fs');
      expect(fs.readFileSync(join(workDir, 'edit2.txt'), 'utf8')).toBe('content');
    });
  });

  describe('list_directory', () => {
    it('列出目录内容（包含已创建文件）', async () => {
      const tool = createListDirectoryTool(getFileService());
      const result = await tool.execute({ path: '.', depth: 1, includeHidden: false }, createCtx());
      const text = String(result.output);
      expect(text).toContain('hello.txt');
      expect(text).toContain('multi.txt');
    });

    it('越界路径：抛 UNAUTHORIZED', async () => {
      const tool = createListDirectoryTool(getFileService());
      await expect(
        tool.execute({ path: '..', depth: 1, includeHidden: false }, createCtx()),
      ).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
      });
    });
  });
});
