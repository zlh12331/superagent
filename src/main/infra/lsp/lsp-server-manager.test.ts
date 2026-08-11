// src/main/infra/lsp/lsp-server-manager.test.ts
// LspServerManager 单测：LSP 服务器懒加载/复用/并发安全（正向/边界/异常三件套）
// ──────────────────────────────────────────────────────────────
// 测试策略（遵循"业务逻辑不 mock、外部依赖注入 fake"）：
// - lspClientCtor 经构造注入 fake（共享实例桩，保持 new 语义）
// - 懒加载缓存/并发去重/释放幂等全部真实实现
// ──────────────────────────────────────────────────────────────

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LspClient } from './lsp-client';
import { LspServerManager } from './lsp-server-manager';

/** fake LspClient：initialize/dispose 可编程 */
class FakeLspClient {
  readonly rootUri: string;
  readonly initialize = vi.fn(async () => {});
  readonly dispose = vi.fn(async () => {});
  readonly options: { command: string; args: readonly string[]; timeoutMs: number };

  constructor(options: {
    command: string;
    args: readonly string[];
    rootUri: string;
    timeoutMs: number;
  }) {
    this.rootUri = options.rootUri;
    this.options = options;
    FakeLspClient.instances.push(this);
  }

  static instances: FakeLspClient[] = [];
}

/** 构造桩：new 返回共享实例（每个 rootUri 一个） */
class SharedlspClientCtor {
  constructor(options: {
    command: string;
    args: readonly string[];
    rootUri: string;
    timeoutMs: number;
  }) {
    const existing = FakeLspClient.instances.find((c) => c.rootUri === options.rootUri);
    // biome-ignore lint/correctness/noConstructorReturn: 测试桩返回共享实例（保持 new 语义）
    return existing ?? new FakeLspClient(options);
  }
}

function makeManager(
  options: { command?: string; args?: readonly string[]; timeoutMs?: number } = {},
): LspServerManager {
  FakeLspClient.instances = [];
  return new LspServerManager({
    ...options,
    lspClientCtor: SharedlspClientCtor as unknown as typeof LspClient,
  });
}

describe('LspServerManager.getClient（三件套）', () => {
  beforeEach(() => {
    FakeLspClient.instances = [];
  });

  it('正向：首次获取 → 懒启动 + initialize + 缓存（第二次复用同一实例）', async () => {
    const manager = makeManager();
    const first = await manager.getClient('file:///repo');
    const second = await manager.getClient('file:///repo');
    expect(first).toBe(second); // 复用
    expect(FakeLspClient.instances).toHaveLength(1); // 只启动一次
    expect(FakeLspClient.instances[0]?.initialize).toHaveBeenCalledTimes(1);
  });

  it('正向：并发 getClient 共享同一初始化 Promise（防重复握手）', async () => {
    let resolveInit: (() => void) | undefined;
    // 慢初始化：验证并发共享
    FakeLspClient.instances = [];
    const slowClient = new FakeLspClient({
      command: 'c',
      args: [],
      rootUri: 'file:///repo',
      timeoutMs: 1,
    });
    slowClient.initialize.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveInit = resolve;
        }),
    );
    FakeLspClient.instances = [slowClient];
    // 重新构造 manager 使用 slowClient（类构造桩返回共享实例）
    const manager2 = new LspServerManager({
      lspClientCtor: class {
        constructor() {
          // biome-ignore lint/correctness/noConstructorReturn: 测试桩返回共享实例（保持 new 语义）
          return slowClient;
        }
      } as unknown as typeof LspClient,
    });
    const p1 = manager2.getClient('file:///repo');
    const p2 = manager2.getClient('file:///repo');
    // 两个调用共享 pending promise：只有 1 次构造
    expect(FakeLspClient.instances).toHaveLength(1);
    resolveInit?.();
    const [c1, c2] = await Promise.all([p1, p2]);
    expect(c1).toBe(c2);
  });

  it('边界：不同 rootUri → 各自独立的客户端', async () => {
    const manager = makeManager();
    const a = await manager.getClient('file:///a');
    const b = await manager.getClient('file:///b');
    expect(a).not.toBe(b);
    expect(FakeLspClient.instances).toHaveLength(2);
  });

  it('边界：自定义配置透传（command/args/timeoutMs）', async () => {
    const manager = makeManager({ command: 'my-lsp', args: ['--port', '8080'], timeoutMs: 500 });
    await manager.getClient('file:///repo');
    expect(FakeLspClient.instances[0]?.options).toEqual({
      command: 'my-lsp',
      args: ['--port', '8080'],
      rootUri: 'file:///repo',
      timeoutMs: 500,
    });
  });

  it('异常：initialize 失败 → 抛错 + 半开资源释放 + 不缓存', async () => {
    const badClient = new FakeLspClient({
      command: 'c',
      args: [],
      rootUri: 'file:///repo',
      timeoutMs: 1,
    });
    badClient.initialize.mockRejectedValue(new Error('lsp boot failed'));
    const manager2 = new LspServerManager({
      lspClientCtor: class {
        constructor() {
          // biome-ignore lint/correctness/noConstructorReturn: 测试桩返回共享实例（保持 new 语义）
          return badClient;
        }
      } as unknown as typeof LspClient,
    });
    await expect(manager2.getClient('file:///repo')).rejects.toThrow('lsp boot failed');
    expect(badClient.dispose).toHaveBeenCalled(); // 半开资源清理
    // 不缓存：下次调用重新启动
    await expect(manager2.getClient('file:///repo')).rejects.toThrow('lsp boot failed');
    expect(badClient.initialize).toHaveBeenCalledTimes(2);
  });

  it('异常：disposed 后 getClient → 抛错', async () => {
    const manager = makeManager();
    await manager.disposeAll();
    await expect(manager.getClient('file:///repo')).rejects.toThrow('已释放');
  });
});

describe('LspServerManager.disposeAll', () => {
  beforeEach(() => {
    FakeLspClient.instances = [];
  });

  it('正向：全部释放 + 幂等（重复调用 no-op）', async () => {
    const manager = makeManager();
    await manager.getClient('file:///a');
    await manager.getClient('file:///b');
    await manager.disposeAll();
    expect(FakeLspClient.instances[0]?.dispose).toHaveBeenCalled();
    expect(FakeLspClient.instances[1]?.dispose).toHaveBeenCalled();
    await expect(manager.disposeAll()).resolves.toBeUndefined(); // 幂等
  });

  it('异常：dispose 抛错 → 不阻断其余客户端释放', async () => {
    const manager = makeManager();
    await manager.getClient('file:///a');
    await manager.getClient('file:///b');
    FakeLspClient.instances[0]?.dispose.mockRejectedValueOnce(new Error('dispose failed'));
    await expect(manager.disposeAll()).resolves.toBeUndefined();
    expect(FakeLspClient.instances[1]?.dispose).toHaveBeenCalled();
  });

  it('边界：无客户端时 disposeAll → no-op 不抛', async () => {
    const manager = makeManager();
    await expect(manager.disposeAll()).resolves.toBeUndefined();
  });
});
