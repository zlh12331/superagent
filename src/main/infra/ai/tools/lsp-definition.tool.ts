// src/main/infra/ai/tools/lsp-definition.tool.ts
// lsp_definition 工具：跳转声明位置（对齐 qwen LSP 工具语义收敛）
// ──────────────────────────────────────────────────────────────
// 设计：
// - 通过 LspServerManager 懒启动语言服务器（按工作区根目录复用）
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

/** lsp_definition 入参 */
const LspDefinitionInputSchema = z.object({
  /** 目标文件绝对路径 */
  filePath: z.string().min(1).max(500),
  /** 行号（0 基） */
  line: z.number().int().min(0),
  /** 列号（0 基） */
  character: z.number().int().min(0),
});

type LspDefinitionInput = z.infer<typeof LspDefinitionInputSchema>;

/**
 * 创建 lsp_definition 工具（依赖注入 LspServerManager）
 */
export function createLspDefinitionTool(manager: LspServerManager): Tool<LspDefinitionInput> {
  return {
    name: 'lsp_definition',
    description:
      '查询文件指定位置符号的声明位置（跳转定义）。返回目标文件与行列；多结果时全部返回。按文件扩展名路由语言服务器（TypeScript/JavaScript、Python、Go、Rust 内置支持，可在设置中覆盖命令）。',
    inputSchema: LspDefinitionInputSchema,
    permission: 'auto',
    category: 'read',
    execute: async (input: LspDefinitionInput, ctx: ToolContext): Promise<ToolResult> => {
      try {
        const absPath = resolveWithinWorkspace(input.filePath, ctx.workingDir);
        const rootUri = pathToFileURL(ctx.workingDir).href;
        const client = await manager.getClient(rootUri, absPath);
        const locations = await client.definition(pathToFileURL(absPath).href, {
          line: input.line,
          character: input.character,
        });
        if (locations.length === 0) {
          return { title: 'lsp_definition', output: '（未找到声明位置）' };
        }
        const lines = locations.map((location) => {
          const { start, end } = location.range;
          return `- ${location.uri.replace('file://', '')} (${start.line + 1}:${start.character + 1}-${end.line + 1}:${end.character + 1})`;
        });
        return {
          title: `定义位置: ${locations.length} 处`,
          output: lines.join('\n'),
        };
      } catch (err: unknown) {
        return {
          title: 'lsp_definition 失败',
          output: `语言服务器不可用：${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },
  };
}
