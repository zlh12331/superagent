// src/main/infra/ai/tools/code-review.tool.ts
// code_review 工具：代码审查工具，供 Code Agent 分析代码质量
// ──────────────────────────────────────────────────────────────
// 职责：
// - 接收 LLM 生成的 path 入参
// - 通过 path-guard 把路径解析为 workingDir 内的绝对路径
// - 调用 FileService.read 读取文件内容
// - 返回结构化的代码审查结果（给 LLM 看，由 LLM 生成具体审查意见）
//
// 权限：'auto'（只读操作，无副作用，自动执行）
//
// 入参：
// - path：文件路径（相对或绝对，相对路径基于 workingDir 解析）
//
// 输出：ToolResult（title + output 文本 + metadata 结构化数据）
// ──────────────────────────────────────────────────────────────

import type { FileReadRes } from '@code-agent/shared/main';
import { z } from 'zod';
import type { IFileService } from '../../file/file-service';
import { resolveWithinWorkspace } from './path-guard';
import type { Tool, ToolContext, ToolResult } from './tool';

const CodeReviewInputSchema = z.object({
  path: z.string().min(1).describe('要审查的文件路径（相对路径基于工作目录解析）'),
});

type CodeReviewInput = z.infer<typeof CodeReviewInputSchema>;

export function createCodeReviewTool(fileService: IFileService): Tool<CodeReviewInput> {
  return {
    name: 'code_review',
    description:
      '读取文件内容并准备代码审查。读取指定文件的完整内容，供后续分析代码质量、潜在问题、安全性漏洞、性能优化建议等。路径可相对工作目录或绝对路径（必须在工作目录内）。',
    inputSchema: CodeReviewInputSchema,
    permission: 'auto',
    category: 'read',
    execute: async (input: CodeReviewInput, ctx: ToolContext): Promise<ToolResult> => {
      const absPath = resolveWithinWorkspace(input.path, ctx.workingDir);

      const result: FileReadRes = await fileService.read({
        path: absPath,
        offset: undefined,
        limit: undefined,
      });

      const lines = result.content.split('\n');
      const stats = {
        totalLines: result.totalLines,
        blankLines: lines.filter((l) => l.trim().length === 0).length,
        codeLines: lines.filter((l) => l.trim().length > 0 && !l.trim().startsWith('//')).length,
        commentLines: lines.filter((l) => l.trim().startsWith('//')).length,
      };

      const output = `文件内容（${result.totalLines} 行）:\n\n${result.content}\n\n---\n文件统计:\n- 总行数: ${stats.totalLines}\n- 代码行: ${stats.codeLines}\n- 注释行: ${stats.commentLines}\n- 空行: ${stats.blankLines}`;

      return {
        title: `代码审查: ${input.path}`,
        output,
        metadata: {
          path: absPath,
          ...stats,
          encoding: result.encoding,
        },
      };
    },
  };
}
