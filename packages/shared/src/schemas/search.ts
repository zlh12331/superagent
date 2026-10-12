// search.ts：search 域（search:grep / search:glob）请求-响应 zod schema 单一真源
// 只管契约形状与默认值——检索实现在 src/main/infra/search/search-service.ts，请求类型在 packages/shared/src/ipc/payloads.ts 由此 z.infer 派生

import { z } from 'zod';

/**
 * search:grep 入参 schema（文件内容搜索）
 *
 * paths 可给多个搜索根（如同时搜 src 与 packages）。
 * include / exclude 是按文件名 glob 过滤（服务层分别转 ripgrep 的 -g 与 -g '!<glob>'），
 * 不作用于内容匹配本身。
 */
export const GrepReqSchema = z.object({
  // 搜索模式（依 isRegex 解释为正则或字面量）
  pattern: z.string().min(1),
  // 搜索范围（多个文件/目录）；空数组表示不追加路径参数——ripgrep 退回自身 cwd，
  // AI grep 工具层会在此之前补上会话工作目录
  paths: z.array(z.string()).default([]),
  // 是否区分大小写（默认 false；false 时服务层加 -i）
  caseSensitive: z.boolean().default(false),
  // 是否按正则解释（默认 true；false 时服务层加 -F 走字面量）
  isRegex: z.boolean().default(true),
  // 文件名 glob 过滤（如 '*.ts'；服务层转 ripgrep -g）
  include: z
    .string()
    .optional()
    .transform((v) => v ?? undefined),
  // 排除的文件名 glob 数组（如 ['node_modules', '.git']；服务层逐个转 -g '!<glob>'）
  exclude: z.array(z.string()).default([]),
  // 最大结果数（默认 100，上限 1000）；达上限即提前 kill ripgrep，避免子进程继续跑满 CPU/IO
  maxResults: z.number().int().positive().max(1000).default(100),
});

/**
 * 单条 grep 匹配结果 schema
 *
 * beforeContext / afterContext 为匹配行前后各 N 行原文（N 由主进程固定为 2，对应 ripgrep -A 2 -B 2），
 * 随每条 match 返回供调用方展示上下文（AI grep 工具据此在输出行尾标记）；靠近文件首尾时行数不足。
 */
export const GrepMatchSchema = z.object({
  // 匹配所在文件（绝对路径）
  file: z.string(),
  // 行号（1-based）
  line: z.number().int().positive(),
  // 列偏移（0-based，行内 UTF-8 字节偏移——取自 ripgrep submatch.start；含 CJK 时按字节计数，不等于 JS 字符串下标）
  column: z.number().int().nonnegative(),
  // 匹配行原文（已去行尾换行符）
  text: z.string(),
  // 匹配前的上下文行（最多 2 行，自上而下；文件头附近可能更少）
  beforeContext: z.array(z.string()).default([]),
  // 匹配后的上下文行（最多 2 行，自上而下）
  afterContext: z.array(z.string()).default([]),
});

/** 单条 grep 匹配结果类型（由 schema 派生，保证与校验一致） */
export type GrepMatch = z.infer<typeof GrepMatchSchema>;

/** search:grep 响应 payload */
export interface GrepRes {
  /** 匹配列表（最多 maxResults 条） */
  readonly matches: readonly GrepMatch[];
  /** 是否被截断：命中总数超过 maxResults（还有未返回的匹配）；恰好等于上限时为 false */
  readonly truncated: boolean;
}

/** search:grep 响应 schema（R3 响应契约校验：IPC 层复核 handler 返回值，防手写 Res interface 漂移） */
export const GrepResSchema = z.object({
  matches: z.array(GrepMatchSchema),
  truncated: z.boolean(),
});

/**
 * search:glob 入参 schema（按文件名匹配路径，不读内容；服务层走 ripgrep --files）
 *
 * 默认遵守 .gitignore，与 VSCode 文件搜索一致。
 * 注意：本块注释内不写 glob 字面量——星号紧邻斜杠即块注释结束符，会提前闭合（实测语法错）。
 * 示例 pattern：双星号 + 斜杠 + `.ts`（全部 TypeScript 文件），同一前缀加 `.test.ts` 后缀即测试文件。
 */
export const GlobReqSchema = z.object({
  // glob 模式（服务层转 ripgrep --files -g）
  pattern: z.string().min(1),
  // 搜索根目录（必填；IPC 层收口到工作区内，越界即拒绝）
  path: z.string().min(1),
  // 是否包含隐藏文件（默认 false；true 时服务层加 --hidden）
  includeHidden: z.boolean().default(false),
  // 最大结果数（默认 1000，上限 10000；达到上限即提前终止 ripgrep 子进程）
  maxResults: z.number().int().positive().max(10000).default(1000),
});

/** search:glob 响应 payload */
export interface GlobRes {
  /** 匹配的文件绝对路径数组 */
  readonly files: readonly string[];
  /** 是否被截断：文件数超过 maxResults（已提前终止 ripgrep）；恰好等于上限时为 false */
  readonly truncated: boolean;
}

/** search:glob 响应 schema（R3 响应契约校验：IPC 层复核 handler 返回值，防手写 Res interface 漂移） */
export const GlobResSchema = z.object({
  files: z.array(z.string()),
  truncated: z.boolean(),
});
