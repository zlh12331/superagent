// src/main/infra/ai/tools/code-symbols.tool.ts
// code_symbols 工具：解析源文件语法树，列出顶层符号（只读）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 接收 LLM 生成的 path 入参
// - 通过 path-guard 把路径解析为 workingDir 内的绝对路径
// - 调用 CodeAnalyzer（web-tree-sitter）提取符号（解析失败降级，不阻塞）
//
// 权限：'auto'（只读操作，无副作用，自动执行）
//
// 接线说明：CodeAnalyzer 此前建成未接线（实现 + 单测齐全但零生产消费者），
// 本工具是其唯一生产入口——配合 read_file 使用可先看结构再按行读取，省 token。
// ──────────────────────────────────────────────────────────────

import { z } from 'zod';
import { getCodeAnalyzer } from '../../code-analysis/code-analyzer';
import { resolveWithinWorkspace } from './path-guard';
import type { Tool, ToolContext, ToolResult } from './tool';

const CodeSymbolsInputSchema = z.object({
  path: z.string().min(1).describe('源文件路径（相对路径基于工作目录解析）'),
});

type CodeSymbolsInput = z.infer<typeof CodeSymbolsInputSchema>;

/**
 * 创建 code_symbols 工具（CodeAnalyzer 模块单例内部懒加载 WASM）
 */
export function createCodeSymbolsTool(): Tool<CodeSymbolsInput> {
  return {
    name: 'code_symbols',
    description:
      '解析源文件语法树，列出顶层符号（函数/类/接口/类型/导入/方法 + 起始行号）。用于快速了解文件结构，比 read_file 更省 token。支持 ts/tsx/js/py/go/rs/java 等常见扩展名。',
    inputSchema: CodeSymbolsInputSchema,
    permission: 'auto',
    category: 'read',
    execute: async (input: CodeSymbolsInput, ctx: ToolContext): Promise<ToolResult> => {
      const absPath = resolveWithinWorkspace(input.path, ctx.workingDir);
      const result = await getCodeAnalyzer().analyze({ path: absPath });
      if (result.parseFailed) {
        return {
          title: `代码符号: ${input.path}`,
          output: '解析失败（语言不支持或 WASM 不可用），可改用 read_file 查看内容。',
        };
      }
      if (result.symbols.length === 0) {
        return { title: `代码符号: ${input.path}`, output: '未发现顶层符号。' };
      }
      const lines = result.symbols.map(
        (s) => `L${String(s.line).padStart(4)}  ${s.kind.padEnd(10)}  ${s.name}`,
      );
      return {
        title: `代码符号: ${input.path}（${result.symbols.length} 个，${result.language}）`,
        output: lines.join('\n'),
        metadata: { path: absPath, language: result.language, count: result.symbols.length },
      };
    },
  };
}
