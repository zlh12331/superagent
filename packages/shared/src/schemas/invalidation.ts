// packages/shared/src/schemas/invalidation.ts
// 失效域契约（invalidation:event:domains 事件 payload + 域词表）
// ──────────────────────────────────────────────────────────────
// 背景（docs/design/31-invalidation-automation-spec.md）：主进程写路径声明式携带
// 受影响域，经 invalidation:event:domains 广播；渲染层按域前缀失效 TanStack Query
// 缓存。域「知识」收敛到写入端（主进程），渲染层不再逐域人工补失效清单
// （task/usage/git/file/turns 五连遗漏与 memory/IM 运行态缺口的同根解法）。
//
// 域元素形如 'sessions' 或 'session:<id>'：渲染层 split(':') 得 queryKey 前缀
// （'sessions' → ['sessions']；'session:<id>' → ['session', '<id>']），
// 前半段与渲染层 lib/query/keys.ts 的 QUERY_KEY_ROOTS 键一一对应。
// ──────────────────────────────────────────────────────────────

import { z } from 'zod';

/** invalidation:event:domains 事件 payload zod schema（主进程发送侧 dev 校验） */
export const InvalidationPayloadSchema = z.object({
  /** 受影响的域清单（至少一个；渲染层逐域前缀失效） */
  domains: z.array(z.string().min(1)).min(1),
  /** 引发失效的会话 id（可选上下文；失效指令以 domains 为准） */
  sessionId: z.string().min(1).optional(),
});

/** invalidation:event:domains 事件 payload：受影响域 + 可选会话上下文 */
export interface InvalidationPayload {
  /** 受影响的域清单（元素形如 'sessions' / 'session:<id>'） */
  readonly domains: readonly string[];
  /** 引发失效的会话 id（可选；供日志排障与未来按会话过滤） */
  readonly sessionId?: string;
}

/**
 * 失效域词表（主进程声明点统一取词，禁散写字面量）
 *
 * 值即 payload 元素：渲染层 split(':') 后前半段为 queryKey 根，
 * 与渲染层 QUERY_KEY_ROOTS 键对齐（漂移由 lib/invalidation 单测锚定）。
 */
export const INVALIDATION_DOMAINS = {
  /** 会话列表域：'sessions' → ['sessions']（侧栏分页列表） */
  sessions: 'sessions',
  /** 单会话域：'session:<id>' → ['session', '<id>'] 前缀（详情 + 回合历史子 key） */
  session: (sessionId: string): string => `session:${sessionId}`,
  goal: 'goal',
  task: 'task',
  usage: 'usage',
  git: 'git',
  file: 'file',
  turns: 'turns',
  memory: 'memory',
  im: 'im',
} as const;

/**
 * 回合结束聚合声明的「全局」域（不含按会话的 session:<id>）
 *
 * 迁移自渲染层 use-agent-bridge 的硬编码清单（task/usage/git/file/turns 五连
 * 遗漏的最终形态）；渲染层回落判定（事件是否已覆盖回合结束域）引用同一常量，
 * 声明侧与消费侧共用单一真源，清单漂移在编译期暴露。
 */
export const TURN_END_GLOBAL_DOMAINS = [
  'sessions',
  'goal',
  'task',
  'usage',
  'git',
  'file',
  'turns',
] as const;

/**
 * 回合结束聚合声明域清单（8 域）
 *
 * 唯一调用点：agent-service.completeTurn（completed/aborted/error 三出口共用，
 * 有头/无头回合都广播）。顺序无语义，渲染层逐域独立失效。
 */
export function turnEndInvalidationDomains(sessionId: string): readonly string[] {
  const [sessions, ...rest] = TURN_END_GLOBAL_DOMAINS;
  return [sessions, INVALIDATION_DOMAINS.session(sessionId), ...rest];
}
