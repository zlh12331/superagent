// packages/shared/src/schemas/whitelist.ts
// 命令白名单域（whitelist:list / add / remove）
// ──────────────────────────────────────────────────────────────
// 对齐原型「命令白名单」面板（whitelist-panel）：
// - 白名单命令自动批准，无需每次审批
// - 条目按工具名 + 命令模式匹配（pattern 为空 = 该工具全部放行）
// - 持久化于主进程 userData/whitelist.json（跨会话生效，区别于
//   "记住决策"的 5 分钟会话级缓存）
// ──────────────────────────────────────────────────────────────

import { z } from 'zod';

/** 白名单条目 zod schema */
export const WhitelistEntrySchema = z.object({
  /** 工具名（如 run_command / write_file） */
  toolName: z.string().min(1).max(64),
  /** 命令匹配模式（子串匹配；空串 = 该工具全部放行） */
  pattern: z.string().max(512).default(''),
});

/** 白名单条目 TypeScript 类型 */
export type WhitelistEntry = z.infer<typeof WhitelistEntrySchema>;

/** whitelist:add 请求 payload zod schema */
export const WhitelistAddReqSchema = WhitelistEntrySchema;

/** whitelist:remove 请求 payload zod schema */
export const WhitelistRemoveReqSchema = WhitelistEntrySchema;

/** whitelist:list 响应 payload */
export interface WhitelistListRes {
  /** 全部白名单条目 */
  readonly entries: readonly WhitelistEntry[];
}

/** whitelist:add 响应 payload */
export interface WhitelistAddRes {
  readonly ok: boolean;
}

/** whitelist:remove 响应 payload */
export interface WhitelistRemoveRes {
  readonly ok: boolean;
}
