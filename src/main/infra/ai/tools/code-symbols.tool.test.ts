// src/main/infra/ai/tools/code-symbols.tool.test.ts
// code_symbols 工具单测：解析降级 / 空符号 / 行格式化（mock CodeAnalyzer）

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createCodeSymbolsTool } from './code-symbols.tool';
import type { ToolContext } from './tool';

const { mockAnalyzer } = vi.hoisted(() => ({ mockAnalyzer: { analyze: vi.fn() } }));

vi.mock('../../code-analysis/code-analyzer', () => ({
  getCodeAnalyzer: () => mockAnalyzer,
}));

const mockedAnalyze = vi.mocked(mockAnalyzer.analyze);
const ctx = { workingDir: '/repo' } as unknown as ToolContext;

describe('code_symbols', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('解析成功：按行号格式输出符号（L 前缀）', async () => {
    mockedAnalyze.mockResolvedValueOnce({
      parseFailed: false,
      language: 'typescript',
      symbols: [
        { name: 'run', kind: 'function', line: 3 },
        { name: 'App', kind: 'class', line: 10 },
      ],
    });
    const res = await createCodeSymbolsTool().execute({ path: 'src/main.ts' }, ctx);
    expect(res.output).toContain('L   3  function    run');
    expect(res.output).toContain('L  10  class       App');
    expect(res.metadata).toMatchObject({ count: 2, language: 'typescript' });
  });

  it('解析失败（语言不支持/WASM 不可用）→ 降级提示 read_file', async () => {
    mockedAnalyze.mockResolvedValueOnce({ parseFailed: true, language: 'unknown', symbols: [] });
    const res = await createCodeSymbolsTool().execute({ path: 'a.xyz' }, ctx);
    expect(res.output).toContain('解析失败');
    expect(res.output).toContain('read_file');
  });

  it('无顶层符号 → 明确提示', async () => {
    mockedAnalyze.mockResolvedValueOnce({
      parseFailed: false,
      language: 'typescript',
      symbols: [],
    });
    const res = await createCodeSymbolsTool().execute({ path: 'a.ts' }, ctx);
    expect(res.output).toContain('未发现顶层符号');
  });
});
