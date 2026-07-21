// packages/shared/src/schemas/search.ts
// 搜索域 zod schema 单一真源
// ──────────────────────────────────────────────────────────────
// 职责：
// - 定义 search:grep / search:glob 请求-响应 zod schema
// - 供主进程 SearchService 校验入参，封装 ripgrep CLI
//
// 设计：
// - grep 基于 @vscode/ripgrep（已引入），支持正则与字面量两种模式
// - glob 基于 Node.js fs.glob 或自定义实现（ripgrep 也支持 --files）
// - 结果数上限保护：maxResults 默认 100，避免超大代码库 OOM
// - 路径必须为绝对路径（主进程校验），SearchService 内部进行 workingDir 边界检查
// ──────────────────────────────────────────────────────────────

import { z } from 'zod';

/**
 * search:grep 入参 zod schema
 *
 * paths 数组：可指定多个搜索根（如同时搜 src 与 packages）。
 * 省略 paths 时默认搜索当前工作目录。
 *
 * include：文件名 glob 过滤（如 '*.ts'），等价于 ripgrep 的 -g 参数
 * exclude：排除的文件名 glob 数组（如 ['node_modules', '.git']）
 */
export const GrepReqSchema = z.object({
  // 正则或字面量模式
  pattern: z.string().min(1),
  // 搜索范围（多个目录或文件，空数组表示搜索当前工作目录）
  paths: z.array(z.string()).default([]),
  // 是否大小写敏感（默认 false）
  caseSensitive: z.boolean().default(false),
  // 是否作为正则（默认 true）；false 时作为字面量字符串匹配
  isRegex: z.boolean().default(true),
  // 文件名 glob 过滤（如 '*.ts'）
  include: z
    .string()
    .optional()
    .transform((v) => v ?? undefined),
  // 排除的文件名 glob 数组
  exclude: z.array(z.string()).default([]),
  // 最大结果数（默认 100，上限 1000 防止 OOM）
  maxResults: z.number().int().positive().max(1000).default(100),
});

/**
 * 单条 grep 匹配结果 zod schema
 *
 * beforeContext / afterContext 为匹配行前后 N 行内容（N 由主进程固定为 2），
 * 用于渲染层展示匹配上下文（类似 ripgrep -A/-B 参数）。
 */
export const GrepMatchSchema = z.object({
  // 匹配所在文件绝对路径
  file: z.string(),
  // 行号（1-based）
  line: z.number().int().positive(),
  // 列号（0-based）
  column: z.number().int().nonnegative(),
  // 匹配行的完整文本
  text: z.string(),
  // 匹配前的上下文行（数组，每项一行）
  beforeContext: z.array(z.string()).default([]),
  // 匹配后的上下文行
  afterContext: z.array(z.string()).default([]),
});

/** 单条 grep 匹配结果类型 */
export type GrepMatch = z.infer<typeof GrepMatchSchema>;

/** search:grep 响应 payload */
export interface GrepRes {
  readonly matches: readonly GrepMatch[];
  /** 是否因达到 maxResults 被截断 */
  readonly truncated: boolean;
}

/**
 * search:glob 入参 zod schema
 *
 * glob 模式匹配文件路径（不读取内容），用于"按文件名查找"场景。
 *
 * 示例 pattern（注意：注释中不写 glob 字面量，避免 `*` `/` 序列被误判为注释结束）：
 * - 双星斜杠 .ts：所有 TypeScript 文件（glob: 双星 + 斜杠 + .ts）
 * - src 下双星斜杠 .ts/.tsx：src 目录下所有 ts/tsx
 * - 双星斜杠 .test.ts：所有测试文件
 */
export const GlobReqSchema = z.object({
  // glob 模式
  pattern: z.string().min(1),
  // 搜索根目录
  path: z.string().min(1),
  // 是否包含隐藏文件（默认 false）
  includeHidden: z.boolean().default(false),
  // 最大结果数（默认 1000，上限 10000）
  maxResults: z.number().int().positive().max(10000).default(1000),
});

/** search:glob 响应 payload */
export interface GlobRes {
  /** 匹配的文件绝对路径数组 */
  readonly files: readonly string[];
  /** 是否因达到 maxResults 被截断 */
  readonly truncated: boolean;
}
