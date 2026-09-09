// src/main/infra/ai/tools/tools-gaps-7b.test.ts
// 工具域 7b 缺口补全：list_directory 类型分支、lsp_definition 空/非 Error、
// run_command 输出组合/退出码/截断/abort、grep 多路径/上下文、command-classifier 参数透传/缓存上限

import { join, resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LspServerManager } from '../../lsp/lsp-server-manager';
import type { ISearchService } from '../../search/search-service';
import type { LlmClient } from '../llm-client';
import { CommandClassifier } from './command-classifier';
import { createGrepTool } from './grep.tool';
import { createListDirectoryTool } from './list-directory.tool';
import { createLspDefinitionTool } from './lsp-definition.tool';
import { createRunCommandTool } from './run-command.tool';
import type { ToolContext } from './tool';

const mocks = vi.hoisted(() => {
  const mockSpawn = vi.fn();
  return { mockSpawn };
});

vi.mock('node:child_process', () => ({ spawn: mocks.mockSpawn }));

function createCtx(overrides?: { aborted?: boolean }): ToolContext {
  const controller = new AbortController();
  if (overrides?.aborted === true) {
    controller.abort();
  }
  return {
    workingDir: 'C:\\projects\\my-app',
    sessionId: 'gap-7b-session',
    messageId: 'msg-1',
    callId: 'call-1',
    abortSignal: controller.signal,
    webContents: {} as never,
    mode: 'build',
  };
}

/** 构造可解析的 spawn mock（stdout/stderr/close/error 可控） */
function mockSpawnChild(options: {
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  signal?: string | null;
  spawnError?: Error;
}) {
  const child = {
    stdout: {
      on: vi.fn((event: string, cb: (d: Buffer) => void) => {
        if (event === 'data' && options.stdout !== undefined && options.stdout.length > 0) {
          cb(Buffer.from(options.stdout));
        }
      }),
    },
    stderr: {
      on: vi.fn((event: string, cb: (d: Buffer) => void) => {
        if (event === 'data' && options.stderr !== undefined && options.stderr.length > 0) {
          cb(Buffer.from(options.stderr));
        }
      }),
    },
    on: vi.fn((event: string, cb: (code: number | null, signal: string | null) => void) => {
      if (event === 'close') {
        cb(options.exitCode ?? 0, options.signal ?? null);
      } else if (event === 'error' && options.spawnError !== undefined) {
        cb(options.spawnError as unknown as number, null);
      }
    }),
    kill: vi.fn(),
  };
  mocks.mockSpawn.mockReturnValue(child);
  return child;
}

describe('工具域 7b 缺口补全', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('list_directory 类型分支', () => {
    it('混合条目：directory/symlink/文件 + size 有/无', async () => {
      const fileService = {
        list: vi.fn(async () => ({
          entries: [
            { name: 'dir-a', path: '/d/a', type: 'directory', size: undefined, modifiedAt: 0 },
            { name: 'link-b', path: '/d/b', type: 'symlink', size: undefined, modifiedAt: 0 },
            { name: 'file-c', path: '/d/c', type: 'file', size: 42, modifiedAt: 0 },
          ],
        })),
      } as never;
      const tool = createListDirectoryTool(fileService);

      const result = await tool.execute({ path: '.', depth: 1, includeHidden: false }, createCtx());

      expect(result.output).toContain('d dir-a');
      expect(result.output).toContain('l link-b');
      expect(result.output).toContain('- file-c');
      expect(result.output).toContain('42B');
    });

    it('空目录：返回空目录提示', async () => {
      const fileService = {
        list: vi.fn(async () => ({ entries: [] })),
      } as never;
      const tool = createListDirectoryTool(fileService);

      const result = await tool.execute({ path: '.', depth: 1, includeHidden: false }, createCtx());

      expect(result.output).toContain('空目录');
    });
  });

  describe('lsp_definition 边界', () => {
    it('无声明位置：返回空结果提示', async () => {
      const manager = {
        getClient: vi.fn(async () => ({ definition: async () => [] })),
      } as unknown as LspServerManager;
      const tool = createLspDefinitionTool(manager);

      // 路径经 resolveWithinWorkspace 收口（2026-09-08）：须用工作区内路径
      const result = await tool.execute({ filePath: 'a.ts', line: 0, character: 0 }, createCtx());

      expect(result.output).toContain('未找到声明位置');
    });

    it('越界路径被守卫拒绝（2026-09-08 安全修复）', async () => {
      const manager = {
        getClient: vi.fn(async () => ({ definition: async () => [] })),
      } as unknown as LspServerManager;
      const tool = createLspDefinitionTool(manager);

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
          throw { weird: 'error-object' };
        }),
      } as unknown as LspServerManager;
      const tool = createLspDefinitionTool(manager);

      const result = await tool.execute({ filePath: 'a.ts', line: 0, character: 0 }, createCtx());

      expect(result.output).toContain('[object Object]');
    });
  });

  describe('grep 参数与上下文', () => {
    const baseInput = {
      pattern: 'foo',
      paths: [] as string[],
      caseSensitive: false,
      isRegex: true,
      include: undefined as string | undefined,
      exclude: [] as string[],
      maxResults: 100,
    };

    it('paths 非空：逐路径 resolve 后传递给 SearchService', async () => {
      const searchService = {
        grep: vi.fn(async () => ({ matches: [], truncated: false })),
      } as unknown as ISearchService;
      const grepMock = searchService as unknown as { grep: ReturnType<typeof vi.fn> };
      const tool = createGrepTool(searchService);

      await tool.execute({ ...baseInput, paths: ['src', 'test'] }, createCtx());

      const args = grepMock.grep.mock.calls[0]?.[0] as { paths: string[] } | undefined;
      // createCtx workingDir 固定为 Windows 盘符路径：POSIX 上 resolve 会把它当作相对段
      // 拼到 cwd 下，win32 上则按绝对路径使用——按平台计算期望值使断言跨平台成立
      const base = resolve(process.cwd(), 'C:\\projects\\my-app');
      expect(args?.paths).toEqual([join(base, 'src'), join(base, 'test')]);
    });

    it('匹配带上下文：输出标记（含上下文）', async () => {
      const searchService = {
        grep: vi.fn(async () => ({
          matches: [
            {
              file: '/a.ts',
              line: 3,
              column: 5,
              text: 'const foo = 1;',
              beforeContext: ['line2'],
              afterContext: ['line4'],
            },
          ],
          truncated: false,
        })),
      } as unknown as ISearchService;
      const tool = createGrepTool(searchService);

      const result = await tool.execute(baseInput, createCtx());

      expect(result.output).toContain('(含上下文)');
    });
  });

  describe('run_command 输出组合与边界', () => {
    it('stdout + stderr 双输出：拼接 + 成功状态', async () => {
      mockSpawnChild({ stdout: 'out-text', stderr: 'err-text', exitCode: 0 });
      const tool = createRunCommandTool();

      const result = await tool.execute(
        { command: 'node x.js', cwd: undefined, timeout: 3000 },
        createCtx(),
      );

      expect(result.output).toContain('out-text');
      expect(result.output).toContain('err-text');
      expect((result.metadata as { status?: string }).status).toBe('成功');
    });

    it('无输出：返回（无输出）', async () => {
      mockSpawnChild({ exitCode: 0 });
      const tool = createRunCommandTool();

      const result = await tool.execute(
        { command: 'cd .', cwd: undefined, timeout: 3000 },
        createCtx(),
      );

      expect(result.output).toBe('(无输出)');
    });

    it('非 0 退出码：失败状态（含 exit 码）', async () => {
      mockSpawnChild({ exitCode: 3 });
      const tool = createRunCommandTool();

      const result = await tool.execute(
        { command: 'exit 3', cwd: undefined, timeout: 3000 },
        createCtx(),
      );

      expect((result.metadata as { status?: string }).status).toContain('失败 (exit=3)');
    });

    it('abortSignal 已中止：立即 kill 子进程', async () => {
      const child = mockSpawnChild({ stdout: 'x', exitCode: 0 });
      const tool = createRunCommandTool();

      await tool.execute(
        { command: 'sleep 10', cwd: undefined, timeout: 3000 },
        createCtx({ aborted: true }),
      );

      expect(child.kill).toHaveBeenCalled();
    });

    it('输出超 100KB：截断保护（不无限累积）', async () => {
      const big = 'x'.repeat(150 * 1024);
      mockSpawnChild({ stdout: big, exitCode: 0 });
      const tool = createRunCommandTool();

      const result = await tool.execute(
        { command: 'big-output', cwd: undefined, timeout: 3000 },
        createCtx(),
      );

      const stdout = (result.metadata as { stdout?: string }).stdout ?? '';
      // 单块超限 → 不追加（截断语义：超过阈值的块整体丢弃）
      expect(stdout.length).toBeLessThan(big.length);
    });
  });

  describe('command-classifier 参数与缓存上限', () => {
    const mockLlmClient = (verdict: 'safe' | 'dangerous') =>
      ({
        generateJson: vi.fn(async () => ({ safe: verdict === 'safe', reason: 'test' })),
      }) as unknown as LlmClient;

    const llmMock = (llm: LlmClient): { generateJson: ReturnType<typeof vi.fn> } =>
      llm as unknown as { generateJson: ReturnType<typeof vi.fn> };

    it('userPrompt 传入：prompt 含用户意图上下文', async () => {
      const llm = mockLlmClient('safe');
      const classifier = new CommandClassifier(llm);

      await classifier.classify('npm test', '运行测试', undefined);

      const args = llmMock(llm).generateJson.mock.calls[0]?.[0] as { prompt?: string } | undefined;
      expect(args?.prompt).toContain('用户意图：运行测试');
    });

    it('signal 传入：generateJson 收到 abortSignal', async () => {
      const llm = mockLlmClient('safe');
      const classifier = new CommandClassifier(llm);
      const ac = new AbortController();

      await classifier.classify('npm test', undefined, ac.signal);

      const args = llmMock(llm).generateJson.mock.calls[0]?.[0] as
        | { signal?: AbortSignal }
        | undefined;
      expect(args?.signal).toBe(ac.signal);
    });

    it('缓存超限（200 条）：清空后重新调用 LLM', async () => {
      const llm = mockLlmClient('safe');
      const classifier = new CommandClassifier(llm);

      for (let i = 0; i < 200; i += 1) {
        await classifier.classify(`cmd-${i}`, undefined, undefined);
      }
      expect(llm.generateJson).toHaveBeenCalledTimes(200);

      // 第 201 条触发缓存清空（FIFO 清空），随后重复判定会重新调用
      await classifier.classify('cmd-200', undefined, undefined);
      await classifier.classify('cmd-0', undefined, undefined);

      // 清空后 cmd-0 的缓存丢失 → 重新调用
      expect(llm.generateJson).toHaveBeenCalledTimes(202);
    });
  });
});
