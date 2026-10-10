// prewarm.ts：记忆引擎启动预热——启动 3s 后后台拉起引擎（首条消息即可用，不用现场等 60s）
import { logger } from '../../utils/logger';
import type { MemoryHubService } from './memory-hub-service';
import { isMemoryEnabled } from './memory-pref';

export const PREWARM_DELAY_MS = 3_000;

/** 预热四条件（纯函数化供测试）：已配置 + 已启用 + 非测试 + 无豁免环境变量 */
export interface PrewarmDecision {
  readonly configured: boolean;
  readonly enabled: boolean;
  readonly isTest: boolean;
  readonly skipFlag: boolean;
}

export function shouldPrewarm(decision: PrewarmDecision): boolean {
  if (!decision.configured) return false;
  if (!decision.enabled) return false;
  if (decision.isTest) return false;
  if (decision.skipFlag) return false;
  return true;
}

let scheduled = false;

export interface SchedulePrewarmParams {
  readonly service: MemoryHubService;
  readonly delayMs?: number;
}

/** 启动序列调用（幂等）：判定通过则延迟预热；失败只告警——首次真实调用时引擎会重试启动 */
export function scheduleMemoryPrewarm(params: SchedulePrewarmParams): void {
  if (scheduled) return;

  const run = shouldPrewarm({
    configured: params.service.isConfigured(),
    enabled: isMemoryEnabled(),
    isTest: process.env['NODE_ENV'] === 'test',
    skipFlag: process.env['CODE_AGENT_SKIP_MEMORY_PREWARM'] === '1',
  });
  if (!run) {
    logger.info({}, '[memory-hub] 跳过启动预热（未配置 / 测试环境 / 显式豁免）');
    return;
  }

  scheduled = true;
  const delayMs = params.delayMs ?? PREWARM_DELAY_MS;
  const timer = setTimeout(() => {
    const startedAt = Date.now();
    void params.service
      .ensureStarted()
      .then(async (port) => {
        logger.info(
          { elapsedMs: Date.now() - startedAt, healthy: await port.health() },
          '[memory-hub] 启动预热完成',
        );
      })
      .catch((error: unknown) => {
        logger.warn(
          {
            elapsedMs: Date.now() - startedAt,
            error: error instanceof Error ? error.message : String(error),
          },
          '[memory-hub] 启动预热失败（记忆功能将在首次调用时重试）',
        );
      });
  }, delayMs);
  timer.unref();
}
