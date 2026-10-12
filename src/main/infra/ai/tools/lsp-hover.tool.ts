// lsp-hover.tool.ts：lsp_hover 工具——悬停文档（lsp-server-manager 承载）
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { t } from '../../i18n';
import type { LspServerManager } from '../../lsp/lsp-server-manager';
import { resolveWithinWorkspace } from './path-guard';
import type { Tool, ToolContext, ToolResult } from './tool';

const LspHoverInputSchema = z.object({
  filePath: z.string().min(1).max(500),
  line: z.number().int().min(0),
  character: z.number().int().min(0),
});

type LspHoverInput = z.infer<typeof LspHoverInputSchema>;

export function createLspHoverTool(manager: LspServerManager): Tool<LspHoverInput> {
  return {
    name: 'lsp_hover',
    description:
      '查询文件指定位置符号的悬停信息（类型签名与文档注释）。用于在不读整个文件的前提下确认 API 签名与类型。按文件扩展名路由语言服务器（TypeScript/JavaScript、Python、Go、Rust 内置支持）。',
    inputSchema: LspHoverInputSchema,
    permission: 'auto',
    category: 'read',
    execute: async (input: LspHoverInput, ctx: ToolContext): Promise<ToolResult> => {
      try {
        const absPath = resolveWithinWorkspace(input.filePath, ctx.workingDir).realTarget;
        const rootUri = pathToFileURL(ctx.workingDir).href;
        const client = await manager.getClient(rootUri, absPath);
        const hover = await client.hover(pathToFileURL(absPath).href, {
          line: input.line,
          character: input.character,
        });
        if (hover === null || hover.contents.trim().length === 0) {
          return { title: 'lsp_hover', output: '（该位置无悬停信息）' };
        }
        return {
          title: t('tools.lspHover.title', {
            file: input.filePath.split(/[\\/]/).pop() ?? input.filePath,
          }),
          output: hover.contents,
        };
      } catch (err: unknown) {
        return {
          title: t('tools.lspHover.failed'),
          output: `语言服务器不可用：${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },
  };
}
