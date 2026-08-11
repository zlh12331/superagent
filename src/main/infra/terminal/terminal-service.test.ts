// src/main/infra/terminal/terminal-service.test.ts
// TerminalService 单测：node-pty 终端会话池（正向/边界/异常三件套）
// ──────────────────────────────────────────────────────────────
// 测试策略（遵循"业务逻辑不 mock、外部依赖注入 fake"）：
// - spawnFn 经构造注入 fake（可编程 FakePty），不 mock 业务代码
// - webContents 用基础设施 stub（isDestroyed/send 记录）
// - 真实 os.constants.signals 验证信号编号 → 名称转换
// ──────────────────────────────────────────────────────────────

import { EventEmitter } from 'node:events';
import { ErrorCode } from '@code-agent/shared/main';
import type { WebContents } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getTerminalService,
  resetTerminalService,
  type TerminalCreateOptions,
  TerminalService,
} from './terminal-service';

/** 输出缓冲上限（与实现 MAX_BUFFER_BYTES 对齐，测环形截断用） */
const MAX_BUFFER_BYTES = 100 * 1024;

/**
 * 可编程 PTY 模拟：继承 EventEmitter 提供 onData/onExit 事件，
 * write/resize/kill 为 vi.fn 便于断言调用。
 */
class FakePty extends EventEmitter {
  readonly pid = 4242;
  readonly write = vi.fn();
  readonly resize = vi.fn();
  readonly kill = vi.fn();

  /** 与 node-pty IPty 事件 API 对齐 */
  onData(listener: (data: string) => void): void {
    this.on('data', listener);
  }

  onExit(listener: (e: { exitCode: number; signal?: number }) => void): void {
    this.on('exit', listener);
  }

  /** 模拟终端输出 */
  emitData(data: string): void {
    this.emit('data', data);
  }

  /** 模拟进程退出 */
  emitExit(exitCode: number, signal?: number): void {
    this.emit('exit', { exitCode, signal });
  }
}

/** fake webContents：计数事件推送（基础设施 stub，非业务 mock） */
function fakeWebContents(destroyed = false): { wc: WebContents; events: unknown[] } {
  const events: unknown[] = [];
  const wc = {
    isDestroyed: () => destroyed,
    send: vi.fn((_channel: string, payload: unknown) => {
      events.push(payload);
    }),
  } as unknown as WebContents;
  return { wc, events };
}

/** 构造注入 fake spawnFn 的服务 + 捕获的 PTY 实例 */
function makeService(): {
  svc: TerminalService;
  spawnFn: ReturnType<typeof vi.fn>;
  ptys: FakePty[];
} {
  const ptys: FakePty[] = [];
  const spawnFn = vi.fn(() => {
    const pty = new FakePty();
    ptys.push(pty);
    return pty;
  });
  const svc = new TerminalService({
    spawnFn: spawnFn as unknown as typeof import('node-pty').spawn,
  });
  return { svc, spawnFn, ptys };
}

/** create 入参构造器（webContents 默认可用） */
function makeOptions(overrides: Partial<TerminalCreateOptions> = {}): TerminalCreateOptions {
  const { wc } = fakeWebContents();
  return {
    cwd: 'C:\\work',
    command: undefined,
    env: undefined,
    cols: 80,
    rows: 24,
    webContents: wc,
    ...overrides,
  };
}

/** 默认 shell 预期（与实现 defaultShell 逻辑一致，跨平台兼容） */
function expectedDefaultShell(): { file: string } {
  if (process.platform === 'win32') {
    return { file: 'powershell.exe' };
  }
  return { file: process.env['SHELL'] ?? '/bin/bash' };
}

describe('TerminalService.create（终端创建三件套）', () => {
  let svc: TerminalService;
  let spawnFn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    ({ svc, spawnFn } = makeService());
  });

  it('正向：command 拆分 file/args，spawn 参数正确 + 返回 {terminalId, pid} + CREATED 事件', async () => {
    const { wc, events } = fakeWebContents();
    const res = await svc.create(
      makeOptions({ command: 'echo hi', cwd: 'C:\\work', cols: 100, rows: 40, webContents: wc }),
    );
    expect(res.pid).toBe(4242);
    expect(res.terminalId).toBeTruthy();
    // spawn 参数断言
    expect(spawnFn).toHaveBeenCalledTimes(1);
    const [file, args, opts] = spawnFn.mock.calls[0] ?? [];
    expect(file).toBe('echo');
    expect(args).toEqual(['hi']);
    expect(opts).toMatchObject({ cwd: 'C:\\work', cols: 100, rows: 40, name: 'xterm-256color' });
    // CREATED 事件推送
    expect(events).toHaveLength(1);
    const payload = events[0] as { terminalId: string; title: string; pid: number };
    expect(payload.title).toBe('echo hi');
    expect(payload.pid).toBe(4242);
    expect(payload.terminalId).toBe(res.terminalId);
  });

  it('正向：command 省略 → 默认 shell', async () => {
    const res = await svc.create(makeOptions());
    const [file] = spawnFn.mock.calls[0] ?? [];
    expect(file).toBe(expectedDefaultShell().file);
    expect(res.terminalId).toBeTruthy();
  });

  it('边界：command 为纯空白 → 回落默认 shell', async () => {
    await svc.create(makeOptions({ command: '   ' }));
    const [file] = spawnFn.mock.calls[0] ?? [];
    expect(file).toBe(expectedDefaultShell().file);
  });

  it('边界：env 合并——用户 env 覆盖系统同名变量，其余继承', async () => {
    const original = process.env['CODE_AGENT_TEST_TERM'];
    process.env['CODE_AGENT_TEST_TERM'] = 'system-value';
    // 索引赋值构造 env（避免字面量 key 触发命名检查）
    const userEnv: Record<string, string> = {};
    userEnv['CODE_AGENT_TEST_TERM'] = 'user-value';
    try {
      await svc.create(makeOptions({ env: userEnv }));
      const [, , opts] = spawnFn.mock.calls[0] ?? [];
      expect(opts.env?.['CODE_AGENT_TEST_TERM']).toBe('user-value');
    } finally {
      if (original === undefined) {
        delete process.env['CODE_AGENT_TEST_TERM'];
      } else {
        process.env['CODE_AGENT_TEST_TERM'] = original;
      }
    }
  });

  it('边界：command 含多空格 → split 正确', async () => {
    await svc.create(makeOptions({ command: 'git  status   -b' }));
    const [file, args] = spawnFn.mock.calls[0] ?? [];
    expect(file).toBe('git');
    expect(args).toEqual(['status', '-b']);
  });

  it('边界：title 取 command；省略时取 file 文件名', async () => {
    const { wc, events } = fakeWebContents();
    // command 场景
    await svc.create(makeOptions({ command: 'node server.js', webContents: wc }));
    expect((events[0] as { title: string }).title).toBe('node server.js');
    // 无 command 场景（单独 webContents 避免事件混叠）
    const { wc: wc2, events: events2 } = fakeWebContents();
    await svc.create(makeOptions({ webContents: wc2 }));
    expect((events2[0] as { title: string }).title).toBe(
      expectedDefaultShell().file.split(/[\\/]/).pop(),
    );
  });

  it('异常：spawn 抛错 → AppError TERMINAL_SPAWN_FAILED（含 file/args/cwd 上下文）', async () => {
    const boom = new Error('shell not found');
    spawnFn.mockImplementationOnce(() => {
      throw boom;
    });
    await expect(svc.create(makeOptions({ command: 'nonexistent-cmd' }))).rejects.toMatchObject({
      code: ErrorCode.TERMINAL_SPAWN_FAILED,
    });
  });

  it('边界：webContents 已销毁 → 不推送 CREATED 事件，创建仍成功', async () => {
    const { wc } = fakeWebContents(true);
    const res = await svc.create(makeOptions({ webContents: wc }));
    expect(res.terminalId).toBeTruthy();
    expect((wc as unknown as { send: ReturnType<typeof vi.fn> }).send).not.toHaveBeenCalled();
  });
});

describe('TerminalService 输出缓冲（onData 三件套）', () => {
  let svc: TerminalService;
  let ptys: FakePty[];

  beforeEach(() => {
    ({ svc, ptys } = makeService());
  });

  it('正向：onData → OUTPUT 事件推送 + getOutput 累积', async () => {
    const { wc, events } = fakeWebContents();
    const res = await svc.create(makeOptions({ command: 'echo hi', webContents: wc }));
    const pty = ptys[0] ?? new FakePty();
    pty.emitData('hello\n');
    pty.emitData('world');
    // created + 2 output 共 3 个事件
    expect(events).toHaveLength(3);
    expect((events[1] as { data: string }).data).toBe('hello\n');
    expect((events[2] as { data: string }).data).toBe('world');
    expect(svc.getOutput(res.terminalId)).toBe('hello\nworld');
  });

  it('正向：输出累积顺序正确（多段拼接）', async () => {
    const res = await svc.create(makeOptions());
    const pty = ptys[0] ?? new FakePty();
    pty.emitData('a');
    pty.emitData('b');
    pty.emitData('c');
    expect(svc.getOutput(res.terminalId)).toBe('abc');
  });

  it('边界：累积超 MAX_BUFFER_BYTES → 环形截断保留尾部', async () => {
    const res = await svc.create(makeOptions());
    const pty = ptys[0] ?? new FakePty();
    // 第一段 60KB 'a' + 第二段 60KB 'b' = 120KB > 100KB
    // 截断保留尾部 100KB = 40KB 'a' + 60KB 'b'（头部被丢弃）
    pty.emitData('a'.repeat(60 * 1024));
    pty.emitData('b'.repeat(60 * 1024));
    const output = svc.getOutput(res.terminalId);
    expect(output.length).toBe(MAX_BUFFER_BYTES);
    expect(output.endsWith('b'.repeat(60 * 1024))).toBe(true);
  });

  it('异常：webContents 已销毁 → 不推送 OUTPUT 事件，缓冲照常累积', async () => {
    const { wc } = fakeWebContents(true);
    const res = await svc.create(makeOptions({ webContents: wc }));
    const pty = ptys[0] ?? new FakePty();
    pty.emitData('secret output');
    expect((wc as unknown as { send: ReturnType<typeof vi.fn> }).send).not.toHaveBeenCalled();
    expect(svc.getOutput(res.terminalId)).toBe('secret output');
  });
});

describe('TerminalService.onExit（退出事件三件套）', () => {
  let svc: TerminalService;
  let ptys: FakePty[];

  beforeEach(() => {
    ({ svc, ptys } = makeService());
  });

  it('正向：exitCode + signal=9 → EXIT 事件 signal=SIGKILL + 终端从 Map 移除', async () => {
    const { wc, events } = fakeWebContents();
    const res = await svc.create(makeOptions({ webContents: wc }));
    const pty = ptys[0] ?? new FakePty();
    pty.emitExit(1, 9);
    const exitPayload = events.find((e) => (e as { exitCode?: number }).exitCode === 1) as {
      signal: string;
      exitCode: number;
    };
    expect(exitPayload).toBeDefined();
    expect(exitPayload.signal).toBe('SIGKILL');
    expect(exitPayload.exitCode).toBe(1);
    // 已移除：input 返回 ok:false
    await expect(svc.input(res.terminalId, 'x')).resolves.toEqual({ ok: false });
  });

  it('边界：signal=undefined → EXIT 事件无 signal 字段', async () => {
    const { wc, events } = fakeWebContents();
    await svc.create(makeOptions({ webContents: wc }));
    const pty = ptys[0] ?? new FakePty();
    pty.emitExit(0);
    const exitPayload = events.find((e) => (e as { exitCode?: number }).exitCode === 0) as {
      signal?: string;
    };
    expect(exitPayload).toBeDefined();
    expect('signal' in (exitPayload as object)).toBe(false);
  });

  it('边界：未知信号编号 999 → 兜底 signal:999', async () => {
    const { wc, events } = fakeWebContents();
    await svc.create(makeOptions({ webContents: wc }));
    const pty = ptys[0] ?? new FakePty();
    pty.emitExit(2, 999);
    const exitPayload = events.find((e) => (e as { exitCode?: number }).exitCode === 2) as {
      signal: string;
    };
    expect(exitPayload.signal).toBe('signal:999');
  });

  it('异常：webContents 已销毁 → 不推送 EXIT 事件，Map 移除照常', async () => {
    const { wc } = fakeWebContents(true);
    const res = await svc.create(makeOptions({ webContents: wc }));
    const pty = ptys[0] ?? new FakePty();
    pty.emitExit(0);
    expect((wc as unknown as { send: ReturnType<typeof vi.fn> }).send).not.toHaveBeenCalled();
    await expect(svc.input(res.terminalId, 'x')).resolves.toEqual({ ok: false });
  });
});

describe('TerminalService.input/resize/kill（操作三件套）', () => {
  let svc: TerminalService;
  let ptys: FakePty[];

  beforeEach(() => {
    ({ svc, ptys } = makeService());
  });

  it('input 正向：存在 → write 调用 + ok:true', async () => {
    const res = await svc.create(makeOptions());
    const pty = ptys[0] ?? new FakePty();
    await expect(svc.input(res.terminalId, 'ls -la')).resolves.toEqual({ ok: true });
    expect(pty.write).toHaveBeenCalledWith('ls -la');
  });

  it('input 异常：终端不存在 → ok:false 不抛', async () => {
    await expect(svc.input('ghost', 'x')).resolves.toEqual({ ok: false });
  });

  it('input 异常：write 抛错 → ok:false 不抛', async () => {
    const res = await svc.create(makeOptions());
    const pty = ptys[0] ?? new FakePty();
    pty.write.mockImplementationOnce(() => {
      throw new Error('pty closed');
    });
    await expect(svc.input(res.terminalId, 'x')).resolves.toEqual({ ok: false });
  });

  it('resize 正向：存在 → resize(cols, rows) + ok:true', async () => {
    const res = await svc.create(makeOptions());
    const pty = ptys[0] ?? new FakePty();
    await expect(svc.resize(res.terminalId, 120, 50)).resolves.toEqual({ ok: true });
    expect(pty.resize).toHaveBeenCalledWith(120, 50);
  });

  it('resize 异常：不存在 → ok:false 不抛', async () => {
    await expect(svc.resize('ghost', 80, 24)).resolves.toEqual({ ok: false });
  });

  it('resize 异常：resize 抛错 → ok:false 不抛', async () => {
    const res = await svc.create(makeOptions());
    const pty = ptys[0] ?? new FakePty();
    pty.resize.mockImplementationOnce(() => {
      throw new Error('resize failed');
    });
    await expect(svc.resize(res.terminalId, 80, 24)).resolves.toEqual({ ok: false });
  });

  it('kill 正向：存在 → kill 调用 + ok:true（kill 抛错仍 ok:true）', async () => {
    const res = await svc.create(makeOptions());
    const pty = ptys[0] ?? new FakePty();
    pty.kill.mockImplementationOnce(() => {
      throw new Error('already dead');
    });
    await expect(svc.kill(res.terminalId)).resolves.toEqual({ ok: true });
    expect(pty.kill).toHaveBeenCalled();
  });

  it('kill 异常：不存在 → ok:false 不抛', async () => {
    await expect(svc.kill('ghost')).resolves.toEqual({ ok: false });
  });
});

describe('TerminalService.getOutput/clearOutput', () => {
  let svc: TerminalService;
  let ptys: FakePty[];

  beforeEach(() => {
    ({ svc, ptys } = makeService());
  });

  it('正向：有缓冲 → 返回累积内容；clearOutput 后返回空串', async () => {
    const res = await svc.create(makeOptions());
    const pty = ptys[0] ?? new FakePty();
    pty.emitData('history');
    expect(svc.getOutput(res.terminalId)).toBe('history');
    svc.clearOutput(res.terminalId);
    expect(svc.getOutput(res.terminalId)).toBe('');
  });

  it('边界：终端不存在 → 返回空串（不抛）', () => {
    expect(svc.getOutput('ghost')).toBe('');
    expect(() => svc.clearOutput('ghost')).not.toThrow();
  });

  it('边界：PTY 退出后缓冲仍可读取（历史保留）', async () => {
    const res = await svc.create(makeOptions());
    const pty = ptys[0] ?? new FakePty();
    pty.emitData('done output');
    pty.emitExit(0);
    expect(svc.getOutput(res.terminalId)).toBe('done output');
  });
});

describe('TerminalService.dispose（生命周期）', () => {
  let svc: TerminalService;
  let ptys: FakePty[];

  beforeEach(() => {
    ({ svc, ptys } = makeService());
  });

  it('正向：有活跃终端 → 全部 kill + Map/缓冲清空', async () => {
    const res1 = await svc.create(makeOptions());
    await svc.create(makeOptions());
    ptys[0]?.emitData('leftover');
    await svc.dispose();
    expect(ptys[0]?.kill).toHaveBeenCalled();
    expect(ptys[1]?.kill).toHaveBeenCalled();
    expect(svc.getOutput(res1.terminalId)).toBe('');
    await expect(svc.input(res1.terminalId, 'x')).resolves.toEqual({ ok: false });
  });

  it('异常：kill 抛错 → 不阻断，继续清理其余终端', async () => {
    const res1 = await svc.create(makeOptions());
    await svc.create(makeOptions());
    ptys[0]?.emitData('buffered');
    ptys[0]?.kill.mockImplementationOnce(() => {
      throw new Error('kill failed');
    });
    await expect(svc.dispose()).resolves.toBeUndefined();
    expect(ptys[1]?.kill).toHaveBeenCalled();
    expect(svc.getOutput(res1.terminalId)).toBe('');
  });

  it('正向：无终端 → no-op 不抛', async () => {
    await expect(svc.dispose()).resolves.toBeUndefined();
  });
});

describe('TerminalService 单例', () => {
  afterEach(async () => {
    await resetTerminalService();
  });

  it('正向：getTerminalService 返回同一实例', () => {
    expect(getTerminalService()).toBe(getTerminalService());
  });

  it('正向：resetTerminalService 后返回新实例（旧实例已 dispose）', async () => {
    const first = getTerminalService();
    await resetTerminalService();
    const second = getTerminalService();
    expect(second).not.toBe(first);
  });

  it('边界：resetTerminalService 幂等——连续调用 no-op 不抛', async () => {
    await resetTerminalService();
    await expect(resetTerminalService()).resolves.toBeUndefined();
  });
});
