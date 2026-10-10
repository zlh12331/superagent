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
  pattern: z.string().min(1),
  paths: z.array(z.string()).default([]),
  caseSensitive: z.boolean().default(false),
  isRegex: z.boolean().default(true),
  include: z
    .string()
    .optional()
    .transform((v) => v ?? undefined),
  exclude: z.array(z.string()).default([]),
  maxResults: z.number().int().positive().max(1000).default(100),
});

/**
 * 单条 grep 匹配结果 zod schema
 *
 * beforeContext / afterContext 为匹配行前后 N 行内容（N 由主进程固定为 2），
 * 用于渲染层展示匹配上下文（类似 ripgrep -A/-B 参数）。
 */
export const GrepMatchSchema = z.object({
  file: z.string(),
  line: z.number().int().positive(),
  column: z.number().int().nonnegative(),
  text: z.string(),
  beforeContext: z.array(z.string()).default([]),
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

/** search:grep 响应 zod schema（R3：响应契约校验） */
export const GrepResSchema = z.object({
  matches: z.array(GrepMatchSchema),
  truncated: z.boolean(),
});

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
  pattern: z.string().min(1),
  path: z.string().min(1),
  includeHidden: z.boolean().default(false),
  maxResults: z.number().int().positive().max(10000).default(1000),
});

/** search:glob 响应 payload */
export interface GlobRes {
  /** 匹配的文件绝对路径数组 */
  readonly files: readonly string[];
  /** 是否因达到 maxResults 被截断 */
  readonly truncated: boolean;
}

/** search:glob 响应 zod schema（R3：响应契约校验） */
export const GlobResSchema = z.object({
  files: z.array(z.string()),
  truncated: z.boolean(),
});
