// src/main/infra/ai/tools/tools-gaps.test.ts
// 工具域 7a 缺口补全：lsp_references 空/非 Error、edit_file 边界全路径、
// write_file 拦截/追加、glob 省略 path（真实 FileService/SearchService + 临时目录）
//
// 豁免说明：read-file/glob 的 zod transform（v ?? undefined）由 tool-executor 的
// schema.parse 执行，测试直接调 execute 传原始值，transform 分支测试路径不可达
// （SDK 层行为，非业务逻辑）。

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { getFileService } from '../../file/file-service';
import type { LspServerManager } from '../../lsp/lsp-server-manager';
import { getSearchService } from '../../search/search-service';
import { createEditFileTool } from './edit-file.tool';
import { createGlobTool } from './glob.tool';
import { createLspReferencesTool } from './lsp-references.tool';
import { createReadFileTool } from './read-file.tool';
import type { ToolContext } from './tool';
import { createWriteFileTool } from './write-file.tool';

let workDir: string;
let sessionCounter = 0;

/** 每次用例独立 sessionId（readTracker 按 session 隔离，避免跨用例污染） */
function createCtx(): ToolContext {
  sessionCounter += 1;
  return {
    workingDir: workDir,
    sessionId: `gap-session-${sessionCounter}`,
    messageId: 'msg-1',
    callId: 'call-1',
    abortSignal: new AbortController().signal,
    webContents: {} as never,
    mode: 'build',
  };
}

describe('工具域 7a 缺口补全', () => {
  beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), 'code-agent-tools-gap-'));
  });

  afterAll(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  describe('lsp_references', () => {
    it('无引用位置：返回空结果提示', async () => {
      const manager = {
        getClient: vi.fn(async () => ({ references: async () => [] })),
      } as unknown as LspServerManager;
      const tool = createLspReferencesTool(manager);

      // 路径经 resolveWithinWorkspace 收口（2026-09-08）：须用工作区内路径
      const result = await tool.execute({ filePath: 'a.ts', line: 1, character: 2 }, createCtx());

      expect(result.output).toContain('未找到引用位置');
    });

    it('越界路径被守卫拒绝（2026-09-08 安全修复）', async () => {
      const manager = {
        getClient: vi.fn(async () => ({ references: async () => [] })),
      } as unknown as LspServerManager;
      const tool = createLspReferencesTool(manager);

      const result = await tool.execute(
        { filePath: '../../outside.ts', line: 0, character: 0 },
        createCtx(),
      );

      expect(result.output).toContain('路径越权访问');
      expect(manager.getClient).not.toHaveBeenCalled();
    });

    it('语言服务器抛非 Error 值：String() 兜底不抛', async () => {
      const manager = {
        getClient: vi.fn(async () => {
          throw 'server-crashed-string';
        }),
      } as unknown as LspServerManager;
      const tool = createLspReferencesTool(manager);

      const result = await tool.execute({ filePath: 'a.ts', line: 0, character: 0 }, createCtx());

      expect(result.output).toContain('server-crashed-string');
    });
  });

  describe('edit_file 边界', () => {
    /** 创建文件并先 read（满足 priorReadEnforcement；read/edit 共享同一 sessionId） */
    async function readThenEdit(file: string): Promise<{
      tool: ReturnType<typeof createEditFileTool>;
      ctx: ToolContext;
    }> {
      const ctx = createCtx();
      writeFileSync(join(workDir, file), 'aaa bbb aaa ccc', 'utf8');
      await createReadFileTool(getFileService()).execute(
        { path: file, offset: 0, limit: undefined },
        ctx,
      );
      return { tool: createEditFileTool(), ctx };
    }

    it('未读取文件：拦截返回提示（priorReadEnforcement）', async () => {
      writeFileSync(join(workDir, 'unread.txt'), 'content', 'utf8');
      const tool = createEditFileTool();

      const result = await tool.execute(
        { path: 'unread.txt', oldString: 'content', newString: 'x', replaceAll: false },
        createCtx(),
      );

      expect(result.title).toBe('文件未读取');
    });

    it('文件不存在：NOT_FOUND（读后文件被删）', async () => {
      const ctx = createCtx();
      writeFileSync(join(workDir, 'deleted.txt'), 'content', 'utf8');
      await createReadFileTool(getFileService()).execute(
        { path: 'deleted.txt', offset: 0, limit: undefined },
        ctx,
      );
      rmSync(join(workDir, 'deleted.txt'), { force: true });
      const tool = createEditFileTool();

      await expect(
        tool.execute(
          { path: 'deleted.txt', oldString: 'x', newString: 'y', replaceAll: false },
          ctx,
        ),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('读取失败（路径变为目录）：FS_READ_FAILED', async () => {
      const ctx = createCtx();
      writeFileSync(join(workDir, 'dirswap.txt'), 'content', 'utf8');
      await createReadFileTool(getFileService()).execute(
        { path: 'dirswap.txt', offset: 0, limit: undefined },
        ctx,
      );
      rmSync(join(workDir, 'dirswap.txt'), { force: true });
      mkdirSync(join(workDir, 'dirswap.txt'));
      const tool = createEditFileTool();

      await expect(
        tool.execute(
          { path: 'dirswap.txt', oldString: 'x', newString: 'y', replaceAll: false },
          ctx,
        ),
      ).rejects.toMatchObject({ code: 'FS_READ_FAILED' });
    });

    it('多匹配且 replaceAll=false：INVALID_INPUT', async () => {
      const { tool, ctx } = await readThenEdit('multi.txt');

      await expect(
        tool.execute(
          { path: 'multi.txt', oldString: 'aaa', newString: 'zzz', replaceAll: false },
          ctx,
        ),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    });

    it('replaceAll=true：全部替换 + 计数', async () => {
      const { tool, ctx } = await readThenEdit('replace-all.txt');

      const result = await tool.execute(
        { path: 'replace-all.txt', oldString: 'aaa', newString: 'zzz', replaceAll: true },
        ctx,
      );

      expect((result.metadata as { replacedCount?: number }).replacedCount).toBe(2);
      const fs = await import('node:fs');
      expect(fs.readFileSync(join(workDir, 'replace-all.txt'), 'utf8')).toBe('zzz bbb zzz ccc');
    });

    it('newString 为空：删除 action', async () => {
      const { tool, ctx } = await readThenEdit('delete.txt');

      const result = await tool.execute(
        { path: 'delete.txt', oldString: 'bbb ', newString: '', replaceAll: false },
        ctx,
      );

      expect(result.output).toContain('已删除');
      const fs = await import('node:fs');
      expect(fs.readFileSync(join(workDir, 'delete.txt'), 'utf8')).toBe('aaa aaa ccc');
    });

    it('写入失败（目标为只读文件）：FS_WRITE_FAILED', async () => {
      const ctx = createCtx();
      writeFileSync(join(workDir, 'readonly.txt'), 'content', 'utf8');
      await createReadFileTool(getFileService()).execute(
        { path: 'readonly.txt', offset: 0, limit: undefined },
        ctx,
      );
      const fs = await import('node:fs');
      fs.chmodSync(join(workDir, 'readonly.txt'), 0o444);
      const tool = createEditFileTool();

      await expect(
        tool.execute(
          { path: 'readonly.txt', oldString: 'content', newString: 'changed', replaceAll: false },
          ctx,
        ),
      ).rejects.toMatchObject({ code: 'FS_WRITE_FAILED' });
      fs.chmodSync(join(workDir, 'readonly.txt'), 0o644);
    });
  });

  describe('write_file 边界', () => {
    it('已存在文件未读取：拦截返回提示', async () => {
      writeFileSync(join(workDir, 'exists.txt'), 'old', 'utf8');
      const tool = createWriteFileTool(getFileService());

      const result = await tool.execute(
        { path: 'exists.txt', content: 'new', append: false, createDirs: true },
        createCtx(),
      );

      expect(result.title).toBe('文件未读取');
    });

    it('append=true：追加写入 + action 提示', async () => {
      const ctx = createCtx();
      writeFileSync(join(workDir, 'append.txt'), 'line1\n', 'utf8');
      await createReadFileTool(getFileService()).execute(
        { path: 'append.txt', offset: 0, limit: undefined },
        ctx,
      );
      const tool = createWriteFileTool(getFileService());

      const result = await tool.execute(
        { path: 'append.txt', content: 'line2\n', append: true, createDirs: true },
        ctx,
      );

      expect(result.output).toContain('追加写入');
      const fs = await import('node:fs');
      expect(fs.readFileSync(join(workDir, 'append.txt'), 'utf8')).toBe('line1\nline2\n');
    });
  });

  describe('glob', () => {
    it('省略 path：默认搜索工作目录', async () => {
      writeFileSync(join(workDir, 'gap-a.ts'), 'x', 'utf8');
      const tool = createGlobTool(getSearchService());

      const result = await tool.execute(
        { pattern: '*.ts', path: undefined, includeHidden: false, maxResults: 100 },
        createCtx(),
      );

      expect(result.output).toContain('gap-a.ts');
      expect(result.metadata).toMatchObject({ path: workDir });
    });

    it('显式 path：搜索指定子目录（resolveWithinWorkspace 解析）', async () => {
      const subDir = join(workDir, 'sub-dir');
      mkdirSync(subDir);
      writeFileSync(join(subDir, 'gap-b.ts'), 'x', 'utf8');
      const tool = createGlobTool(getSearchService());

      const result = await tool.execute(
        { pattern: '*.ts', path: 'sub-dir', includeHidden: false, maxResults: 100 },
        createCtx(),
      );

      expect(result.output).toContain('gap-b.ts');
      expect(result.metadata).toMatchObject({ path: subDir });
    });
  });
});
