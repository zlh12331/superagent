// src/main/infra/ai/agent/token-overhead.ts
// 上下文预算的「固定开销」估算（system prompt + 全部工具定义）
// ──────────────────────────────────────────────────────────────
// 背景（2026-09-06 审计修复）：预算 / 压缩 / 拒止此前只统计 messages，
// 而供应商收到的请求还包含 system（模板 + 动态上下文 + 记忆召回）与全部工具
// schema（30+ 内置工具 + MCP 动态工具）。小窗口模型（32K / 64K）下把 messages
// 压到 0.75×window 后，叠加固定开销仍会超窗 → 400 或静默截断。
//
// 从 agent-service 抽出独立模块：该估算与回合编排无关，且 agent-service
// 已是 file-size 棘轮下的存量超限文件（新增逻辑应放新文件）。
// ──────────────────────────────────────────────────────────────

import { z } from 'zod';
import type { IToolRegistry } from '../tools/tool-registry';
import { estimateTokenCount } from './context-compression';

/**
 * 工具入参 schema → 可计量的文本（zod 或 AI SDK jsonSchema() 两种形态）
 *
 * 转换失败返回空串（该工具只计名称与描述，估算取保守下界）。
 */
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

/** 回合预算口径：固定开销 + 扣除开销后的有效窗口 */
export interface TokenBudgetBasis {
  readonly overheadTokens: number;
  readonly effectiveWindow: number;
}

/**
 * 计算回合预算基准：有效窗口 = 模型窗口 − 固定开销（下限保留 50%，防工具极多时归零）
 */
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

/** 估算「不进 messages 但真实请求会带」的固定开销（system prompt + 工具定义） */
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
