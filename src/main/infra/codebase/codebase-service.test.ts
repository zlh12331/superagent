// src/main/infra/codebase/codebase-service.test.ts
// CodebaseService 单测：codegraph CLI 封装（正向/边界/异常三件套）
// ──────────────────────────────────────────────────────────────
// 测试策略（遵循"业务逻辑不 mock、外部依赖注入 fake"）：
// - spawnFn 经构造注入 fake（返回可编程 ChildProcess 模拟），不 mock 业务代码
// - timeoutMs 注入短值（50ms）验证超时路径（生产默认 60s）
// - args 断言验证 CLI 参数构造正确性（各方法的正/边界分支）
// ──────────────────────────────────────────────────────────────

import type { ChildProcess, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { AppError, ErrorCode } from '@code-agent/shared/main';
import { describe, expect, it, vi } from 'vitest';
import { CodebaseService } from './codebase-service';

/** 可编程 fake 子进程（模拟 spawn 返回值） */
interface FakeChildBehavior {
  readonly stdoutText?: string;
  readonly stderrText?: string;
  /** close 退出码；undefined = 永不 close（测超时） */
  readonly exitCode?: number;
  /** 触发 error 事件 */
  readonly spawnError?: Error;
  /** kill 抛错（dispose 容错用例） */
  readonly killThrows?: boolean;
}

function createFakeChild(behavior: FakeChildBehavior = {}): ChildProcess {
  const child = new EventEmitter() as unknown as ChildProcess & EventEmitter;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  child.stdout = stdout;
  child.stderr = stderr;
  child.kill = vi.fn(() => {
    if (behavior.killThrows === true) {
      throw new Error('kill 失败（模拟）');
    }
    return true;
  });

  // 微任务派发输出 + close（让 Promise 链先建立监听）
  queueMicrotask(() => {
    if (behavior.spawnError !== undefined) {
      child.emit('error', behavior.spawnError);
      return;
    }
    if (behavior.stdoutText !== undefined && behavior.stdoutText.length > 0) {
      stdout.write(behavior.stdoutText);
    }
    if (behavior.stderrText !== undefined && behavior.stderrText.length > 0) {
      stderr.write(behavior.stderrText);
    }
    if (behavior.exitCode !== undefined) {
      child.emit('close', behavior.exitCode);
    }
    // exitCode undefined：不 close（等待超时）
  });
  return child;
}

/** 创建被测服务（注入 fake spawn + 短超时） */
function createService(behavior: FakeChildBehavior = {}): {
  service: CodebaseService;
  spawnMock: ReturnType<typeof vi.fn> & typeof spawn;
} {
  const spawnMock = vi.fn(() => createFakeChild(behavior)) as unknown as ReturnType<typeof vi.fn> &
    typeof spawn;
  const service = new CodebaseService({
    spawnFn: spawnMock,
    timeoutMs: 50,
    // 平台包定位注入 fake：保持断言针对命令参数本身（真实 resolve 只在生产/真实调用路径生效）
    resolveBundle: () => ({ command: 'codegraph', args: [] }),
  });
  return { service, spawnMock };
}

/** 取最近一次 spawn 调用的 args */
function lastArgs(spawnMock: ReturnType<typeof vi.fn>): string[] {
  const call = spawnMock.mock.calls.at(-1);
  return (call?.[1] as string[]) ?? [];
}

const INTERNAL = ErrorCode.INTERNAL_ERROR;

describe('CodebaseService.query（结构化符号搜索）', () => {
  it('正向：合法 JSON 数组输出 → 解析返回 results', async () => {
    const { service, spawnMock } = createService({
      stdoutText: JSON.stringify([{ name: 'AgentService', file: 'a.ts', line: 1, score: 0.9 }]),
      exitCode: 0,
    });
    const res = await service.query({ path: '/repo', search: 'Agent', limit: 10, kind: undefined });
    expect(res.results).toHaveLength(1);
    expect(res.results[0]).toMatchObject({ name: 'AgentService', score: 0.9 });
    expect(lastArgs(spawnMock)).toEqual(['query', 'Agent', '-p', '/repo', '-l', '10', '-j']);
  });

  it('正向：kind 传入 → args 追加 -k', async () => {
    const { service, spawnMock } = createService({ stdoutText: '[]', exitCode: 0 });
    await service.query({ path: '/repo', search: 'x', limit: 5, kind: 'function' });
    expect(lastArgs(spawnMock)).toEqual([
      'query',
      'x',
      '-p',
      '/repo',
      '-l',
      '5',
      '-j',
      '-k',
      'function',
    ]);
  });

  it('边界：空 stdout → 返回空数组（兜底）', async () => {
    const { service } = createService({ stdoutText: '  \n  ', exitCode: 0 });
    const res = await service.query({ path: '/repo', search: 'x', limit: 5, kind: undefined });
    expect(res.results).toEqual([]);
  });

  it('边界：limit 边界值（0 与大数）正确入参', async () => {
    const { service, spawnMock } = createService({ stdoutText: '[]', exitCode: 0 });
    await service.query({ path: '/repo', search: 'x', limit: 0, kind: undefined });
    expect(lastArgs(spawnMock)).toContain('-l');
    expect(lastArgs(spawnMock)).toContain('0');
    await service.query({ path: '/repo', search: 'x', limit: 9999, kind: undefined });
    expect(lastArgs(spawnMock)).toContain('9999');
  });

  it('异常：非 JSON 输出 → INTERNAL_ERROR（含上下文截断）', async () => {
    const { service } = createService({ stdoutText: 'not-json', exitCode: 0 });
    await expect(
      service.query({ path: '/repo', search: 'x', limit: 5, kind: undefined }),
    ).rejects.toMatchObject({ code: INTERNAL });
  });

  it('异常：JSON 但非数组 → INTERNAL_ERROR', async () => {
    const { service } = createService({ stdoutText: '{"a":1}', exitCode: 0 });
    await expect(
      service.query({ path: '/repo', search: 'x', limit: 5, kind: undefined }),
    ).rejects.toMatchObject({ code: INTERNAL });
  });

  it('异常：spawn error → INTERNAL_ERROR（启动失败）', async () => {
    const { service } = createService({ spawnError: new Error('ENOENT') });
    await expect(
      service.query({ path: '/repo', search: 'x', limit: 5, kind: undefined }),
    ).rejects.toMatchObject({ code: INTERNAL });
  });

  it('异常：close code≠0 → INTERNAL_ERROR（含 stderr 上下文）', async () => {
    const { service } = createService({ stderrText: 'index not found', exitCode: 2 });
    await expect(
      service.query({ path: '/repo', search: 'x', limit: 5, kind: undefined }),
    ).rejects.toMatchObject({ code: INTERNAL });
  });

  it('异常：超时（50ms 无 close）→ INTERNAL_ERROR（超时消息）', async () => {
    const { service } = createService({ stdoutText: '' }); // exitCode undefined
    await expect(
      service.query({ path: '/repo', search: 'x', limit: 5, kind: undefined }),
    ).rejects.toMatchObject({ code: INTERNAL, message: expect.stringContaining('超时') });
  }, 5_000);
});

describe('CodebaseService.explore（区域探索）', () => {
  it('正向：多词查询展开为 variadic args + 返回 markdown', async () => {
    const { service, spawnMock } = createService({ stdoutText: '# 探索结果', exitCode: 0 });
    const res = await service.explore({
      path: '/repo',
      query: ['如何', '实现', '认证'],
      maxFiles: 3,
    });
    expect(res.markdown).toBe('# 探索结果');
    expect(lastArgs(spawnMock)).toEqual([
      'explore',
      '如何',
      '实现',
      '认证',
      '-p',
      '/repo',
      '--max-files',
      '3',
    ]);
  });

  it('边界：query 空数组 → args 仅基础参数', async () => {
    const { service, spawnMock } = createService({ stdoutText: '', exitCode: 0 });
    await service.explore({ path: '/repo', query: [], maxFiles: 3 });
    expect(lastArgs(spawnMock)).toEqual(['explore', '-p', '/repo', '--max-files', '3']);
  });

  it('边界：maxFiles=0 → 入参 0', async () => {
    const { service, spawnMock } = createService({ stdoutText: '', exitCode: 0 });
    await service.explore({ path: '/repo', query: ['x'], maxFiles: 0 });
    expect(lastArgs(spawnMock)).toContain('0');
  });

  it('异常：非零退出 → INTERNAL_ERROR', async () => {
    const { service } = createService({ exitCode: 1 });
    await expect(
      service.explore({ path: '/repo', query: ['x'], maxFiles: 3 }),
    ).rejects.toMatchObject({ code: INTERNAL });
  });
});

describe('CodebaseService.node（符号/文件双模式）', () => {
  it('正向：符号模式 → args 含 name', async () => {
    const { service, spawnMock } = createService({ stdoutText: 'src', exitCode: 0 });
    await service.node({
      path: '/repo',
      name: 'AgentService',
      file: undefined,
      offset: undefined,
      limit: undefined,
      symbolsOnly: undefined,
    });
    expect(lastArgs(spawnMock)).toEqual(['node', 'AgentService', '-p', '/repo']);
  });

  it('正向：文件模式 → args 含 -f', async () => {
    const { service, spawnMock } = createService({ stdoutText: 'file', exitCode: 0 });
    await service.node({
      path: '/repo',
      name: undefined,
      file: 'src/a.ts',
      offset: undefined,
      limit: undefined,
      symbolsOnly: undefined,
    });
    expect(lastArgs(spawnMock)).toEqual(['node', '-p', '/repo', '-f', 'src/a.ts']);
  });

  it('正向：offset/limit/symbolsOnly 全传 → 三个 flag 全追加', async () => {
    const { service, spawnMock } = createService({ stdoutText: '', exitCode: 0 });
    await service.node({
      path: '/repo',
      name: undefined,
      file: 'a.ts',
      offset: 10,
      limit: 50,
      symbolsOnly: true,
    });
    expect(lastArgs(spawnMock)).toEqual([
      'node',
      '-p',
      '/repo',
      '-f',
      'a.ts',
      '--offset',
      '10',
      '--limit',
      '50',
      '--symbols-only',
    ]);
  });

  it('边界：name 空串 → 不追加（等价于省略）', async () => {
    const { service, spawnMock } = createService({ stdoutText: '', exitCode: 0 });
    await service.node({
      path: '/repo',
      name: '',
      file: undefined,
      offset: undefined,
      limit: undefined,
      symbolsOnly: undefined,
    });
    expect(lastArgs(spawnMock)).toEqual(['node', '-p', '/repo']);
  });

  it('边界：file 空串 → 不追加', async () => {
    const { service, spawnMock } = createService({ stdoutText: '', exitCode: 0 });
    await service.node({
      path: '/repo',
      name: undefined,
      file: '',
      offset: undefined,
      limit: undefined,
      symbolsOnly: undefined,
    });
    expect(lastArgs(spawnMock)).toEqual(['node', '-p', '/repo']);
  });

  it('边界：symbolsOnly=false → 不追加 flag', async () => {
    const { service, spawnMock } = createService({ stdoutText: '', exitCode: 0 });
    await service.node({
      path: '/repo',
      name: undefined,
      file: 'a.ts',
      offset: undefined,
      limit: undefined,
      symbolsOnly: false,
    });
    expect(lastArgs(spawnMock)).not.toContain('--symbols-only');
  });

  it('边界：name 与 file 同时传 → 两者都追加', async () => {
    const { service, spawnMock } = createService({ stdoutText: '', exitCode: 0 });
    await service.node({
      path: '/repo',
      name: 'Foo',
      file: 'a.ts',
      offset: undefined,
      limit: undefined,
      symbolsOnly: undefined,
    });
    expect(lastArgs(spawnMock)).toEqual(['node', 'Foo', '-p', '/repo', '-f', 'a.ts']);
  });

  it('异常：非零退出 → INTERNAL_ERROR', async () => {
    const { service } = createService({ exitCode: 3 });
    await expect(
      service.node({
        path: '/repo',
        name: 'x',
        file: undefined,
        offset: undefined,
        limit: undefined,
        symbolsOnly: undefined,
      }),
    ).rejects.toMatchObject({ code: INTERNAL });
  });
});

describe('CodebaseService.callers/callees/impact', () => {
  it('正向：callers args 构造正确 + 返回 markdown', async () => {
    const { service, spawnMock } = createService({ stdoutText: 'callers', exitCode: 0 });
    const res = await service.callers({ path: '/repo', symbol: 'Foo', limit: 10 });
    expect(res.markdown).toBe('callers');
    expect(lastArgs(spawnMock)).toEqual(['callers', 'Foo', '-p', '/repo', '-l', '10']);
  });

  it('正向：callees args 构造正确', async () => {
    const { service, spawnMock } = createService({ stdoutText: '', exitCode: 0 });
    await service.callees({ path: '/repo', symbol: 'Foo', limit: 5 });
    expect(lastArgs(spawnMock)).toEqual(['callees', 'Foo', '-p', '/repo', '-l', '5']);
  });

  it('正向：impact args 构造正确（含 depth）', async () => {
    const { service, spawnMock } = createService({ stdoutText: '', exitCode: 0 });
    await service.impact({ path: '/repo', symbol: 'Foo', depth: 3 });
    expect(lastArgs(spawnMock)).toEqual(['impact', 'Foo', '-p', '/repo', '-d', '3']);
  });

  it('边界：limit=0 / depth=0 正确入参', async () => {
    const { service, spawnMock } = createService({ stdoutText: '', exitCode: 0 });
    await service.callers({ path: '/repo', symbol: 'Foo', limit: 0 });
    expect(lastArgs(spawnMock)).toContain('0');
    await service.impact({ path: '/repo', symbol: 'Foo', depth: 0 });
    expect(lastArgs(spawnMock)).toContain('0');
  });

  it('异常：三个方法 spawn error 均 → INTERNAL_ERROR', async () => {
    const { service } = createService({ spawnError: new Error('boom') });
    await expect(service.callers({ path: '/repo', symbol: 'x', limit: 5 })).rejects.toMatchObject({
      code: INTERNAL,
    });
    await expect(service.callees({ path: '/repo', symbol: 'x', limit: 5 })).rejects.toMatchObject({
      code: INTERNAL,
    });
    await expect(service.impact({ path: '/repo', symbol: 'x', depth: 2 })).rejects.toMatchObject({
      code: INTERNAL,
    });
  });
});

describe('CodebaseService.dispose（生命周期）', () => {
  it('正向：有残留进程 → 全部 kill + Set 清空', async () => {
    // 造一个永不 close 的进程（留在 activeProcesses）
    const { service, spawnMock } = createService({ stdoutText: '' });
    const pending = service
      .query({ path: '/repo', search: 'x', limit: 5, kind: undefined })
      .catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 10)); // 等 spawn 建立
    expect(spawnMock).toHaveBeenCalledTimes(1);

    await service.dispose();
    const child = spawnMock.mock.results[0]?.value as ChildProcess & {
      kill: ReturnType<typeof vi.fn>;
    };
    // 2026-09-08：dispose 改为 terminateChild（无参 kill = SIGTERM，3s 后升级 SIGKILL）
    expect(child.kill).toHaveBeenCalledWith();
    await pending; // 超时 reject 已被吞
  }, 5_000);

  it('边界：空 Set → no-op 不抛', async () => {
    const { service } = createService();
    await expect(service.dispose()).resolves.toBeUndefined();
  });

  it('边界：重复调用幂等', async () => {
    const { service, spawnMock } = createService({ stdoutText: '' });
    const pending = service
      .query({ path: '/repo', search: 'x', limit: 5, kind: undefined })
      .catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 10));
    await service.dispose();
    await service.dispose(); // 第二次：Set 已空
    expect(spawnMock).toHaveBeenCalledTimes(1);
    await pending;
  }, 5_000);

  it('异常：kill 抛错 → 不向上抛（容错）', async () => {
    const { service } = createService({ stdoutText: '', killThrows: true });
    const pending = service
      .query({ path: '/repo', search: 'x', limit: 5, kind: undefined })
      .catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 10));
    await expect(service.dispose()).resolves.toBeUndefined(); // kill 抛错被吞
    await pending;
  }, 5_000);
});

describe('CodebaseService 错误类型细化', () => {
  it('query 失败与超时均为 AppError 实例（可被上层分类）', async () => {
    const { service } = createService({ exitCode: 1 });
    try {
      await service.query({ path: '/repo', search: 'x', limit: 5, kind: undefined });
      expect.unreachable('应抛错');
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe(INTERNAL);
    }
  });
});
