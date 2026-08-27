// src/main/infra/ai/tools/codebase.tool.ts
// codebase 工具：codegraph 代码库智能查询（符号搜索/调用链/影响分析）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 把 CodebaseService 6 个查询能力（query/explore/node/callers/callees/impact）
//   注册为 Agent 工具——LLM 在对话中自主调用，无前端 UI
// - 懒索引（方案 A）：查询前 ensureIndexed，未索引自动 `codegraph init`
//   （大项目首次建索引较慢，由服务层 60s 超时兜底，超时向 LLM 返回提示）
//
// 权限：'auto'（全部只读查询，无副作用，自动执行）
// 入参：operation 判别 + 各操作专属参数（宽松 schema，execute 内按操作校验）
// 输出：query 返回结构化符号列表；其余返回 markdown 文本
// ──────────────────────────────────────────────────────────────

import { AppError, ErrorCode } from '@code-agent/shared/main';
import { z } from 'zod';

import type { ICodebaseService } from '../../codebase/codebase-service';
import { resolveWithinWorkspace } from './path-guard';
import type { Tool, ToolContext, ToolResult } from './tool';

const CodebaseInputSchema = z.object({
  operation: z
    .enum(['query', 'explore', 'node', 'callers', 'callees', 'impact'])
    .describe(
      '查询操作：query=符号搜索 / explore=自然语言探索 / node=符号或文件详情 / callers=谁调用此符号 / callees=此符号调用谁 / impact=修改此符号的影响范围',
    ),
  // query 专属
  search: z.string().optional().describe('符号搜索关键词（operation=query 时必填）'),
  kind: z
    .string()
    .optional()
    .describe('符号种类过滤（function/class/method/interface 等，query 可选）'),
  // explore 专属
  exploreQuery: z
    .array(z.string())
    .optional()
    .describe('自然语言探索查询（operation=explore 时必填，数组自动空格分词）'),
  maxFiles: z
    .number()
    .int()
    .positive()
    .max(20)
    .optional()
    .describe('explore 包含源码的最大文件数（默认 5）'),
  // node 专属（文件模式）
  file: z
    .string()
    .optional()
    .describe('node 文件模式：文件路径（相对或绝对，返回文件内容+依赖分析）'),
  offset: z.number().int().positive().optional().describe('node 文件模式起始行（1-based）'),
  symbolsOnly: z.boolean().optional().describe('node 文件模式仅返回符号映射+依赖（不含文件内容）'),
  // callers/callees/impact/node 共用
  symbol: z.string().optional().describe('目标符号名（callers/callees/impact 必填；node 可选填）'),
  depth: z.number().int().positive().max(5).optional().describe('impact 遍历深度（默认 2）'),
  // query/callers/callees 结果数与 node 文件行数共用
  limit: z
    .number()
    .int()
    .positive()
    .max(2000)
    .optional()
    .describe('结果数/行数上限（默认按操作：query 10 / callers 20 / callees 20）'),
});

type CodebaseInput = z.infer<typeof CodebaseInputSchema>;

export function createCodebaseTool(codebaseService: ICodebaseService): Tool<CodebaseInput> {
  return {
    name: 'codebase',
    description:
      '代码库智能查询（基于本地索引）：搜索符号定义位置、查看某符号的调用方与被调用方、分析修改影响范围、按自然语言探索代码区域。首次对当前工作目录查询时自动建立索引（大项目首次较慢，请等待索引完成后重试）。',
    inputSchema: CodebaseInputSchema,
    permission: 'auto',
    category: 'read',
    execute: async (input: CodebaseInput, ctx: ToolContext): Promise<ToolResult> => {
      // 懒索引（方案 A）：未索引自动 init（大项目首次可达数十秒，60s 超时兜底）
      await codebaseService.ensureIndexed(ctx.workingDir);
      const path = ctx.workingDir;
      // codegraph 查询路径固定为 workingDir（索引所在目录），-p 由服务层注入

      switch (input.operation) {
        case 'query': {
          if (input.search === undefined || input.search.length === 0) {
            throw new AppError(ErrorCode.INVALID_INPUT, 'operation=query 需要 search 参数');
          }
          const res = await codebaseService.query({
            path,
            search: input.search,
            limit: input.limit ?? 10,
            kind: input.kind,
          });
          const lines = res.results.map(
            (r, i) =>
              `${i + 1}. ${r.node.qualifiedName} — ${r.node.filePath}:${r.node.startLine} (${r.node.kind}, score=${r.score.toFixed(2)})`,
          );
          return {
            title: `符号搜索: ${input.search}`,
            output: lines.length > 0 ? lines.join('\n') : '未找到匹配符号',
            metadata: { count: res.results.length },
          };
        }

        case 'explore': {
          if (input.exploreQuery === undefined || input.exploreQuery.length === 0) {
            throw new AppError(ErrorCode.INVALID_INPUT, 'operation=explore 需要 exploreQuery 参数');
          }
          const res = await codebaseService.explore({
            path,
            query: input.exploreQuery,
            maxFiles: input.maxFiles ?? 5,
          });
          return { title: '代码区域探索', output: res.markdown };
        }

        case 'node': {
          const res = await codebaseService.node({
            path,
            name: input.symbol,
            file:
              input.file !== undefined && input.file.length > 0
                ? resolveWithinWorkspace(input.file, ctx.workingDir)
                : undefined,
            offset: input.offset,
            limit: input.limit,
            symbolsOnly: input.symbolsOnly,
          });
          return {
            title: `符号/文件详情: ${input.symbol ?? input.file ?? '(项目概览)'}`,
            output: res.markdown,
          };
        }

        case 'callers': {
          if (input.symbol === undefined) {
            throw new AppError(ErrorCode.INVALID_INPUT, 'operation=callers 需要 symbol 参数');
          }
          const res = await codebaseService.callers({
            path,
            symbol: input.symbol,
            limit: input.limit ?? 20,
          });
          return { title: `调用方: ${input.symbol}`, output: res.markdown };
        }

        case 'callees': {
          if (input.symbol === undefined) {
            throw new AppError(ErrorCode.INVALID_INPUT, 'operation=callees 需要 symbol 参数');
          }
          const res = await codebaseService.callees({
            path,
            symbol: input.symbol,
            limit: input.limit ?? 20,
          });
          return { title: `被调用方: ${input.symbol}`, output: res.markdown };
        }

        case 'impact': {
          if (input.symbol === undefined) {
            throw new AppError(ErrorCode.INVALID_INPUT, 'operation=impact 需要 symbol 参数');
          }
          const res = await codebaseService.impact({
            path,
            symbol: input.symbol,
            depth: input.depth ?? 2,
          });
          return { title: `影响分析: ${input.symbol}`, output: res.markdown };
        }
      }
    },
  };
}
