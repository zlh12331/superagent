// packages/shared/src/schemas/codebase.ts
// Codebase 域类型真源（服务层/Agent 工具共用）
// ──────────────────────────────────────────────
// 职责：
// - 定义 codegraph CLI 查询的返回类型（query 结构化结果 + markdown 输出）
// - CodebaseService 封装 codegraph CLI 子进程调用，返回上述类型
// - 消费方：codebase Agent 工具（infra/ai/tools/codebase.tool.ts）
//
// 说明：
// - path 必须为绝对路径（codegraph 索引的项目根目录）
// - query 返回结构化 JSON（符号列表 + 相关度评分）
// - explore/node/callers/callees/impact 返回 markdown 文本，直接喂给 LLM
//   （这些命令的 JSON 结构复杂且易变，markdown 输出更稳定，对 LLM 友好）
// ──────────────────────────────────────────────

import { z } from 'zod';

// ─── query：结构化符号搜索 ─────────────────────────────────────

/**
 * codegraph 符号节点 zod schema
 *
 * 描述代码库中一个符号（function/class/method/...）的元信息。
 * 字段与 codegraph query --json 输出的 node 对象对齐。
 *
 * 注意：visibility/signature 可能为 null（codegraph 对部分符号不提取这些信息），
 * 用 .nullish() 推断为 `string | null | undefined`，兼容 exactOptionalPropertyTypes。
 */
export const CodebaseSymbolNodeSchema = z.object({
  /** 符号唯一 ID（codegraph 内部 hash） */
  id: z.string(),
  /** 符号种类（function/class/method/property/interface/type_alias/...） */
  kind: z.string(),
  /** 短名称（如 'AgentService'） */
  name: z.string(),
  /** 完全限定名（如 'ServiceContainer::getAgentService'） */
  qualifiedName: z.string(),
  /** 源文件相对路径（相对项目根） */
  filePath: z.string(),
  /** 编程语言（typescript/tsx/...） */
  language: z.string(),
  /** 起始行号（1-based） */
  startLine: z.number().int(),
  /** 结束行号（1-based） */
  endLine: z.number().int(),
  /** 起始列号（1-based） */
  startColumn: z.number().int(),
  /** 结束列号（1-based） */
  endColumn: z.number().int(),
  /** 文档注释（可能为 null） */
  docstring: z.string().nullish(),
  /** 函数签名（仅 function/method 有，其他为 null） */
  signature: z.string().nullish(),
  /** 可见性（public/private/protected，可能为 null） */
  visibility: z.string().nullish(),
  /** 是否已导出 */
  isExported: z.boolean(),
  /** 是否为 async 函数 */
  isAsync: z.boolean(),
  /** 是否为静态成员 */
  isStatic: z.boolean(),
  /** 是否为抽象成员 */
  isAbstract: z.boolean(),
});

/** 符号节点类型 */
export type CodebaseSymbolNode = z.infer<typeof CodebaseSymbolNodeSchema>;

/**
 * query 单条搜索结果
 *
 * node 是符号元信息，score 是相关度评分（越高越相关）。
 */
export const CodebaseQueryResultSchema = z.object({
  node: CodebaseSymbolNodeSchema,
  /** 相关度评分（codegraph 全文检索 + 信号权重综合得分） */
  score: z.number(),
});

/** query 搜索结果类型 */
export type CodebaseQueryResult = z.infer<typeof CodebaseQueryResultSchema>;

/** codebase:query 响应 payload（结构化符号列表） */
export interface CodebaseQueryRes {
  /** 搜索结果列表（按 score 降序排列） */
  readonly results: readonly CodebaseQueryResult[];
}

// ─── explore：区域探索（markdown 输出） ─────────────────────────

/** codebase:explore 响应 payload：markdown 文本（含相关符号源码 + 调用路径） */
export interface CodebaseExploreRes {
  /** markdown 格式的探索结果（直接喂给 LLM 作为上下文） */
  readonly markdown: string;
}

// ─── node：符号详情（markdown 输出） ────────────────────────────

/** codebase:node 响应 payload：markdown 文本（符号源码 + 调用链） */
export interface CodebaseNodeRes {
  readonly markdown: string;
}

// ─── callers：调用方查询（markdown 输出） ───────────────────────

/** codebase:callers 响应 payload：markdown 文本（调用方列表 + 调用位置） */
export interface CodebaseCallersRes {
  readonly markdown: string;
}

// ─── callees：被调用方查询（markdown 输出） ──────────────────────

/** codebase:callees 响应 payload：markdown 文本（被调用方列表 + 调用位置） */
export interface CodebaseCalleesRes {
  readonly markdown: string;
}

// ─── impact：影响分析（markdown 输出） ──────────────────────────

/** codebase:impact 响应 payload：markdown 文本（影响范围分析） */
export interface CodebaseImpactRes {
  readonly markdown: string;
}
