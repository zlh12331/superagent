import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { t } from '../../i18n';
import type { LspServerManager } from '../../lsp/lsp-server-manager';
import { resolveWithinWorkspace } from './path-guard';
import type { Tool, ToolContext, ToolResult } from './tool';

const LspReferencesInputSchema = z.object({
  filePath: z.string().min(1).max(500),
  line: z.number().int().min(0),
  character: z.number().int().min(0),
});

type LspReferencesInput = z.infer<typeof LspReferencesInputSchema>;

export function createLspReferencesTool(manager: LspServerManager): Tool<LspReferencesInput> {
  return {
    name: 'lsp_references',
    description:
      '查找文件指定位置符号的全部引用位置（含声明）。返回引用文件与行列列表，用于评估改动影响面。按文件扩展名路由语言服务器（TypeScript/JavaScript、Python、Go、Rust 内置支持）。',
    inputSchema: LspReferencesInputSchema,
    permission: 'auto',
    category: 'read',
    execute: async (input: LspReferencesInput, ctx: ToolContext): Promise<ToolResult> => {
      try {
        const absPath = resolveWithinWorkspace(input.filePath, ctx.workingDir).realTarget;
        const rootUri = pathToFileURL(ctx.workingDir).href;
        const client = await manager.getClient(rootUri, absPath);
        const locations = await client.references(pathToFileURL(absPath).href, {
          line: input.line,
          character: input.character,
        });
        if (locations.length === 0) {
          return { title: 'lsp_references', output: '（未找到引用位置）' };
        }
        const lines = locations.map((location) => {
          const { start, end } = location.range;
          return `- ${location.uri.replace('file://', '')} (${start.line + 1}:${start.character + 1}-${end.line + 1}:${end.character + 1})`;
        });
        return {
          title: t('tools.lspReferences.locations', { count: locations.length }),
          output: lines.join('\n'),
        };
      } catch (err: unknown) {
        return {
          title: t('tools.lspReferences.failed'),
          output: `语言服务器不可用：${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },
  };
}
