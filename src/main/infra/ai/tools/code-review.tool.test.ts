// src/main/infra/ai/tools/code-review.tool.test.ts
// code_review 工具单测：路径解析 + 行统计 + 输出格式（mock IFileService）

import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { IFileService } from '../../file/file-service';
import { createCodeReviewTool } from './code-review.tool';
import type { ToolContext } from './tool';

const ctx = { workingDir: '/repo' } as unknown as ToolContext;

function makeFileService(content: string, totalLines = content.split('\n').length): IFileService {
  return {
    read: vi.fn(async () => ({
      content,
      totalLines,
      encoding: 'utf-8',
    })),
  } as unknown as IFileService;
}

describe('code_review', () => {
  it('读取文件并按 workingDir 解析路径', async () => {
    const fs = makeFileService('const a = 1;');
    const res = await createCodeReviewTool(fs).execute({ path: 'src/main.ts' }, ctx);
    expect(fs.read).toHaveBeenCalledWith({
      path: resolve(ctx.workingDir, 'src/main.ts'),
      offset: undefined,
      limit: undefined,
    });
    expect(res.output).toContain('文件内容（1 行）');
  });

  it('行统计：总/代码/注释/空行各自计数', async () => {
    const content = ['// 注释', 'const a = 1;', '', 'function b() {}'].join('\n');
    const fs = makeFileService(content);
    const res = await createCodeReviewTool(fs).execute({ path: 'a.ts' }, ctx);
    expect(res.metadata).toMatchObject({
      totalLines: 4,
      commentLines: 1,
      codeLines: 2,
      blankLines: 1,
    });
  });
});
