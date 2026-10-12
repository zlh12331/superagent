// codebase.tool.ts：codebase 工具——语义检索/调用图/影响面（codebase-service 承载）
import { AppError, ErrorCode } from '@code-agent/shared/main';
import { z } from 'zod';
import type { ICodebaseService } from '../../codebase/codebase-service';
import { t } from '../../i18n';
import { resolveWithinWorkspace } from './path-guard';
import type { Tool, ToolContext, ToolResult } from './tool';

const CodebaseInputSchema = z.object({
  operation: z
    .enum(['query', 'explore', 'node', 'callers', 'callees', 'impact'])
    .describe(
      '查询操作：query=符号搜索 / explore=自然语言探索 / node=符号或文件详情 / callers=谁调用此符号 / callees=此符号调用谁 / impact=修改此符号的影响范围',
    ),
  search: z.string().optional().describe('符号搜索关键词（operation=query 时必填）'),
  kind: z
    .string()
    .optional()
    .describe('符号种类过滤（function/class/method/interface 等，query 可选）'),
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
  file: z
    .string()
    .optional()
    .describe('node 文件模式：文件路径（相对或绝对，返回文件内容+依赖分析）'),
  offset: z.number().int().positive().optional().describe('node 文件模式起始行（1-based）'),
  symbolsOnly: z.boolean().optional().describe('node 文件模式仅返回符号映射+依赖（不含文件内容）'),
  symbol: z.string().optional().describe('目标符号名（callers/callees/impact 必填；node 可选填）'),
  depth: z.number().int().positive().max(5).optional().describe('impact 遍历深度（默认 2）'),
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
      await codebaseService.ensureIndexed(ctx.workingDir);
      const path = ctx.workingDir;

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
            title: t('tools.codebase.symbolSearch', { search: input.search }),
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
          return { title: t('tools.codebase.explore'), output: res.markdown };
        }

        case 'node': {
          const res = await codebaseService.node({
            path,
            name: input.symbol,
            file:
              input.file !== undefined && input.file.length > 0
                ? resolveWithinWorkspace(input.file, ctx.workingDir).realTarget
                : undefined,
            offset: input.offset,
            limit: input.limit,
            symbolsOnly: input.symbolsOnly,
          });
          return {
            title: t('tools.codebase.detail', {
              target: input.symbol ?? input.file ?? '(项目概览)',
            }),
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
          return {
            title: t('tools.codebase.callers', { symbol: input.symbol }),
            output: res.markdown,
          };
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
          return {
            title: t('tools.codebase.callees', { symbol: input.symbol }),
            output: res.markdown,
          };
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
          return {
            title: t('tools.codebase.impact', { symbol: input.symbol }),
            output: res.markdown,
          };
        }
      }
    },
  };
}
