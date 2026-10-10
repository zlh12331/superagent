import { reportMessage } from '../../utils/error-report';
import { logger } from '../../utils/logger';
import type { EventLoopLagSample } from './event-loop-lag';

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
