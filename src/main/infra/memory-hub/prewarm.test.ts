// src/main/infra/memory-hub/prewarm.test.ts
// 记忆引擎启动预热单测：决策分支 + 调度行为（幂等/失败静默/延迟）
// ──────────────────────────────────────────────────────────────
// 说明：scheduleMemoryPrewarm 有模块级幂等标记，故用 vi.resetModules() +
//   动态 import 隔离各用例的模块状态。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));

vi.mock('../../utils/logger', () => ({
  logger: { info: mocks.info, warn: mocks.warn, error: mocks.error, debug: mocks.debug },
}));

/** 读取（重置模块后）的 prewarm 模块 */
async function loadModule() {
  vi.resetModules();
  return import('./prewarm');
}

describe('shouldPrewarm（纯决策）', () => {
  /** 基线决策：已配置 + 已启用 + 非测试 + 无豁免 */
  const base = { configured: true, enabled: true, isTest: false, skipFlag: false } as const;

  it('引擎已配置且启用、非测试、无豁免 → 预热', async () => {
    const { shouldPrewarm } = await loadModule();
    expect(shouldPrewarm(base)).toBe(true);
  });

  it('引擎未配置 → 不预热（重复失败无意义）', async () => {
    const { shouldPrewarm } = await loadModule();
    expect(shouldPrewarm({ ...base, configured: false })).toBe(false);
  });

  it('用户关闭记忆功能 → 不预热（关闭语义含不启动引擎耗资源）', async () => {
    const { shouldPrewarm } = await loadModule();
    expect(shouldPrewarm({ ...base, enabled: false })).toBe(false);
  });

  it('测试环境 → 不预热（避免测试期拉起子进程）', async () => {
    const { shouldPrewarm } = await loadModule();
    expect(shouldPrewarm({ ...base, isTest: true })).toBe(false);
  });

  it('显式豁免 → 不预热（E2E 需稳定启动耗时）', async () => {
    const { shouldPrewarm } = await loadModule();
    expect(shouldPrewarm({ ...base, skipFlag: true })).toBe(false);
  });
});

describe('scheduleMemoryPrewarm（调度）', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    delete process.env['CODE_AGENT_SKIP_MEMORY_PREWARM'];
    delete process.env['NODE_ENV'];
  });

  afterEach(() => {
    vi.useRealTimers();
    process.env = { ...originalEnv };
  });

  /** 构造 fake 服务（只用到 isConfigured 与 ensureStarted） */
  function fakeService(overrides?: { configured?: boolean; reject?: boolean }) {
    const health = vi.fn(async () => true);
    const ensureStarted = vi.fn(async () => {
      if (overrides?.reject === true) throw new Error('sidecar 就绪超时');
      return { health };
    });
    return {
      isConfigured: () => overrides?.configured ?? true,
      ensureStarted,
    } as unknown as import('./memory-hub-service').MemoryHubService & {
      ensureStarted: typeof ensureStarted;
    };
  }

  it('延迟后拉起引擎（不阻塞调用方）', async () => {
    const { scheduleMemoryPrewarm, PREWARM_DELAY_MS } = await loadModule();
    const service = fakeService();
    scheduleMemoryPrewarm({ service });

    // 立即返回：延迟未到不应启动
    expect(service.ensureStarted).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(PREWARM_DELAY_MS);
    expect(service.ensureStarted).toHaveBeenCalledTimes(1);
    expect(mocks.info).toHaveBeenCalledWith(
      expect.objectContaining({ healthy: true }),
      '[memory-hub] 启动预热完成',
    );
  });

  it('幂等：重复调度只拉起一次', async () => {
    const { scheduleMemoryPrewarm, PREWARM_DELAY_MS } = await loadModule();
    const service = fakeService();
    scheduleMemoryPrewarm({ service });
    scheduleMemoryPrewarm({ service });
    await vi.advanceTimersByTimeAsync(PREWARM_DELAY_MS);
    expect(service.ensureStarted).toHaveBeenCalledTimes(1);
  });

  it('引擎未配置：不调度且不报错', async () => {
    const { scheduleMemoryPrewarm, PREWARM_DELAY_MS } = await loadModule();
    const service = fakeService({ configured: false });
    scheduleMemoryPrewarm({ service });
    await vi.advanceTimersByTimeAsync(PREWARM_DELAY_MS);
    expect(service.ensureStarted).not.toHaveBeenCalled();
  });

  it('显式豁免（env）：不调度', async () => {
    process.env['CODE_AGENT_SKIP_MEMORY_PREWARM'] = '1';
    const { scheduleMemoryPrewarm, PREWARM_DELAY_MS } = await loadModule();
    const service = fakeService();
    scheduleMemoryPrewarm({ service });
    await vi.advanceTimersByTimeAsync(PREWARM_DELAY_MS);
    expect(service.ensureStarted).not.toHaveBeenCalled();
  });

  it('测试环境（NODE_ENV=test）：不调度', async () => {
    process.env['NODE_ENV'] = 'test';
    const { scheduleMemoryPrewarm, PREWARM_DELAY_MS } = await loadModule();
    const service = fakeService();
    scheduleMemoryPrewarm({ service });
    await vi.advanceTimersByTimeAsync(PREWARM_DELAY_MS);
    expect(service.ensureStarted).not.toHaveBeenCalled();
  });

  it('启动失败：静默降级（warn 记录，不抛出）', async () => {
    const { scheduleMemoryPrewarm, PREWARM_DELAY_MS } = await loadModule();
    const service = fakeService({ reject: true });
    expect(() => scheduleMemoryPrewarm({ service })).not.toThrow();
    await vi.advanceTimersByTimeAsync(PREWARM_DELAY_MS);
    expect(service.ensureStarted).toHaveBeenCalledTimes(1);
    expect(mocks.warn).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.stringContaining('sidecar 就绪超时') }),
      '[memory-hub] 启动预热失败（记忆功能将在首次调用时重试）',
    );
  });
});
