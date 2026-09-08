// src/main/infra/ai/tools/lsp-hover.tool.ts
// lsp_hover 工具：悬停信息（类型签名/文档；对齐 qwen LSP 工具语义收敛）
// ──────────────────────────────────────────────────────────────
// 设计：
// - 通过 LspServerManager 懒启动语言服务器（按 根目录×语言 复用）
// - 文件路径 → file:// URI（pathToFileURL）；行/列 0 基
// - permission='auto' / category='read'：只读查询
// - 服务器不可用/启动失败 → 明确错误（不阻断回合）
// - 路径经 resolveWithinWorkspace 收口：语言服务器会按 URI 读取文件内容，
//   缺少守卫时 auto/read 通道可越界读取工作区外任意源码文件（2026-09-08 修复）
// ──────────────────────────────────────────────────────────────

import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import type { LspServerManager } from '../../lsp/lsp-server-manager';
import { resolveWithinWorkspace } from './path-guard';
import type { Tool, ToolContext, ToolResult } from './tool';

/** lsp_hover 入参 */
const LspHoverInputSchema = z.object({
  /** 目标文件绝对路径 */
  filePath: z.string().min(1).max(500),
  /** 行号（0 基） */
  line: z.number().int().min(0),
  /** 列号（0 基） */
  character: z.number().int().min(0),
});

type LspHoverInput = z.infer<typeof LspHoverInputSchema>;

/**
 * 创建 lsp_hover 工具（依赖注入 LspServerManager）
 */
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
        const absPath = resolveWithinWorkspace(input.filePath, ctx.workingDir);
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
          title: `悬停信息: ${input.filePath.split(/[\\/]/).pop() ?? input.filePath}`,
          output: hover.contents,
        };
      } catch (err: unknown) {
        return {
          title: 'lsp_hover 失败',
          output: `语言服务器不可用：${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },
  };
}
