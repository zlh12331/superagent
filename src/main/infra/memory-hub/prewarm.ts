import { logger } from '../../utils/logger';
import type { MemoryHubService } from './memory-hub-service';
import { isMemoryEnabled } from './memory-pref';

/** 预热延迟：先让窗口完成首帧，避免与渲染层启动争抢 CPU */
export const PREWARM_DELAY_MS = 3_000;

/** 预热决策输入（显式传入，便于单测各分支） */
export interface PrewarmDecision {
  /** 引擎是否已配置（hubRoot 可解析到上游入口） */
  readonly configured: boolean;
  /** 用户开关是否启用（关闭则无需预热） */
  readonly enabled: boolean;
  /** 是否测试环境（NODE_ENV=test：不拉起子进程，避免测试期副作用） */
  readonly isTest: boolean;
  /** 是否显式豁免（E2E/基准等场景用 CODE_AGENT_SKIP_MEMORY_PREWARM=1） */
  readonly skipFlag: boolean;
}

/**
 * 是否应预热记忆引擎（纯函数）
 *
 * 跳过条件（任一）：
 * - 引擎未配置（未捆绑/路径不可解析）→ 预热只会重复失败
 * - 用户已关闭记忆功能 → 预热无意义（且关闭语义应包含"不启动引擎耗资源"）
 * - 测试环境 → 避免在单测/集成测试里拉起子进程
 * - 显式豁免 → E2E 需要稳定的启动耗时与 CPU 占用
 */
export function shouldPrewarm(decision: PrewarmDecision): boolean {
  if (!decision.configured) return false;
  if (!decision.enabled) return false;
  if (decision.isTest) return false;
  if (decision.skipFlag) return false;
  return true;
}

/** 已调度标记（模块级：预热全局只需一次） */
let scheduled = false;

/** 预热调度参数 */
export interface SchedulePrewarmParams {
  readonly service: MemoryHubService;
  /** 覆盖默认延迟（测试用） */
  readonly delayMs?: number;
}

/**
 * 调度引擎预热（幂等；不阻塞调用方，失败静默）
 *
 * @example
 * ```ts
 * // index.ts whenReady 流程末尾（窗口/托盘创建之后）
 * scheduleMemoryPrewarm({ service: serviceContainer.getMemoryHubService() });
 * ```
 */
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
