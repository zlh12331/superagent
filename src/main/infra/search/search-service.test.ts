// src/main/infra/search/search-service.test.ts
// SearchService 单测：ripgrep 内容搜索与文件查找（正向/边界/异常三件套）
// ──────────────────────────────────────────────────────────────
// 测试策略（遵循"业务逻辑不 mock、外部依赖注入 fake"）：
// - spawnFn 经构造注入 fake（可编程 FakeChild + PassThrough stdout）
// - 真实 JSON Lines 序列驱动 match/context 解析与组装逻辑
// - 错误分类路径全枚举：exit 0/1 正常、2 参数错误、其他 INTERNAL、信号终止
// ──────────────────────────────────────────────────────────────

import type { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { ErrorCode } from '@code-agent/shared/main';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type GlobOptions,
  type GrepOptions,
  getSearchService,
  resetSearchService,
  SearchService,
} from './search-service';

/**
 * 可编程子进程模拟：EventEmitter + PassThrough stdout + kill spy。
 * close/fail/stdoutFail 手动触发对应事件模拟 ripgrep 生命周期。
 */
class FakeChild extends EventEmitter {
  readonly stdout: PassThrough | null;
  readonly kill = vi.fn();

  constructor(stdout: PassThrough | null = new PassThrough()) {
    super();
    this.stdout = stdout;
  }

  /** 触发 close(code, signal) */
  close(code: number | null, signal: string | null = null): void {
    this.emit('close', code, signal);
  }

  /** 触发 spawn error */
  fail(err: Error): void {
    this.emit('error', err);
  }

  /** 触发 stdout 流 error */
  stdoutFail(err: Error): void {
    if (this.stdout !== null) {
      this.stdout.emit('error', err);
    }
  }
}

/** 构造注入 fake spawnFn 的服务 + 捕获的子进程实例 */
function makeService(): {
  svc: SearchService;
  spawnFn: ReturnType<typeof vi.fn>;
  children: FakeChild[];
} {
  const children: FakeChild[] = [];
  const spawnFn = vi.fn(() => {
    const child = new FakeChild();
    children.push(child);
    return child;
  });
  const svc = new SearchService({ spawnFn: spawnFn as unknown as typeof spawn });
  return { svc, spawnFn, children };
}

/** 写入 JSON 行并正常退出（等流处理后触发 close） */
async function emitLines(child: FakeChild, lines: readonly string[], code = 0): Promise<void> {
  if (child.stdout === null) throw new Error('stdout is null');
  for (const line of lines) {
    child.stdout.write(`${line}\n`);
  }
  // 等待 createInterface 处理完缓冲数据（流事件是异步的）
  await new Promise((resolve) => setImmediate(resolve));
  child.close(code);
}

/** grep 入参构造器 */
function grepOptions(overrides: Partial<GrepOptions> = {}): GrepOptions {
  return {
    pattern: 'foo',
    paths: ['C:\\work'],
    caseSensitive: false,
    isRegex: true,
    include: undefined,
    exclude: [],
    maxResults: 100,
    ...overrides,
  };
}

/** glob 入参构造器 */
function globOptions(overrides: Partial<GlobOptions> = {}): GlobOptions {
  return {
    pattern: '**/*.ts',
    path: 'C:\\work',
    includeHidden: false,
    maxResults: 100,
    ...overrides,
  };
}

/** 构造一条 ripgrep match JSON 行 */
function matchLine(file: string, line: number, text: string, column = 0): string {
  return JSON.stringify({
    type: 'match',
    data: {
      path: { text: file },
      line_number: line,
      absolute_offset: 0,
      line: { text },
      submatches: [{ match: { text }, start: column, end: column + 1 }],
    },
  });
}

/** 构造一条 ripgrep context JSON 行 */
function contextLine(file: string, line: number, text: string): string {
  return JSON.stringify({
    type: 'context',
    data: { path: { text: file }, line_number: line, line: { text } },
  });
}

describe('SearchService.grep 参数构建（三件套）', () => {
  let svc: SearchService;
  let spawnFn: ReturnType<typeof vi.fn>;
  let children: FakeChild[];

  beforeEach(() => {
    ({ svc, spawnFn, children } = makeService());
  });

  it('正向：默认参数完整（--json --line-number --column -A 2 -B 2 -e pattern + 路径）', async () => {
    const p = svc.grep(grepOptions({ pattern: 'foo', paths: ['C:\\a', 'C:\\b'] }));
    children[0]?.close(0);
    await p;
    const [file, args] = spawnFn.mock.calls[0] ?? [];
    expect(file).toBeTruthy(); // rgPath
    expect(args).toEqual([
      '--json',
      '--line-number',
      '--column',
      '-A',
      '2',
      '-B',
      '2',
      '-e',
      'foo',
      '-i',
      'C:\\a',
      'C:\\b',
    ]);
    expect(children[0]).toBeDefined();
  });

  it('边界：caseSensitive=true → 不加 -i', async () => {
    const p = svc.grep(grepOptions({ caseSensitive: true }));
    children[0]?.close(0);
    await p;
    const [, args] = spawnFn.mock.calls[0] ?? [];
    expect(args).not.toContain('-i');
  });

  it('边界：caseSensitive=false → 加 -i', async () => {
    const p = svc.grep(grepOptions({ caseSensitive: false }));
    children[0]?.close(0);
    await p;
    const [, args] = spawnFn.mock.calls[0] ?? [];
    expect(args).toContain('-i');
  });

  it('边界：isRegex=false → 加 -F 字面量模式', async () => {
    const p = svc.grep(grepOptions({ isRegex: false }));
    children[0]?.close(0);
    await p;
    const [, args] = spawnFn.mock.calls[0] ?? [];
    expect(args).toContain('-F');
  });

  it('边界：include 有值 → -g glob；空串 → 不加', async () => {
    let p = svc.grep(grepOptions({ include: '*.ts' }));
    children[0]?.close(0);
    await p;
    let [, args] = spawnFn.mock.calls[0] ?? [];
    expect(args).toContain('-g');
    expect(args).toContain('*.ts');
    p = svc.grep(grepOptions({ include: '' }));
    children[1]?.close(0);
    await p;
    [, args] = spawnFn.mock.calls[1] ?? [];
    expect(args).not.toContain('-g');
  });

  it('边界：exclude 数组 → 多个 -g !pattern；空串成员跳过；undefined 兜底不抛', async () => {
    let p = svc.grep(grepOptions({ exclude: ['node_modules', '', 'dist'] }));
    children[0]?.close(0);
    await p;
    const [, args] = spawnFn.mock.calls[0] ?? [];
    expect(args).toEqual([
      '--json',
      '--line-number',
      '--column',
      '-A',
      '2',
      '-B',
      '2',
      '-e',
      'foo',
      '-i',
      '-g',
      '!node_modules',
      '-g',
      '!dist',
      'C:\\work',
    ]);
    // undefined 兜底（工具层 optional 字段未传）
    p = svc.grep(grepOptions({ exclude: undefined as unknown as readonly string[] }));
    children[1]?.close(0);
    await p;
    expect(spawnFn).toHaveBeenCalledTimes(2);
  });

  it('边界：paths 空数组 → 不追加路径参数（ripgrep 默认当前目录）', async () => {
    const p = svc.grep(grepOptions({ paths: [] }));
    children[0]?.close(0);
    await p;
    const [, args] = spawnFn.mock.calls[0] ?? [];
    expect(args).not.toContain('C:\\work');
  });
});

describe('SearchService.grep 输出解析与组装（三件套）', () => {
  let svc: SearchService;
  let children: FakeChild[];

  beforeEach(() => {
    ({ svc, children } = makeService());
  });

  it('正向：match 行解析 → 行号/列号/文本正确', async () => {
    const p = svc.grep(grepOptions());
    const child = children[0] ?? new FakeChild();
    await emitLines(child, [matchLine('a.ts', 3, 'match text', 5)]);
    const res = await p;
    expect(res.matches).toHaveLength(1);
    expect(res.matches[0]).toMatchObject({ file: 'a.ts', line: 3, column: 5, text: 'match text' });
    expect(res.truncated).toBe(false);
  });

  it('正向：context 行按 line_number 组装 before/after（B 侧取最近 2 行、A 侧取最早 2 行）', async () => {
    const p = svc.grep(grepOptions());
    const child = children[0] ?? new FakeChild();
    await emitLines(child, [
      contextLine('a.ts', 1, 'ctx1'),
      contextLine('a.ts', 2, 'ctx2'),
      contextLine('a.ts', 3, 'ctx3'),
      matchLine('a.ts', 4, 'match'),
      contextLine('a.ts', 5, 'ctxA1'),
      contextLine('a.ts', 6, 'ctxA2'),
      contextLine('a.ts', 7, 'ctxA3'),
    ]);
    const res = await p;
    expect(res.matches).toHaveLength(1);
    expect(res.matches[0]?.beforeContext).toEqual(['ctx2', 'ctx3']); // 最近 2 行
    expect(res.matches[0]?.afterContext).toEqual(['ctxA1', 'ctxA2']); // 最早 2 行
  });

  it('边界：context 行用 lines 字段（旧版 ripgrep 兼容）', async () => {
    const p = svc.grep(grepOptions());
    const child = children[0] ?? new FakeChild();
    const legacyCtx = JSON.stringify({
      type: 'context',
      data: { path: { text: 'a.ts' }, line_number: 1, lines: { text: 'legacy\n' } },
    });
    await emitLines(child, [legacyCtx, matchLine('a.ts', 2, 'm')]);
    const res = await p;
    expect(res.matches[0]?.beforeContext).toEqual(['legacy']); // 尾随换行被去除
  });

  it('边界：非法 JSON 行跳过（不阻塞搜索）', async () => {
    const p = svc.grep(grepOptions());
    const child = children[0] ?? new FakeChild();
    await emitLines(child, ['not-json{', matchLine('a.ts', 1, 'ok')]);
    const res = await p;
    expect(res.matches).toHaveLength(1);
  });

  it('边界：空行跳过', async () => {
    const p = svc.grep(grepOptions());
    const child = children[0] ?? new FakeChild();
    await emitLines(child, ['', matchLine('a.ts', 1, 'ok')]);
    const res = await p;
    expect(res.matches).toHaveLength(1);
  });

  it('边界：match 无 submatches（空数组）→ column 兜底 0', async () => {
    const p = svc.grep(grepOptions());
    const child = children[0] ?? new FakeChild();
    const noSubmatch = JSON.stringify({
      type: 'match',
      data: { path: { text: 'a.ts' }, line_number: 1, line: { text: 'x' }, submatches: [] },
    });
    await emitLines(child, [noSubmatch]);
    const res = await p;
    expect(res.matches).toHaveLength(1);
    expect(res.matches[0]?.column).toBe(0);
  });

  it('边界：parseMatchLine 抛错（data 缺 submatches 字段）→ 跳过该行，不阻塞', async () => {
    const p = svc.grep(grepOptions());
    const child = children[0] ?? new FakeChild();
    // submatches 缺失 → data.submatches[0] 抛 TypeError → 被 try/catch 捕获跳过
    const malformed = JSON.stringify({
      type: 'match',
      data: { path: { text: 'a.ts' }, line_number: 1, line: { text: 'x' }, lines: { text: 'y' } },
    });
    await emitLines(child, [malformed, matchLine('b.ts', 2, 'ok')]);
    const res = await p;
    expect(res.matches).toHaveLength(1);
    expect(res.matches[0]?.file).toBe('b.ts');
  });

  it('边界：多个文件多 match → 各自关联自己的 context（不串扰）', async () => {
    const p = svc.grep(grepOptions());
    const child = children[0] ?? new FakeChild();
    await emitLines(child, [
      contextLine('a.ts', 1, 'a-ctx'),
      matchLine('a.ts', 2, 'a-match'),
      contextLine('b.ts', 1, 'b-ctx'),
      matchLine('b.ts', 2, 'b-match'),
    ]);
    const res = await p;
    expect(res.matches).toHaveLength(2);
    expect(res.matches[0]?.file).toBe('a.ts');
    expect(res.matches[0]?.beforeContext).toEqual(['a-ctx']);
    expect(res.matches[1]?.file).toBe('b.ts');
    expect(res.matches[1]?.beforeContext).toEqual(['b-ctx']);
  });

  it('边界：超过 maxResults → truncated=true 且主动 kill 子进程', async () => {
    const p = svc.grep(grepOptions({ maxResults: 2 }));
    const child = children[0] ?? new FakeChild();
    await emitLines(child, [
      matchLine('a.ts', 1, 'm1'),
      matchLine('a.ts', 2, 'm2'),
      matchLine('a.ts', 3, 'm3'),
      matchLine('a.ts', 4, 'm4'),
    ]);
    const res = await p;
    expect(res.matches).toHaveLength(2);
    expect(res.truncated).toBe(true);
    expect(child.kill).toHaveBeenCalled(); // 达到上限主动终止
  });

  it('边界：match 恰好等于 maxResults → truncated=false', async () => {
    const p = svc.grep(grepOptions({ maxResults: 2 }));
    const child = children[0] ?? new FakeChild();
    await emitLines(child, [matchLine('a.ts', 1, 'm1'), matchLine('a.ts', 2, 'm2')]);
    const res = await p;
    expect(res.matches).toHaveLength(2);
    expect(res.truncated).toBe(false);
  });

  it('边界：match 超限后到达的 context 行被跳过（不收入缓冲）', async () => {
    const p = svc.grep(grepOptions({ maxResults: 1 }));
    const child = children[0] ?? new FakeChild();
    await emitLines(child, [
      matchLine('a.ts', 1, 'm1'),
      matchLine('a.ts', 2, 'm2'), // 超限：totalMatchCount=2 > 1
      contextLine('a.ts', 3, 'late-ctx'), // 超限后 context：跳过
    ]);
    const res = await p;
    expect(res.matches).toHaveLength(1);
    expect(res.matches[0]?.afterContext).toEqual([]); // 超限 context 未被关联
  });

  it('边界：畸形 context 行（缺 line/text 字段）→ 兜底空字符串不抛', async () => {
    const p = svc.grep(grepOptions());
    const child = children[0] ?? new FakeChild();
    const malformed = JSON.stringify({ type: 'context', data: { path: { text: 'a.ts' } } });
    await emitLines(child, [malformed, matchLine('a.ts', 2, 'm')]);
    const res = await p;
    expect(res.matches[0]?.beforeContext).toEqual(['']);
  });

  it('边界：畸形 match 行（缺 line/lines/text 字段）→ 兜底空字符串不抛', async () => {
    const p = svc.grep(grepOptions());
    const child = children[0] ?? new FakeChild();
    const malformed = JSON.stringify({
      type: 'match',
      data: { path: { text: 'a.ts' }, line_number: 1, submatches: [] },
    });
    await emitLines(child, [malformed]);
    const res = await p;
    expect(res.matches).toHaveLength(1);
    expect(res.matches[0]).toMatchObject({ file: 'a.ts', line: 1, text: '' });
  });
});

describe('SearchService.runRipgrep 退出码处理（三件套）', () => {
  let svc: SearchService;
  let children: FakeChild[];

  beforeEach(() => {
    ({ svc, children } = makeService());
  });

  it('异常：退出码 2 → AppError INVALID_INPUT（参数错误或路径不存在）', async () => {
    const p = svc.grep(grepOptions());
    const child = children[0] ?? new FakeChild();
    child.close(2);
    await expect(p).rejects.toMatchObject({ code: ErrorCode.INVALID_INPUT });
  });

  it('异常：退出码 3（未知）→ AppError INTERNAL_ERROR', async () => {
    const p = svc.grep(grepOptions());
    const child = children[0] ?? new FakeChild();
    child.close(3);
    await expect(p).rejects.toMatchObject({ code: ErrorCode.INTERNAL_ERROR });
  });

  it('边界：信号终止（code=null, signal=SIGTERM）→ 正常 resolve 不抛', async () => {
    const p = svc.grep(grepOptions());
    const child = children[0] ?? new FakeChild();
    child.close(null, 'SIGTERM');
    await expect(p).resolves.toBeDefined();
  });

  it('异常：spawn error 事件 → AppError INTERNAL_ERROR（含 rgPath 上下文）', async () => {
    const p = svc.grep(grepOptions());
    const child = children[0] ?? new FakeChild();
    child.fail(new Error('ENOENT'));
    await expect(p).rejects.toMatchObject({ code: ErrorCode.INTERNAL_ERROR });
  });

  it('异常：stdout 为 null → AppError INTERNAL_ERROR', async () => {
    const child = new FakeChild(null);
    const spawnFn2 = vi.fn(() => child);
    const svc2 = new SearchService({ spawnFn: spawnFn2 as unknown as typeof spawn });
    const p = svc2.grep(grepOptions());
    await expect(p).rejects.toMatchObject({ code: ErrorCode.INTERNAL_ERROR });
  });

  it('异常：stdout 流 error → AppError INTERNAL_ERROR 且不永久 pending', async () => {
    const p = svc.grep(grepOptions());
    const child = children[0] ?? new FakeChild();
    child.stdoutFail(new Error('stream broken'));
    await expect(p).rejects.toMatchObject({ code: ErrorCode.INTERNAL_ERROR });
  });

  it('边界：activeProcesses 清理——正常完成后 Set 为空', async () => {
    const p = svc.grep(grepOptions());
    const child = children[0] ?? new FakeChild();
    child.close(0);
    await p;
    const proc = svc as unknown as { activeProcesses: Set<unknown> };
    expect(proc.activeProcesses.size).toBe(0);
  });
});

describe('SearchService.glob（三件套）', () => {
  let svc: SearchService;
  let spawnFn: ReturnType<typeof vi.fn>;
  let children: FakeChild[];

  beforeEach(() => {
    ({ svc, spawnFn, children } = makeService());
  });

  it('正向：--files -g pattern path 参数 + 文件列表返回', async () => {
    const p = svc.glob(globOptions());
    const child = children[0] ?? new FakeChild();
    await emitLines(child, ['a.ts', 'b/c.ts']);
    const [, args] = spawnFn.mock.calls[0] ?? [];
    expect(args).toEqual(['--files', '-g', '**/*.ts', 'C:\\work']);
    const res = await p;
    expect(res.files).toEqual(['a.ts', 'b/c.ts']);
    expect(res.truncated).toBe(false);
  });

  it('边界：includeHidden=true → 加 --hidden', async () => {
    const p = svc.glob(globOptions({ includeHidden: true }));
    const child = children[0] ?? new FakeChild();
    child.close(0);
    await p;
    const [, args] = spawnFn.mock.calls[0] ?? [];
    expect(args).toContain('--hidden');
  });

  it('边界：空行跳过', async () => {
    const p = svc.glob(globOptions());
    const child = children[0] ?? new FakeChild();
    await emitLines(child, ['', 'a.ts', '']);
    const res = await p;
    expect(res.files).toEqual(['a.ts']);
  });

  it('边界：达到 maxResults → truncated=true 且主动 kill', async () => {
    const p = svc.glob(globOptions({ maxResults: 2 }));
    const child = children[0] ?? new FakeChild();
    await emitLines(child, ['a.ts', 'b.ts', 'c.ts']);
    const res = await p;
    expect(res.files).toEqual(['a.ts', 'b.ts']);
    expect(res.truncated).toBe(true);
    expect(child.kill).toHaveBeenCalled();
  });

  it('边界：恰好 maxResults 条 → truncated=false', async () => {
    const p = svc.glob(globOptions({ maxResults: 2 }));
    const child = children[0] ?? new FakeChild();
    await emitLines(child, ['a.ts', 'b.ts']);
    const res = await p;
    expect(res.files).toEqual(['a.ts', 'b.ts']);
    expect(res.truncated).toBe(false);
  });
});

describe('SearchService.dispose（生命周期）', () => {
  let svc: SearchService;
  let children: FakeChild[];

  beforeEach(() => {
    ({ svc, children } = makeService());
  });

  it('正向：有活跃进程 → 全部 SIGTERM + Set 清空', async () => {
    const p1 = svc.grep(grepOptions());
    const p2 = svc.glob(globOptions());
    children[0]?.close(0);
    children[1]?.close(0);
    await Promise.all([p1, p2]);
    // 挂起进程：dispose 时 kill 它，再模拟 kill 后退出
    const p3 = svc.grep(grepOptions());
    await svc.dispose();
    expect(children[2]?.kill).toHaveBeenCalledWith('SIGTERM');
    children[2]?.close(null, 'SIGTERM'); // 模拟 kill 生效后的 close
    await p3;
    const proc = svc as unknown as { activeProcesses: Set<unknown> };
    expect(proc.activeProcesses.size).toBe(0);
  });

  it('异常：kill 抛错 → 不阻断 dispose', async () => {
    const p = svc.grep(grepOptions());
    const child = children[0] ?? new FakeChild();
    child.kill.mockImplementationOnce(() => {
      throw new Error('kill failed');
    });
    await svc.dispose();
    child.close(null, 'SIGTERM'); // 模拟退出，结束挂起 promise
    await p;
    expect(svc).toBeDefined(); // dispose 完成不抛
  });

  it('正向：无活跃进程 → no-op 不抛', async () => {
    await expect(svc.dispose()).resolves.toBeUndefined();
  });
});

describe('SearchService 单例', () => {
  afterEach(async () => {
    await resetSearchService();
  });

  it('正向：getSearchService 返回同一实例', () => {
    expect(getSearchService()).toBe(getSearchService());
  });

  it('正向：resetSearchService 后返回新实例', async () => {
    const first = getSearchService();
    await resetSearchService();
    expect(getSearchService()).not.toBe(first);
  });

  it('边界：resetSearchService 幂等——连续调用 no-op 不抛', async () => {
    await resetSearchService();
    await expect(resetSearchService()).resolves.toBeUndefined();
  });
});
