// src/main/infra/memory-hub/memory-hub-service.test.ts
// MemoryHubService 单测：配置判定 / 未配置降级 / 生命周期幂等
// ──────────────────────────────────────────────────────────────
// 说明：真实 sidecar 拉起（spawn + /health）由 memory-hub.contract.test.ts 覆盖
// （需 MEMORY_HUB_ROOT，CI 自动跳过）。本文件覆盖无需子进程的纯逻辑与降级语义。
// ──────────────────────────────────────────────────────────────

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

describe('MemoryHubService.listL0BySession', () => {
  /** 构造含 conversations JSONL 的临时数据目录 */
  function createDataDir(linesByFile: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), 'memory-hub-l0-'));
    const convDir = join(root, 'data', 'conversations');
    mkdirSync(convDir, { recursive: true });
    for (const [file, content] of Object.entries(linesByFile)) {
      writeFileSync(join(convDir, file), content, 'utf8');
    }
    return root;
  }

  function createService(dataDir: string): MemoryHubService {
    return new MemoryHubService({ hubRoot: undefined, dataDir });
  }

  it('按会话过滤 + 按时间升序 + 取最近 limit 条', async () => {
    const dir = createDataDir({
      '2026-08-24.jsonl': [
        JSON.stringify({ sessionKey: 'sess-1', role: 'user', content: '第一条', timestamp: 100 }),
        JSON.stringify({ sessionKey: 'sess-2', role: 'user', content: '别人的', timestamp: 150 }),
        JSON.stringify({
          sessionKey: 'sess-1',
          role: 'assistant',
          content: '第二条',
          timestamp: 200,
        }),
      ].join('\n'),
    });
    const service = createService(dir);
    const records = await service.listL0BySession('sess-1', 20);
    expect(records.map((r) => r.content)).toEqual(['第一条', '第二条']);
  });

  it('跨多天文件合并（sessionKey 命中即纳入）', async () => {
    const dir = createDataDir({
      '2026-08-23.jsonl': JSON.stringify({
        sessionKey: 'sess-1',
        role: 'user',
        content: '昨天',
        timestamp: 1,
      }),
      '2026-08-24.jsonl': JSON.stringify({
        sessionKey: 'sess-1',
        role: 'user',
        content: '今天',
        timestamp: 2,
      }),
    });
    const service = createService(dir);
    const records = await service.listL0BySession('sess-1');
    expect(records.map((r) => r.content)).toEqual(['昨天', '今天']);
  });

  it('limit 截断：只返回最近 limit 条', async () => {
    const lines = [1, 2, 3].map((n) =>
      JSON.stringify({ sessionKey: 'sess-1', role: 'user', content: `m${n}`, timestamp: n }),
    );
    const dir = createDataDir({ '2026-08-24.jsonl': lines.join('\n') });
    const service = createService(dir);
    const records = await service.listL0BySession('sess-1', 2);
    expect(records.map((r) => r.content)).toEqual(['m2', 'm3']);
  });

  it('损坏行跳过 + 非 jsonl 忽略 + 目录不存在返回空', async () => {
    const dir = createDataDir({
      '2026-08-24.jsonl': [
        '{"sessionKey":"sess-1","role":"user","content":"ok","timestamp":1}',
        'not-json{broken',
      ].join('\n'),
      'readme.txt': 'ignore me',
    });
    const service = createService(dir);
    const records = await service.listL0BySession('sess-1');
    expect(records.map((r) => r.content)).toEqual(['ok']);

    const empty = createService(join(tmpdir(), 'memory-hub-no-such-dir'));
    await expect(empty.listL0BySession('sess-1')).resolves.toEqual([]);
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
