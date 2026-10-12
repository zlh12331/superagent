// whitelist.ts：命令白名单域（whitelist:list / add / remove）契约单一真源——条目形状 + 三个方法的入参/响应 schema
// 边界：只定形状与值域；持久化（主进程 userData/whitelist.json）与命中放行判定在
//   src/main/infra/storage/whitelist-pref.ts 与 src/main/infra/ai/tools/permission-service.ts
// 关键语义：命中条目的命令免逐次审批且跨会话生效，区别于「记住决策」的会话级限时记忆
//   （时长真源 = packages/shared/src/constants/approval.ts 的 REMEMBER_TTL_MS）

import { z } from 'zod';

// ────────── 条目与入参：条目形状即 add / remove 的 payload（删除按 工具名 + 模式 定位） ──────────

/**
 * 白名单条目 zod schema
 *
 * 长度上限（toolName 64 / pattern 512）由 IPC 入参/响应解析侧（src/main/utils/wrap.ts 的
 * schema.safeParse）强制；持久化与匹配层不复查长度，故调上限只改变解析侧的接受范围。
 */
export const WhitelistEntrySchema = z.object({
  /** 工具名（如 run_command / write_file），须与 Tool.name 逐字一致才会被匹配 */
  toolName: z.string().min(1).max(64),
  /**
   * 命令匹配模式（token 级前缀匹配，大小写敏感）
   *
   * 空串 / 纯通配符（`*` `?` 仅空白等）语义上等于「放行该工具的全部调用」：
   * 新增时被拒、加载时清理、匹配时永不命中（fail closed；判据单一真源见
   * src/main/infra/ai/tools/command-guards.ts）。`.default('')` 只表示字段缺省时
   * 补空串，补出的空串同样会被上述判据拒绝。
   */
  pattern: z.string().max(512).default(''),
});

/** 白名单条目 TypeScript 类型（由 schema 推导，勿手写同形 interface 造成漂移） */
export type WhitelistEntry = z.infer<typeof WhitelistEntrySchema>;

/** whitelist:add 请求 payload zod schema（与条目同形） */
export const WhitelistAddReqSchema = WhitelistEntrySchema;

/** whitelist:remove 请求 payload zod schema（工具名 + 模式才能定位条目，故同样需要完整条目形状） */
export const WhitelistRemoveReqSchema = WhitelistEntrySchema;

// ────────── 响应契约：list 回全量条目，add / remove 回通用 ok 形状 ──────────

/** whitelist:list 响应 payload（每次调用返回全量条目，非增量） */
export interface WhitelistListRes {
  /** 全部白名单条目 */
  readonly entries: readonly WhitelistEntry[];
}

/** whitelist:list 响应 zod schema（响应契约校验用） */
export const WhitelistListResSchema = z.object({
  entries: z.array(WhitelistEntrySchema),
});

/**
 * 通用 ok 响应 zod schema
 *
 * whitelist:add / remove 的响应形状；packages/shared/src/ipc/definitions.ts 中
 * app / agent / browser / goal / im / mcp / update 等域的定义项也复用它。
 */
export const OkResSchema = z.object({
  /** 成功标记；whitelist 域 handler 恒返回 true——失败经 AppError 走 IPC error 通道下发，不用 ok:false 表达 */
  ok: z.boolean(),
});

/** whitelist:add 响应 payload */
export interface WhitelistAddRes {
  /** 成功标记（语义同 OkResSchema.ok） */
  readonly ok: boolean;
}

/** whitelist:remove 响应 payload */
export interface WhitelistRemoveRes {
  /** 成功标记（语义同 OkResSchema.ok） */
  readonly ok: boolean;
}
