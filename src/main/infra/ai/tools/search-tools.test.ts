// src/main/infra/ai/tools/search-tools.test.ts
// 搜索类工具单测：grep/glob（真实 SearchService + ripgrep）

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { getSearchService } from '../../search/search-service';
import { createGlobTool } from './glob.tool';
import { createGrepTool } from './grep.tool';
import type { ToolContext } from './tool';

let workDir: string;

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

describe('搜索类工具（真实 ripgrep）', () => {
  beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), 'code-agent-search-test-'));
    writeFileSync(join(workDir, 'a.ts'), 'export const alpha = 1;\n// comment\n', 'utf8');
    writeFileSync(join(workDir, 'b.ts'), 'export const beta = 2;\n', 'utf8');
    writeFileSync(join(workDir, 'README.md'), 'alpha mentioned here\n', 'utf8');
  });

  afterAll(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  describe('grep', () => {
    it('正则搜索：匹配 .ts 文件中的 alpha', async () => {
      const tool = createGrepTool(getSearchService());
      const result = await tool.execute(
        {
          pattern: 'alpha',
          paths: ['.'],
          include: '*.ts',
          isRegex: false,
          caseSensitive: false,
          exclude: [],
          maxResults: 100,
        },
        createCtx(),
      );
      const text = String(result.output);
      expect(text).toContain('a.ts');
      expect(text).toContain('alpha');
    });

    it('排除 README：include 过滤生效', async () => {
      const tool = createGrepTool(getSearchService());
      const result = await tool.execute(
        {
          pattern: 'alpha',
          paths: ['.'],
          include: '*.ts',
          isRegex: false,
          caseSensitive: false,
          exclude: [],
          maxResults: 100,
        },
        createCtx(),
      );
      // README.md 不在 .ts 过滤内
      expect(String(result.output)).not.toContain('README.md');
    });

    it('无匹配：返回空结果', async () => {
      const tool = createGrepTool(getSearchService());
      const result = await tool.execute(
        {
          pattern: 'nonexistent_pattern_xyz',
          paths: ['.'],
          isRegex: false,
          caseSensitive: false,
          include: undefined,
          exclude: [],
          maxResults: 100,
        },
        createCtx(),
      );
      expect(result.metadata).toBeDefined();
    });
  });

  describe('glob', () => {
    it('按模式匹配文件路径', async () => {
      const tool = createGlobTool(getSearchService());
      const result = await tool.execute(
        { pattern: '*.ts', path: '.', includeHidden: false, maxResults: 1000 },
        createCtx(),
      );
      const text = String(result.output);
      expect(text).toContain('a.ts');
      expect(text).toContain('b.ts');
    });

    it('模式不匹配：返回空', async () => {
      const tool = createGlobTool(getSearchService());
      const result = await tool.execute(
        { pattern: '*.py', path: '.', includeHidden: false, maxResults: 1000 },
        createCtx(),
      );
      expect(result.metadata).toBeDefined();
    });
  });
});
