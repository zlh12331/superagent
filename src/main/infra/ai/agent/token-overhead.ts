// token-overhead.ts：回合固定开销估算——工具 schema 集 + 系统提示词的 token 占用（预算决策的基数）
import { z } from 'zod';
import type { IToolRegistry } from '../tools/tool-registry';
import { estimateTokenCount } from './context-compression';

function schemaToTokenText(schema: unknown): string {
  if (schema === undefined || schema === null) {
    return '';
  }
  const asAiSdk = schema as { jsonSchema?: unknown };
  if (asAiSdk.jsonSchema !== undefined) {
    return JSON.stringify(asAiSdk.jsonSchema);
  }
  try {
    return JSON.stringify(z.toJSONSchema(schema as z.ZodType));
  } catch {
    return '';
  }
}

export interface TokenBudgetBasis {
  readonly overheadTokens: number;
  readonly effectiveWindow: number;
}

export function resolveTokenBudgetBasis(
  contextWindowSize: number,
  systemPrompt: string | undefined,
  toolRegistry: IToolRegistry,
): TokenBudgetBasis {
  const overheadTokens = estimateFixedOverheadTokens(systemPrompt, toolRegistry);
  return {
    overheadTokens,
    effectiveWindow: Math.max(
      Math.floor(contextWindowSize / 2),
      contextWindowSize - overheadTokens,
    ),
  };
}

export function estimateFixedOverheadTokens(
  systemPrompt: string | undefined,
  toolRegistry: IToolRegistry,
): number {
  const parts: string[] = [];
  if (systemPrompt !== undefined && systemPrompt.length > 0) {
    parts.push(systemPrompt);
  }
  for (const name of toolRegistry.getAllNames()) {
    const tool = toolRegistry.get(name);
    if (tool === undefined) {
      continue;
    }
    parts.push(tool.name, tool.description, schemaToTokenText(tool.inputSchema));
  }
  return estimateTokenCount(parts.join('\n'));
}
