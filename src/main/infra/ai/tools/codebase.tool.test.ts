// src/main/infra/ai/tools/codebase.tool.test.ts
// codebase 工具单测：6 操作分派 + 必填参数校验 + 默认值（mock ICodebaseService）

import { ErrorCode } from '@code-agent/shared/main';
import { describe, expect, it, vi } from 'vitest';
import type { ICodebaseService } from '../../codebase/codebase-service';
import { createCodebaseTool } from './codebase.tool';
import type { ToolContext } from './tool';

const ctx = { workingDir: '/repo' } as unknown as ToolContext;

function createMockService(overrides: Partial<ICodebaseService> = {}): ICodebaseService {
  return {
    ensureIndexed: vi.fn(async () => undefined),
    query: vi.fn(async () => ({ results: [] })),
    explore: vi.fn(async () => ({ markdown: 'explore-md' })),
    node: vi.fn(async () => ({ markdown: 'node-md' })),
    callers: vi.fn(async () => ({ markdown: 'callers-md' })),
    callees: vi.fn(async () => ({ markdown: 'callees-md' })),
    impact: vi.fn(async () => ({ markdown: 'impact-md' })),
    ...overrides,
  } as unknown as ICodebaseService;
}

describe('codebase 工具（6 操作分派）', () => {
  it('query：缺 search 抛 INVALID_INPUT', async () => {
    const tool = createCodebaseTool(createMockService());
    await expect(tool.execute({ operation: 'query' }, ctx)).rejects.toMatchObject({
      code: ErrorCode.INVALID_INPUT,
    });
  });

  it('query：带 search 调用服务并格式化结果', async () => {
    const service = createMockService({
      query: vi.fn(async () => ({
        results: [
          {
            node: {
              qualifiedName: 'App.run',
              filePath: 'src/main.ts',
              startLine: 10,
              kind: 'function',
            },
            score: 0.9,
          },
        ],
      })) as never,
    });
    const tool = createCodebaseTool(service);
    const res = await tool.execute({ operation: 'query', search: 'run' }, ctx);
    expect(service.query).toHaveBeenCalledWith({
      path: '/repo',
      search: 'run',
      limit: 10,
      kind: undefined,
    });
    expect(res.output).toContain('App.run');
    expect(res.output).toContain('src/main.ts:10');
  });

  it('explore：缺 exploreQuery 抛 INVALID_INPUT', async () => {
    const tool = createCodebaseTool(createMockService());
    await expect(tool.execute({ operation: 'explore' }, ctx)).rejects.toMatchObject({
      code: ErrorCode.INVALID_INPUT,
    });
  });

  it('explore：默认 maxFiles 5', async () => {
    const service = createMockService();
    const tool = createCodebaseTool(service);
    const res = await tool.execute({ operation: 'explore', exploreQuery: ['登录', '闪退'] }, ctx);
    expect(service.explore).toHaveBeenCalledWith({
      path: '/repo',
      query: ['登录', '闪退'],
      maxFiles: 5,
    });
    expect(res.output).toBe('explore-md');
  });

  it('callers/callees/impact：缺 symbol 均抛 INVALID_INPUT', async () => {
    const tool = createCodebaseTool(createMockService());
    for (const operation of ['callers', 'callees', 'impact'] as const) {
      await expect(tool.execute({ operation }, ctx)).rejects.toMatchObject({
        code: ErrorCode.INVALID_INPUT,
      });
    }
  });

  it('callers/callees：默认 limit 20', async () => {
    const service = createMockService();
    const tool = createCodebaseTool(service);
    await tool.execute({ operation: 'callers', symbol: 'foo' }, ctx);
    await tool.execute({ operation: 'callees', symbol: 'foo' }, ctx);
    expect(service.callers).toHaveBeenCalledWith({ path: '/repo', symbol: 'foo', limit: 20 });
    expect(service.callees).toHaveBeenCalledWith({ path: '/repo', symbol: 'foo', limit: 20 });
  });

  it('impact：默认 depth 2', async () => {
    const service = createMockService();
    const tool = createCodebaseTool(service);
    const res = await tool.execute({ operation: 'impact', symbol: 'foo' }, ctx);
    expect(service.impact).toHaveBeenCalledWith({ path: '/repo', symbol: 'foo', depth: 2 });
    expect(res.output).toBe('impact-md');
  });

  it('每次调用先 ensureIndexed（懒索引）', async () => {
    const service = createMockService();
    const tool = createCodebaseTool(service);
    await tool.execute({ operation: 'query', search: 'x' }, ctx);
    expect(service.ensureIndexed).toHaveBeenCalledWith('/repo');
  });
});
