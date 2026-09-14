// src/main/infra/telemetry/lag-alert.ts
// 事件循环阻塞告警（2026-09-06 审计修复：补充现场上下文）
// ──────────────────────────────────────────────────────────────
// 此前只上报 lagMs，无法定位阻塞源。现在附带「当时是否有活跃回合」与堆占用，
// 便于把阻塞关联到具体操作（长会话分词 / 大库查询 / 备份 / 迁移）。
// ──────────────────────────────────────────────────────────────

import { reportMessage } from '../../utils/error-report';
import { logger } from '../../utils/logger';
import type { EventLoopLagSample } from './event-loop-lag';

/**
 * 上报一次事件循环阻塞告警
 *
 * @param sample 采样结果（lagMs / intervalMs）
 * @param hasActiveTurn 查询是否有活跃 agent 回合（由调用方注入，避免遥测层依赖 agent 层）
 */
export function reportEventLoopLag(sample: EventLoopLagSample, hasActiveTurn: () => boolean): void {
  const context = {
    lagMs: sample.lagMs,
    intervalMs: sample.intervalMs,
    activeTurn: hasActiveTurn(),
    heapUsedMb: Math.round(process.memoryUsage().heapUsed / 1_048_576),
  };
  reportMessage(
    `主进程事件循环阻塞：${sample.lagMs.toFixed(0)}ms（活跃回合=${context.activeTurn}，堆=${context.heapUsedMb}MB）`,
    'warning',
  );
  logger.warn(context, '主进程事件循环阻塞');
}
