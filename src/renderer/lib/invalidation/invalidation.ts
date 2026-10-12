import { INVALIDATION_DOMAINS, TURN_END_GLOBAL_DOMAINS } from '@code-agent/shared/renderer';

import { queryClient } from '@/lib/query/query-client';

/** 覆盖登记的 TTL：事件与 stream:end 的到达间隔是毫秒级，30s 已是数量级冗余 */
const COVERED_TTL_MS = 30_000;
/** 覆盖登记容量上界（并发回合会话数远低于此；超限逐出最旧，防泄漏） */
const COVERED_MAX_ENTRIES = 128;

/**
 * 失效域 → queryKey 前缀
 *
 * 'sessions' → ['sessions']；'session:abc' → ['session', 'abc']。
 * 非法形态（空串 / 空段如 'session:'）返回 null，调用方跳过——
 * 前向兼容：旧渲染层收到未来新增的域形状时静默降级而不是抛错。
 */
export function domainToQueryKey(domain: string): readonly string[] | null {
  if (domain.length === 0) {
    return null;
  }
  const segments = domain.split(':');
  const root = segments[0];
  if (root === undefined || root.length === 0) {
    return null;
  }
  if (segments.slice(1).some((segment) => segment.length === 0)) {
    return null;
  }
  return segments;
}

/**
 * 逐域前缀失效（未知/非法域跳过）
 */
export function applyDomainInvalidation(domains: readonly string[]): void {
  for (const domain of domains) {
    const key = domainToQueryKey(domain);
    if (key !== null) {
      void queryClient.invalidateQueries({ queryKey: key });
    }
  }
}

/** 会话 id → 覆盖登记时间（epoch ms） */
const coveredTurnEnd = new Map<string, number>();

/** 事件 domains 是否已完整覆盖该会话的回合结束聚合声明（spec §2.5） */
function coversTurnEndDomains(domains: readonly string[], sessionId: string): boolean {
  if (sessionId.length === 0) {
    return false;
  }
  return (
    domains.includes(INVALIDATION_DOMAINS.session(sessionId)) &&
    TURN_END_GLOBAL_DOMAINS.every((domain) => domains.includes(domain))
  );
}

/** 逐出过期与超容量条目（写路径顺带清理；读路径只清理命中的过期条目） */
function pruneCovered(now: number): void {
  for (const [sessionId, at] of coveredTurnEnd) {
    if (now - at > COVERED_TTL_MS) {
      coveredTurnEnd.delete(sessionId);
    }
  }
  while (coveredTurnEnd.size >= COVERED_MAX_ENTRIES) {
    const oldest = coveredTurnEnd.keys().next();
    if (oldest.done === true) {
      break;
    }
    coveredTurnEnd.delete(oldest.value);
  }
}

/**
 * 记录一次失效事件：命中回合结束聚合声明时登记该会话已覆盖
 *
 * @param domains 事件携带的域清单
 * @param sessionId 事件上下文会话 id（缺省无登记意义，忽略）
 */
export function noteInvalidationEvent(domains: readonly string[], sessionId?: string): void {
  if (sessionId === undefined) {
    return;
  }
  if (!coversTurnEndDomains(domains, sessionId)) {
    return;
  }
  const now = Date.now();
  pruneCovered(now);
  coveredTurnEnd.set(sessionId, now);
}

/**
 * 该会话的回合结束域是否已由 invalidation 事件覆盖（未覆盖/过期/空 id → false）
 */
export function isTurnEndCovered(sessionId: string): boolean {
  const at = coveredTurnEnd.get(sessionId);
  if (at === undefined) {
    return false;
  }
  if (Date.now() - at > COVERED_TTL_MS) {
    coveredTurnEnd.delete(sessionId);
    return false;
  }
  return true;
}

/** 清空覆盖登记（仅测试用；生产进程内随 TTL 自然过期） */
export function resetInvalidationCoverage(): void {
  coveredTurnEnd.clear();
}
