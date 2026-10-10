import { z } from 'zod';

/** 白名单条目 zod schema */
export const WhitelistEntrySchema = z.object({
  /** 工具名（如 run_command / write_file） */
  toolName: z.string().min(1).max(64),
  /** 命令匹配模式（token 级前缀匹配；空/纯通配符被拒 —— 等同放行该工具全部调用） */
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

/** whitelist:list 响应 zod schema（响应契约校验用） */
export const WhitelistListResSchema = z.object({
  entries: z.array(WhitelistEntrySchema),
});

/** 通用 ok 响应 zod schema（whitelist:add / remove 共用） */
export const OkResSchema = z.object({
  ok: z.boolean(),
});

/** whitelist:add 响应 payload */
export interface WhitelistAddRes {
  readonly ok: boolean;
}

/** whitelist:remove 响应 payload */
export interface WhitelistRemoveRes {
  readonly ok: boolean;
}
