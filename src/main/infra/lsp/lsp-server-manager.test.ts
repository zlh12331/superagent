import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LspClient } from './lsp-client';
import { LspServerManager } from './lsp-server-manager';

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
  options: {
    serverOverrides?: Record<string, { command: string; args: readonly string[] }>;
    timeoutMs?: number;
  } = {},
): LspServerManager {
  FakeLspClient.instances = [];
  return new LspServerManager({
    ...(options.serverOverrides !== undefined ? { serverOverrides: options.serverOverrides } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    lspClientCtor: SharedlspClientCtor as unknown as typeof LspClient,
  });
}

describe('LspServerManager.getClient（三件套）', () => {
  beforeEach(() => {
    FakeLspClient.instances = [];
  });

  it('正向：首次获取 → 懒启动 + initialize + 缓存（第二次复用同一实例）', async () => {
    const manager = makeManager();
    const first = await manager.getClient('file:///repo', '/repo/src/main.ts');
    const second = await manager.getClient('file:///repo', '/repo/src/other.ts');
    expect(first).toBe(second);
    expect(FakeLspClient.instances).toHaveLength(1);
    expect(FakeLspClient.instances[0]?.initialize).toHaveBeenCalledTimes(1);
    expect(FakeLspClient.instances[0]?.options.command).toBe('typescript-language-server');
  });

  it('正向：并发 getClient 共享同一初始化 Promise（防重复握手）', async () => {
    let resolveInit: (() => void) | undefined;
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
    const manager2 = new LspServerManager({
      lspClientCtor: class {
        constructor() {
          // biome-ignore lint/correctness/noConstructorReturn: 测试桩返回共享实例（保持 new 语义）
          return slowClient;
        }
      } as unknown as typeof LspClient,
    });
    const p1 = manager2.getClient('file:///repo', '/repo/a.py');
    const p2 = manager2.getClient('file:///repo', '/repo/b.py');
    expect(FakeLspClient.instances).toHaveLength(1);
    resolveInit?.();
    const [c1, c2] = await Promise.all([p1, p2]);
    expect(c1).toBe(c2);
  });

  it('边界：不同 rootUri → 各自独立的客户端', async () => {
    const manager = makeManager();
    const a = await manager.getClient('file:///a', '/a/x.go');
    const b = await manager.getClient('file:///b', '/b/y.rs');
    expect(a).not.toBe(b);
    expect(FakeLspClient.instances).toHaveLength(2);
  });

  it('边界：同根不同语言 → 各自独立客户端（按语言路由）', async () => {
    FakeLspClient.instances = [];
    const manager = new LspServerManager({
      lspClientCtor: FakeLspClient as unknown as typeof LspClient,
    });
    const ts = await manager.getClient('file:///repo', '/repo/a.ts');
    const py = await manager.getClient('file:///repo', '/repo/b.py');
    expect(ts).not.toBe(py);
    expect(FakeLpCommand(0)).toBe('typescript-language-server');
    expect(FakeLpCommand(1)).toBe('pyright-langserver');
  });

  it('边界：用户覆盖透传（结构化 override → 启动规格）', async () => {
    const manager = makeManager({
      serverOverrides: { typescript: { command: 'my-lsp', args: ['--port', '8080'] } },
      timeoutMs: 500,
    });
    await manager.getClient('file:///repo', '/repo/src/main.ts');
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
    await expect(manager2.getClient('file:///repo', '/repo/a.ts')).rejects.toThrow(
      'lsp boot failed',
    );
    expect(badClient.dispose).toHaveBeenCalled();
    await expect(manager2.getClient('file:///repo', '/repo/a.ts')).rejects.toThrow(
      'lsp boot failed',
    );
    expect(badClient.initialize).toHaveBeenCalledTimes(2);
  });

  it('异常：disposed 后 getClient → 抛错', async () => {
    const manager = makeManager();
    await manager.disposeAll();
    await expect(manager.getClient('file:///repo', '/repo/a.ts')).rejects.toThrow('已释放');
  });

  it('异常：未收录文件类型 → 明确错误（不启动服务器）', async () => {
    const manager = makeManager();
    await expect(manager.getClient('file:///repo', '/repo/README.md')).rejects.toThrow(
      /不支持的文件类型/,
    );
    await expect(manager.getClient('file:///repo', '/repo/noext')).rejects.toThrow(
      /不支持的文件类型/,
    );
    expect(FakeLspClient.instances).toHaveLength(0);
  });
});

describe('LspServerManager.disposeAll', () => {
  beforeEach(() => {
    FakeLspClient.instances = [];
  });

  it('正向：全部释放 + 幂等（重复调用 no-op）', async () => {
    const manager = makeManager();
    await manager.getClient('file:///a', '/a/x.ts');
    await manager.getClient('file:///b', '/b/y.ts');
    await manager.disposeAll();
    expect(FakeLspClient.instances[0]?.dispose).toHaveBeenCalled();
    expect(FakeLspClient.instances[1]?.dispose).toHaveBeenCalled();
    await expect(manager.disposeAll()).resolves.toBeUndefined();
  });

  it('异常：dispose 抛错 → 不阻断其余客户端释放', async () => {
    const manager = makeManager();
    await manager.getClient('file:///a', '/a/x.ts');
    await manager.getClient('file:///b', '/b/y.ts');
    FakeLspClient.instances[0]?.dispose.mockRejectedValueOnce(new Error('dispose failed'));
    await expect(manager.disposeAll()).resolves.toBeUndefined();
    expect(FakeLspClient.instances[1]?.dispose).toHaveBeenCalled();
  });

  it('边界：无客户端时 disposeAll → no-op 不抛', async () => {
    const manager = makeManager();
    await expect(manager.disposeAll()).resolves.toBeUndefined();
  });
});

function FakeLpCommand(index: number): string {
  return FakeLspClient.instances[index]?.options.command ?? '';
}
