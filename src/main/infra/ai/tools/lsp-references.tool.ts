// src/main/infra/ai/tools/lsp-references.tool.ts
// lsp_references 工具：查找符号全部引用（对齐 qwen LSP 工具语义收敛）
// ──────────────────────────────────────────────────────────────
// 设计：
// - 通过 LspServerManager 懒启动语言服务器（按工作区根目录复用）
// - 包含声明位置（includeDeclaration: true）；行/列 0 基
// - permission='auto' / category='read'：只读查询
// ──────────────────────────────────────────────────────────────

import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import type { LspServerManager } from '../../lsp/lsp-server-manager';
import type { Tool, ToolContext, ToolResult } from '../tool';

/** lsp_references 入参 */
const LspReferencesInputSchema = z.object({
  /** 目标文件绝对路径 */
  filePath: z.string().min(1).max(500),
  /** 行号（0 基） */
  line: z.number().int().min(0),
  /** 列号（0 基） */
  character: z.number().int().min(0),
});

type LspReferencesInput = z.infer<typeof LspReferencesInputSchema>;

/**
 * 创建 lsp_references 工具（依赖注入 LspServerManager）
 */
export function createLspReferencesTool(manager: LspServerManager): Tool<LspReferencesInput> {
  return {
    name: 'lsp_references',
    description:
      '查找文件指定位置符号的全部引用位置（含声明）。返回引用文件与行列列表，用于评估改动影响面。需要语言服务器可用。',
    inputSchema: LspReferencesInputSchema,
    permission: 'auto',
    category: 'read',
    execute: async (input: LspReferencesInput, ctx: ToolContext): Promise<ToolResult> => {
      try {
        const rootUri = pathToFileURL(ctx.workingDir).href;
        const client = await manager.getClient(rootUri);
        const locations = await client.references(pathToFileURL(input.filePath).href, {
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
          title: `引用位置: ${locations.length} 处`,
          output: lines.join('\n'),
        };
      } catch (err: unknown) {
        return {
          title: 'lsp_references 失败',
          output: `语言服务器不可用：${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },
  };
}
