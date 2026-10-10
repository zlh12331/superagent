// invalidation.ts：失效域契约——invalidation:event:domains 事件 payload + 域词表 + 回合结束聚合声明
// 域元素形如 'sessions' / 'session:<id>'：渲染层 split(':') 得 queryKey 前缀，前半段与渲染层
// QUERY_KEY_ROOTS 的键对齐（src/renderer/lib/query/keys.ts）。失效「知识」收敛在写入端声明，
// 收发实现分处 src/main/infra/invalidation/ 与 src/renderer/lib/invalidation/，本文件只定义契约。

import { z } from 'zod';

// ────────── 事件 payload（主进程 → 渲染层）──────────

/** invalidation:event:domains 事件 payload zod schema（经 IPC 定义表引用，主进程发送侧 dev 校验） */
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

// ────────── 失效域词表与回合结束聚合声明 ──────────

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
  im: 'im', // 刻意不入 QUERY_KEY_ROOTS：靠 key 首段命中 IM_CHANNELS_QUERY_KEY（'im'）
} as const;

/**
 * 回合结束聚合声明的「全局」域（不含按会话的 session:<id>）
 *
 * 经 turnEndInvalidationDomains 随事件广播；渲染层覆盖判定
 * （src/renderer/lib/invalidation/ 的 coversTurnEndDomains）逐域核对本表，
 * 故本表即「一个回合结束牵动哪些域」的声明真源。
 * 增删本表须同步渲染层回落清单（src/renderer/hooks/use-agent-bridge.ts 的
 * handleSessionEnd，那里是手写清单、并非由本表派生）：本表少一域而回落清单有它时，
 * 覆盖仍判为已登记 ⇒ 回落被跳过，该域静默 stale。
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
 * 回合结束聚合声明域清单（7 全局域 + 1 个 session:<id>）
 *
 * 唯一调用点：src/main/infra/ai/agent/agent-service.ts 的 completeTurn（completed / aborted /
 * error 三出口共用，有头与无头回合都广播）。顺序无语义，渲染层逐域独立失效。
 */
export function turnEndInvalidationDomains(sessionId: string): readonly string[] {
  const [sessions, ...rest] = TURN_END_GLOBAL_DOMAINS;
  return [sessions, INVALIDATION_DOMAINS.session(sessionId), ...rest];
}
