// src/main/infra/memory-hub/memory-hub-service.test.ts
// MemoryHubService 单测：配置判定 / 未配置降级 / 生命周期幂等
// ──────────────────────────────────────────────────────────────
// 说明：真实 sidecar 拉起（spawn + /health）由 memory-hub.contract.test.ts 覆盖
// （需 MEMORY_HUB_ROOT，CI 自动跳过）。本文件覆盖无需子进程的纯逻辑与降级语义。
// ──────────────────────────────────────────────────────────────

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { broadcastInvalidation } from '../invalidation/invalidation';
import { createDeferredMemoryPort, MemoryHubService } from './memory-hub-service';
import type { MemoryPort } from './types';

// 失效域广播替身（基础设施边界，规范允许 vi.mock；S8 断言用，见文件尾 describe）
vi.mock('../invalidation/invalidation', () => ({ broadcastInvalidation: vi.fn() }));

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

describe('MemoryHubService 无引擎产物降级（hubRoot 存在但入口缺失）', () => {
  /** 模拟打包期未捆绑记忆引擎：hubRoot 目录存在，但里面没有上游入口 */
  function createHubless(): MemoryHubService {
    const dir = mkdtempSync(join(tmpdir(), 'memory-hub-hubless-'));
    mkdirSync(join(dir, 'node_modules'), { recursive: true });
    return new MemoryHubService({ hubRoot: dir, dataDir: join(dir, 'data') });
  }

  it('ensureStarted 不抛错，返回空实现端口', async () => {
    const port = await createHubless().ensureStarted();
    await expect(port.health()).resolves.toBe(false);
    await expect(
      port.capture({ sessionKey: 's', userContent: 'u', assistantContent: 'a' }),
    ).resolves.toEqual({ l0Recorded: 0, schedulerNotified: false });
  });

  it('降级端口被缓存（后续调用复用同一实例，不重复启动/报错）', async () => {
    const service = createHubless();
    const first = await service.ensureStarted();
    const second = await service.ensureStarted();
    expect(second).toBe(first);
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

describe('MemoryHubService.removeL0JsonlBySession', () => {
  function createDataDir(linesByFile: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), 'memory-hub-clear-'));
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

  it('仅移除目标会话行，保留其他会话与损坏行（原子重写）', async () => {
    const dir = createDataDir({
      '2026-08-24.jsonl': [
        JSON.stringify({ sessionKey: 'sess-1', role: 'user', content: '要删', timestamp: 1 }),
        JSON.stringify({ sessionKey: 'sess-2', role: 'user', content: '保留', timestamp: 2 }),
        'not-json{broken',
      ].join('\n'),
    });
    const service = createService(dir);
    const removed = await service.removeL0JsonlBySession('sess-1');
    expect(removed).toBe(1);

    // 其余数据完好（其他会话 + 损坏行不误伤）
    const remaining = readFileSync(`${dir}/data/conversations/2026-08-24.jsonl`, 'utf8')
      .split(/\r?\n/)
      .filter((l) => l.trim().length > 0);
    expect(remaining).toHaveLength(2);
    expect(remaining.join('\n')).toContain('sess-2');
    expect(remaining.join('\n')).toContain('not-json{broken');
  });

  it('跨多文件清理（sessionKey 或 session_id 命中即删）', async () => {
    const dir = createDataDir({
      '2026-08-23.jsonl': JSON.stringify({ sessionKey: 'sess-1', content: '昨天' }),
      // biome-ignore lint/style/useNamingConvention: 模拟上游 JSONL 镜像字段（snake_case）
      '2026-08-24.jsonl': JSON.stringify({ session_id: 'sess-1', content: '旧格式' }),
    });
    const service = createService(dir);
    const removed = await service.removeL0JsonlBySession('sess-1');
    expect(removed).toBe(2);
  });

  it('空 sessionKey / 目录不存在 → 0（不抛错）', async () => {
    const dir = createDataDir({ '2026-08-24.jsonl': 'x\n' });
    const service = createService(dir);
    await expect(service.removeL0JsonlBySession('   ')).resolves.toBe(0);
    const empty = createService(join(tmpdir(), 'memory-hub-no-such-clear'));
    await expect(empty.removeL0JsonlBySession('sess-1')).resolves.toBe(0);
  });

  it('批量移除：多个 key 单遍扫描一次完成（P2-26），移除行为与逐 key 一致', async () => {
    const dir = createDataDir({
      '2026-08-24.jsonl': [
        JSON.stringify({ sessionKey: 'sess-1', content: '删我', timestamp: 1 }),
        JSON.stringify({ sessionKey: 'sess-2', content: '也删', timestamp: 2 }),
        JSON.stringify({ sessionKey: 'sess-3', content: '保留', timestamp: 3 }),
        'not-json{broken',
      ].join('\n'),
    });
    const service = createService(dir);
    // 逐 key 两次调用 = 两次全扫；批量一次完成且移除行数相同
    const batchRemoved = await service.removeL0JsonlBySessions(['sess-1', 'sess-2']);
    expect(batchRemoved).toBe(2);
    const remaining = readFileSync(`${dir}/data/conversations/2026-08-24.jsonl`, 'utf8')
      .split(/\r?\n/)
      .filter((l) => l.trim().length > 0);
    expect(remaining).toHaveLength(2);
    expect(remaining.join('\n')).toContain('sess-3');
    expect(remaining.join('\n')).toContain('not-json{broken');
  });
});

describe('createDeferredMemoryPort', () => {
  const fakePort: MemoryPort = {
    health: vi.fn(async () => true),
    capture: vi.fn(async () => ({ l0Recorded: 1, schedulerNotified: true })),
    recall: vi.fn(async () => ({ ok: true, context: 'c', memoryCount: 1 })),
    searchMemories: vi.fn(async () => ({ content: 'c', total: 1 })),
    searchConversations: vi.fn(async () => ({ content: 'c', total: 1 })),
    clear: vi.fn(async () => ({ ok: true, deletedCount: 2 })),
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

// ── 失效域声明（31 号 spec S8：memory 运行态变化） ──────────────────

describe('MemoryHubService 失效域声明（S8）', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.mocked(broadcastInvalidation).mockClear();
  });

  /** EngineProcessHandle 的 fake 形状（kill 触发 exit 监听，模拟真实进程） */
  interface FakeHandle {
    pid: number | undefined;
    hasExited: () => boolean;
    stderrTail: () => string;
    onExit: (listener: (code: number) => void) => void;
    kill: () => void;
  }

  /** fake launcher：可编程的 EngineProcessHandle */
  function createLaunchFake(): { launcher: () => FakeHandle; crash: (code?: number) => void } {
    const exitListeners: Array<(code: number) => void> = [];
    let exited = false;
    const launcher = (): FakeHandle => ({
      pid: 4242,
      hasExited: () => exited,
      stderrTail: () => '',
      onExit: (listener: (code: number) => void) => {
        exitListeners.push(listener);
      },
      kill: () => {
        exited = true;
        for (const listener of exitListeners) {
          listener(0);
        }
      },
    });
    return {
      launcher,
      crash: (code = 1) => {
        exited = true;
        for (const listener of exitListeners) {
          listener(code);
        }
      },
    };
  }

  /** 造一个「有上游入口」的 hubRoot（fake launcher + stub fetch，不真拉子进程） */
  function createStartedService(launcher: () => FakeHandle): MemoryHubService {
    const dir = mkdtempSync(join(tmpdir(), 'memory-hub-invalidation-'));
    mkdirSync(join(dir, 'src', 'gateway'), { recursive: true });
    writeFileSync(join(dir, 'src', 'gateway', 'server.ts'), 'export class TdaiGateway {}');
    return new MemoryHubService({
      hubRoot: dir,
      dataDir: join(dir, 'data'),
      llm: { baseUrl: 'http://llm.test', apiKey: 'k', model: 'm' },
      launcher: launcher as never,
    });
  }

  it('sidecar 就绪 → 广播 memory（懒启动运行态缺口锚）', async () => {
    const fake = createLaunchFake();
    // /health 探测替身：立即就绪（真实 fetch 由 contract test 覆盖）
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => ({ status: 'ok' }) })),
    );
    const service = createStartedService(fake.launcher as never);

    await service.ensureStarted();

    expect(broadcastInvalidation).toHaveBeenCalledTimes(1);
    expect(broadcastInvalidation).toHaveBeenCalledWith(['memory']);
  });

  it('sidecar 异常退出 → 广播 memory（running→false）', async () => {
    const fake = createLaunchFake();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => ({ status: 'ok' }) })),
    );
    const service = createStartedService(fake.launcher as never);
    await service.ensureStarted();
    vi.mocked(broadcastInvalidation).mockClear();

    fake.crash(1);

    expect(broadcastInvalidation).toHaveBeenCalledTimes(1);
    expect(broadcastInvalidation).toHaveBeenCalledWith(['memory']);
  });

  it('stop 收尾 → 广播 memory（含 kill 触发的 exit 路径）', async () => {
    const fake = createLaunchFake();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => ({ status: 'ok' }) })),
    );
    const service = createStartedService(fake.launcher as never);
    await service.ensureStarted();
    vi.mocked(broadcastInvalidation).mockClear();

    await service.stop();

    // exit 回调广播 + stop 尾部广播（真实进程语义下两处都发生）
    expect(broadcastInvalidation).toHaveBeenCalledWith(['memory']);
  });

  it('未配置降级路径不广播（状态未迁移）', async () => {
    const service = new MemoryHubService({ hubRoot: undefined, dataDir: '/tmp/m' });

    await service.ensureStarted();

    expect(broadcastInvalidation).not.toHaveBeenCalled();
  });
});
