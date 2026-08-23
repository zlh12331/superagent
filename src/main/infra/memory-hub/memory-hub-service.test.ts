// src/main/infra/memory-hub/memory-hub-service.test.ts
// MemoryHubService 单测：配置判定 / 未配置降级 / 生命周期幂等
// ──────────────────────────────────────────────────────────────
// 说明：真实 sidecar 拉起（spawn + /health）由 memory-hub.contract.test.ts 覆盖
// （需 MEMORY_HUB_ROOT，CI 自动跳过）。本文件覆盖无需子进程的纯逻辑与降级语义。
// ──────────────────────────────────────────────────────────────

import { describe, expect, it, vi } from 'vitest';

import { createDeferredMemoryPort, MemoryHubService } from './memory-hub-service';
import type { MemoryPort } from './types';

describe('MemoryHubService 配置判定', () => {
  it('hubRoot 未配置 → isConfigured=false', () => {
    const service = new MemoryHubService({ hubRoot: undefined, dataDir: '/tmp/m' });
    expect(service.isConfigured()).toBe(false);
  });

  it('hubRoot 空串 → isConfigured=false', () => {
    const service = new MemoryHubService({ hubRoot: '', dataDir: '/tmp/m' });
    expect(service.isConfigured()).toBe(false);
  });

  it('hubRoot 配置 → isConfigured=true', () => {
    const service = new MemoryHubService({ hubRoot: '/opt/memory-hub', dataDir: '/tmp/m' });
    expect(service.isConfigured()).toBe(true);
  });
});

describe('MemoryHubService 未配置降级（空实现）', () => {
  function createUnconfigured(): MemoryHubService {
    return new MemoryHubService({ hubRoot: undefined, dataDir: '/tmp/memory-hub-none' });
  }

  it('ensureStarted 返回空实现端口（不 spawn 不抛错）', async () => {
    const port = await createUnconfigured().ensureStarted();
    await expect(port.health()).resolves.toBe(false);
  });

  it('空实现 capture → {0,false}', async () => {
    const port = await createUnconfigured().ensureStarted();
    await expect(
      port.capture({ sessionKey: 's', userContent: 'u', assistantContent: 'a' }),
    ).resolves.toEqual({ l0Recorded: 0, schedulerNotified: false });
  });

  it('空实现 recall → ok=false + not configured 提示', async () => {
    const port = await createUnconfigured().ensureStarted();
    const result = await port.recall({ query: 'q' });
    expect(result.ok).toBe(false);
    expect(result.context).toBe('');
    expect(result.message).toContain('not configured');
  });

  it('空实现 searchMemories / searchConversations → 空结果', async () => {
    const port = await createUnconfigured().ensureStarted();
    await expect(port.searchMemories('q')).resolves.toEqual({ content: '', total: 0 });
    await expect(port.searchConversations('q')).resolves.toEqual({ content: '', total: 0 });
  });
});

describe('MemoryHubService 生命周期', () => {
  it('未启动时 stop() 幂等（不抛错）', async () => {
    const service = new MemoryHubService({ hubRoot: undefined, dataDir: '/tmp/m' });
    await expect(service.stop()).resolves.toBeUndefined();
    await expect(service.stop()).resolves.toBeUndefined();
  });

  it('ensureStarted 幂等：并发调用合并为同一端口实例', async () => {
    const service = new MemoryHubService({ hubRoot: undefined, dataDir: '/tmp/m' });
    const [a, b] = await Promise.all([service.ensureStarted(), service.ensureStarted()]);
    expect(a).toBe(b);
  });
});

describe('createDeferredMemoryPort', () => {
  const fakePort: MemoryPort = {
    health: vi.fn(async () => true),
    capture: vi.fn(async () => ({ l0Recorded: 1, schedulerNotified: true })),
    recall: vi.fn(async () => ({ ok: true, context: 'c', memoryCount: 1 })),
    searchMemories: vi.fn(async () => ({ content: 'c', total: 1 })),
    searchConversations: vi.fn(async () => ({ content: 'c', total: 1 })),
  };

  function createDeferred() {
    const ensureStarted = vi.fn(async () => fakePort);
    const service = { ensureStarted } as unknown as MemoryHubService;
    return { deferred: createDeferredMemoryPort(() => service), ensureStarted };
  }

  it('懒启动：创建时不触发 ensureStarted', () => {
    const { ensureStarted } = createDeferred();
    expect(ensureStarted).not.toHaveBeenCalled();
  });

  it('各方法调用时委托给 ensureStarted 返回的端口', async () => {
    const { deferred, ensureStarted } = createDeferred();
    await expect(deferred.health()).resolves.toBe(true);
    await expect(
      deferred.capture({ sessionKey: 's', userContent: 'u', assistantContent: 'a' }),
    ).resolves.toEqual({ l0Recorded: 1, schedulerNotified: true });
    await expect(deferred.recall({ query: 'q' })).resolves.toEqual({
      ok: true,
      context: 'c',
      memoryCount: 1,
    });
    await expect(deferred.searchMemories('q', 5)).resolves.toEqual({ content: 'c', total: 1 });
    await expect(deferred.searchConversations('q', 5)).resolves.toEqual({
      content: 'c',
      total: 1,
    });
    expect(ensureStarted).toHaveBeenCalledTimes(5);
  });
});
