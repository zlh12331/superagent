// codebase.ts：Codebase 域类型真源——服务层包装的六个 codegraph 命令的返回形状
// （query 为结构化符号列表，explore/node/callers/callees/impact 为 markdown 文本）
// 消费方：src/main/infra/codebase/codebase-service.ts 子进程调用后原样返回，
// src/main/infra/ai/tools/codebase.tool.ts 再把结果作为工具输出交给 LLM
// 边界：只定义形状，不发起调用、不解析输出；能力只经 Agent 工具暴露，未定义 IPC 通道

import { z } from 'zod';

// ─── query：结构化符号搜索（服务层唯一按 JSON 消费的命令） ──────

/**
 * codegraph 符号节点 zod schema
 *
 * 描述代码库中一个符号（function/class/method/...）的元信息，
 * 字段与 `codegraph query --json` 输出里的 node 对象对齐。
 *
 * kind / language / visibility 保持 `z.string()` 不收窄为枚举：上游清单随
 * codegraph 版本增删（NODE_KINDS 明确「只追加、不重排」），收窄会在升级后失配。
 *
 * 可空字段用 `.nullish()` 而非 `.optional()`：CLI 无值时报 null（visibility）
 * 或整体缺省（docstring/signature），而 `.optional()` 不接 null（判 invalid_type）。
 */
export const CodebaseSymbolNodeSchema = z.object({
  /** 符号唯一 ID（`<kind>:<32 位 hex>`，codegraph 按文件路径 + 限定名取哈希） */
  id: z.string(),
  /** 符号种类（上游 NODE_KINDS 全集，如 function/class/method/property/interface/type_alias） */
  kind: z.string(),
  /** 短名称（如 'AgentService'） */
  name: z.string(),
  /** 完全限定名（如 'CodebaseService::parseQueryResults'） */
  qualifiedName: z.string(),
  /** 源文件路径，相对 codegraph 索引的项目根 */
  filePath: z.string(),
  /** 编程语言（typescript/tsx/python/go/rust/...） */
  language: z.string(),
  /** 起始行号（1-based） */
  startLine: z.number().int(),
  /** 结束行号（1-based） */
  endLine: z.number().int(),
  /** 起始列号（0-based，与行号基准不同） */
  startColumn: z.number().int(),
  /** 结束列号（0-based） */
  endColumn: z.number().int(),
  /** 文档注释正文（无注释时字段整体缺省） */
  docstring: z.string().nullish(),
  /** 函数/方法签名（class/interface 等本就没有签名的种类字段缺省） */
  signature: z.string().nullish(),
  /** 可见性（public/private/protected/internal；多数符号无此信息，输出 null） */
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

/** 符号节点类型（由 CodebaseSymbolNodeSchema 推断，改 schema 即同步） */
export type CodebaseSymbolNode = z.infer<typeof CodebaseSymbolNodeSchema>;

/**
 * query 单条搜索结果
 *
 * node 是符号元信息，score 是相关度评分（越高越相关）。
 */
export const CodebaseQueryResultSchema = z.object({
  node: CodebaseSymbolNodeSchema,
  /**
   * 相关度评分：BM25 与名称匹配/路径相关/符号种类等信号的加权合计。
   * 无上界、只用于相对排序（上游 CLI 也因此不打印它）——不要当百分比展示。
   */
  score: z.number(),
});

/** query 搜索结果类型（由 CodebaseQueryResultSchema 推断） */
export type CodebaseQueryResult = z.infer<typeof CodebaseQueryResultSchema>;

/** CodebaseService.query 的返回（结构化符号列表，供 Agent 工具渲染成编号清单） */
export interface CodebaseQueryRes {
  /** 搜索结果列表（按 score 降序；生成的脚手架代码被 codegraph 压到手写实现之后） */
  readonly results: readonly CodebaseQueryResult[];
}

// ─── 其余五个命令：markdown 文本返回 ────────────────────────────
// 服务层不解析这些输出、原样透传（explore 与 node 上游本就没有 JSON 模式，
// markdown 形态也更适合直接作工具输出喂给 LLM）。

/** CodebaseService.explore 的返回：相关符号源码 + 调用路径，一次性给出一个区域的上下文 */
export interface CodebaseExploreRes {
  /** markdown 文本（上游输出原样透传，不解析） */
  readonly markdown: string;
}

/** CodebaseService.node 的返回：单个符号的源码 + 调用链，或文件模式下的带行号文件内容 */
export interface CodebaseNodeRes {
  /** markdown 文本（上游输出原样透传，不解析） */
  readonly markdown: string;
}

/** CodebaseService.callers 的返回：目标符号的全部调用方及调用位置 */
export interface CodebaseCallersRes {
  /** markdown 文本（上游输出原样透传，不解析） */
  readonly markdown: string;
}

/** CodebaseService.callees 的返回：目标符号调用的全部符号及调用位置 */
export interface CodebaseCalleesRes {
  /** markdown 文本（上游输出原样透传，不解析） */
  readonly markdown: string;
}

/** CodebaseService.impact 的返回：改动某符号的影响面（按遍历深度展开） */
export interface CodebaseImpactRes {
  /** markdown 文本（上游输出原样透传，不解析） */
  readonly markdown: string;
}
