import { z } from 'zod';

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

/** codebase:explore 响应 payload：markdown 文本（含相关符号源码 + 调用路径） */
export interface CodebaseExploreRes {
  /** markdown 格式的探索结果（直接喂给 LLM 作为上下文） */
  readonly markdown: string;
}

/** codebase:node 响应 payload：markdown 文本（符号源码 + 调用链） */
export interface CodebaseNodeRes {
  readonly markdown: string;
}

/** codebase:callers 响应 payload：markdown 文本（调用方列表 + 调用位置） */
export interface CodebaseCallersRes {
  readonly markdown: string;
}

/** codebase:callees 响应 payload：markdown 文本（被调用方列表 + 调用位置） */
export interface CodebaseCalleesRes {
  readonly markdown: string;
}

/** codebase:impact 响应 payload：markdown 文本（影响范围分析） */
export interface CodebaseImpactRes {
  readonly markdown: string;
}
