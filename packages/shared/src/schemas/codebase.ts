// packages/shared/src/schemas/codebase.ts
// Codebase 域 zod schema 单一真源
// ──────────────────────────────────────────────────────────────
// 职责：
// - 定义 codebase:query / explore / node / callers / callees / impact
//   6 个请求-响应 zod schema
// - 供主进程 CodebaseService 校验入参，封装 codegraph CLI 子进程调用
//
// 设计：
// - CodebaseService 通过 child_process.spawn('codegraph', [...args]) 调用 codegraph CLI
// - path 必须为绝对路径（codegraph 索引的项目根目录）
// - query 返回结构化 JSON（符号列表 + 相关度评分），便于渲染层展示
// - explore/node/callers/callees/impact 返回 markdown 文本，直接喂给 LLM 作为上下文
//   （这些命令的 JSON 结构复杂且易变，markdown 输出更稳定，对 LLM 友好）
// ──────────────────────────────────────────────────────────────

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

/** codebase:query 入参 zod schema */
export const CodebaseQueryReqSchema = z.object({
  // 项目根路径（绝对路径，codegraph 索引所在目录）
  path: z.string().min(1),
  // 搜索关键词（符号名片段，codegraph 内部用全文检索 + 模糊匹配）
  search: z.string().min(1),
  // 最大返回结果数（默认 10）
  limit: z.number().int().positive().max(100).default(10),
  // 按符号种类过滤（可选，如 'function' / 'class' / 'method'）
  kind: z
    .string()
    .optional()
    .transform((v) => v ?? undefined),
});

/**
 * codebase:query 响应 payload
 *
 * 返回结构化符号列表，便于渲染层展示符号选择器。
 * Code Agent 调用此方法快速查找符号定义位置。
 */
export interface CodebaseQueryRes {
  /** 搜索结果列表（按 score 降序排列） */
  readonly results: readonly CodebaseQueryResult[];
}

// ─── explore：区域探索（markdown 输出） ─────────────────────────

/** codebase:explore 入参 zod schema */
export const CodebaseExploreReqSchema = z.object({
  path: z.string().min(1),
  // 自然语言查询（codegraph 用语义检索查找相关符号 + 调用路径）
  // 数组形式对齐 CLI 的 variadic 参数（query... 支持空格分词）
  query: z.array(z.string()).min(1),
  // 包含源码的最大文件数（默认 5，限制输出长度避免 token 爆炸）
  maxFiles: z.number().int().positive().max(20).default(5),
});

/** codebase:explore 响应 payload：markdown 文本（含相关符号源码 + 调用路径） */
export interface CodebaseExploreRes {
  /** markdown 格式的探索结果（直接喂给 LLM 作为上下文） */
  readonly markdown: string;
}

// ─── node：符号详情（markdown 输出） ────────────────────────────

/** codebase:node 入参 zod schema */
export const CodebaseNodeReqSchema = z.object({
  path: z.string().min(1),
  // 符号名（可选，省略时返回项目概览）
  name: z
    .string()
    .optional()
    .transform((v) => v ?? undefined),
  // 文件模式：传入文件路径时返回文件内容 + 依赖分析（而非符号详情）
  file: z
    .string()
    .optional()
    .transform((v) => v ?? undefined),
  // 文件模式：起始行（1-based）
  offset: z.number().int().positive().optional(),
  // 文件模式：最大行数
  limit: z.number().int().positive().max(2000).optional(),
  // 文件模式：仅返回符号映射 + 依赖（不含文件内容）
  symbolsOnly: z.boolean().optional(),
});

/** codebase:node 响应 payload：markdown 文本（符号源码 + 调用链） */
export interface CodebaseNodeRes {
  readonly markdown: string;
}

// ─── callers：调用方查询（markdown 输出） ───────────────────────

/** codebase:callers 入参 zod schema */
export const CodebaseCallersReqSchema = z.object({
  path: z.string().min(1),
  // 目标符号名（查找谁调用了这个符号）
  symbol: z.string().min(1),
  // 最大返回结果数（默认 20）
  limit: z.number().int().positive().max(100).default(20),
});

/** codebase:callers 响应 payload：markdown 文本（调用方列表 + 调用位置） */
export interface CodebaseCallersRes {
  readonly markdown: string;
}

// ─── callees：被调用方查询（markdown 输出） ──────────────────────

/** codebase:callees 入参 zod schema */
export const CodebaseCalleesReqSchema = z.object({
  path: z.string().min(1),
  // 目标符号名（查找这个符号调用了哪些其他符号）
  symbol: z.string().min(1),
  // 最大返回结果数（默认 20）
  limit: z.number().int().positive().max(100).default(20),
});

/** codebase:callees 响应 payload：markdown 文本（被调用方列表 + 调用位置） */
export interface CodebaseCalleesRes {
  readonly markdown: string;
}

// ─── impact：影响分析（markdown 输出） ──────────────────────────

/** codebase:impact 入参 zod schema */
export const CodebaseImpactReqSchema = z.object({
  path: z.string().min(1),
  // 目标符号名（分析修改此符号会影响哪些代码）
  symbol: z.string().min(1),
  // 遍历深度（默认 2，最大建议不超过 5，避免输出过长）
  depth: z.number().int().positive().max(5).default(2),
});

/** codebase:impact 响应 payload：markdown 文本（影响范围分析） */
export interface CodebaseImpactRes {
  readonly markdown: string;
}
