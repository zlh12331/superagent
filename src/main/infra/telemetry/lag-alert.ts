// lag-alert.ts：事件循环阻塞告警的文案与上报（reportMessage + warn 双落）
import { reportMessage } from '../../utils/error-report';
import { logger } from '../../utils/logger';
import type { EventLoopLagSample } from './event-loop-lag';

/**
 * 上报一次阻塞采样：附活跃回合状态与堆占用（归因用——空闲期阻塞多半是系统级，
 * 回合期阻塞才指向我们的代码）
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
