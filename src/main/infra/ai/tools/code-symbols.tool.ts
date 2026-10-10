import { z } from 'zod';
import { getCodeAnalyzer } from '../../code-analysis/code-analyzer';
import { t } from '../../i18n';
import { resolveWithinWorkspace } from './path-guard';
import type { Tool, ToolContext, ToolResult } from './tool';

const CodeSymbolsInputSchema = z.object({
  path: z.string().min(1).describe('源文件路径（相对路径基于工作目录解析）'),
});

type CodeSymbolsInput = z.infer<typeof CodeSymbolsInputSchema>;

export function createCodeSymbolsTool(): Tool<CodeSymbolsInput> {
  return {
    name: 'code_symbols',
    description:
      '解析源文件语法树，列出顶层符号（函数/类/接口/类型/导入/方法 + 起始行号）。用于快速了解文件结构，比 read_file 更省 token。支持 ts/tsx/js/py/go/rs/java 等常见扩展名。',
    inputSchema: CodeSymbolsInputSchema,
    permission: 'auto',
    category: 'read',
    execute: async (input: CodeSymbolsInput, ctx: ToolContext): Promise<ToolResult> => {
      const { resolved, realTarget } = resolveWithinWorkspace(input.path, ctx.workingDir);
      const result = await getCodeAnalyzer().analyze({ path: realTarget });
      if (result.parseFailed) {
        return {
          title: t('tools.codeSymbols.title', { path: input.path }),
          output: '解析失败（语言不支持或 WASM 不可用），可改用 read_file 查看内容。',
        };
      }
      if (result.symbols.length === 0) {
        return {
          title: t('tools.codeSymbols.title', { path: input.path }),
          output: '未发现顶层符号。',
        };
      }
      const lines = result.symbols.map(
        (s) => `L${String(s.line).padStart(4)}  ${s.kind.padEnd(10)}  ${s.name}`,
      );
      return {
        title: t('tools.codeSymbols.titleWithCount', {
          path: input.path,
          count: result.symbols.length,
          language: result.language,
        }),
        output: lines.join('\n'),
        metadata: { path: resolved, language: result.language, count: result.symbols.length },
      };
    },
  };
}
