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
//
// 调用方：agent-service.resolveTurnGeneration 经 resolveTokenBudgetBasis
// 把固定开销折算进有效窗口（见 agent-service.ts:727）。
// ──────────────────────────────────────────────────────────────

import { z } from 'zod';
import type { IToolRegistry } from '../tools/tool-registry';
import { estimateTokenCount } from './context-compression';

/**
 * 工具入参 schema → 可计量的文本（zod 或 AI SDK jsonSchema() 两种形态）
 *
 * 形态判别（对齐 tool.ts 的 inputSchema 联合类型 ZodType | Schema）：
 * - AI SDK `jsonSchema()` 产物带 `jsonSchema` 属性 → 直接 JSON.stringify 该属性
 * - 否则按 zod schema 处理，经 `z.toJSONSchema()` 转 JSON Schema 后序列化
 *
 * 转换失败（非上述两种形态、zod 转换抛错）返回空串——该工具退化为只计名称与描述，
 * 估算取保守下界（宁少算不漏算名称/描述，schema 缺失不阻断整个估算）。
 *
 * @returns 序列化文本；无法识别/转换失败为空串
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
  /** 固定开销 token 数（system prompt + 全部工具定义） */
  readonly overheadTokens: number;
  /** 有效窗口（已扣固定开销；下限见 resolveTokenBudgetBasis） */
  readonly effectiveWindow: number;
}

/**
 * 计算回合预算基准：有效窗口 = 模型窗口 − 固定开销
 *
 * 下限保留 50% 窗口：当固定开销过大（工具极多）使 `window − overhead` 趋近 0 时，
 * 取 `floor(window/2)` 兜底，防止有效窗口归零导致任何上下文都被判超限。
 *
 * @param contextWindowSize 模型上下文窗口（token）
 * @param systemPrompt system prompt（未配置传 undefined，不计入）
 * @param toolRegistry 工具注册表（遍历全部工具名计入定义）
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

/**
 * 估算「不进 messages 但真实请求会带」的固定开销（system prompt + 工具定义）
 *
 * 逐工具累计 name + description + 入参 schema 文本（schemaToTokenText），
 * 与 systemPrompt 一并按 `\n` 拼接后经 estimateTokenCount 精确计数。
 *
 * @param systemPrompt system prompt（undefined 或空串则跳过）
 * @param toolRegistry 工具注册表；get(name) 返回 undefined 的条目跳过
 */
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
