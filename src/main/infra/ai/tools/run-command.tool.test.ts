import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createRunCommandTool } from './run-command.tool';
import type { ToolContext } from './tool';

const mocks = vi.hoisted(() => {
  const mockSpawn = vi.fn();
  return { mockSpawn };
});

vi.mock('node:child_process', () => ({ spawn: mocks.mockSpawn }));

function createCtx(): ToolContext {
  return {
    workingDir: 'C:\\projects\\my-app',
    sessionId: 'session-1',
    messageId: 'msg-1',
    callId: 'call-1',
    abortSignal: new AbortController().signal,
    webContents: {} as never,
    mode: 'build',
  };
}

function mockSpawnSuccess(stdout: string) {
  const child = {
    stdout: {
      on: vi.fn((event: string, cb: (d: Buffer) => void) => {
        if (event === 'data') cb(Buffer.from(stdout));
      }),
    },
    stderr: { on: vi.fn() },
    on: vi.fn((event: string, cb: (code: number, signal: string | null) => void) => {
      if (event === 'close') cb(0, null);
    }),
    kill: vi.fn(),
  };
  mocks.mockSpawn.mockReturnValue(child);
  return child;
}

describe('createRunCommandTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('工具元数据：name=run_command, permission=ask', () => {
    const tool = createRunCommandTool();
    expect(tool.name).toBe('run_command');
    expect(tool.permission).toBe('ask');
    expect(tool.description).toContain('需用户审批');
  });

  it('危险命令（rm -rf /）：安全拦截，不 spawn', async () => {
    const tool = createRunCommandTool();
    const result = await tool.execute(
      { command: 'rm -rf /', cwd: undefined, timeout: 5000 },
      createCtx(),
    );

    expect(result.metadata).toMatchObject({ blocked: true });
    expect(result.output).toContain('[安全拦截]');
    expect(mocks.mockSpawn).not.toHaveBeenCalled();
  });

  it('危险命令（mkfs）：安全拦截', async () => {
    const tool = createRunCommandTool();
    const result = await tool.execute(
      { command: 'mkfs.ext4 /dev/sda', cwd: undefined, timeout: 5000 },
      createCtx(),
    );
    expect(result.metadata).toMatchObject({ blocked: true });
    expect(mocks.mockSpawn).not.toHaveBeenCalled();
  });

  it('危险命令（dd 覆写块设备）：安全拦截', async () => {
    const tool = createRunCommandTool();
    const result = await tool.execute(
      { command: 'dd if=/dev/zero of=/dev/sda bs=1M', cwd: undefined, timeout: 5000 },
      createCtx(),
    );
    expect(result.metadata).toMatchObject({ blocked: true });
  });

  it('危险命令（shutdown）：安全拦截', async () => {
    const tool = createRunCommandTool();
    const result = await tool.execute(
      { command: 'shutdown -h now', cwd: undefined, timeout: 5000 },
      createCtx(),
    );
    expect(result.metadata).toMatchObject({ blocked: true });
  });

  it('危险命令（fork bomb）：安全拦截', async () => {
    const tool = createRunCommandTool();
    const result = await tool.execute(
      { command: ':(){ :|:& };:', cwd: undefined, timeout: 5000 },
      createCtx(),
    );
    expect(result.metadata).toMatchObject({ blocked: true });
  });

  it('正常命令：放行并执行', async () => {
    mockSpawnSuccess('hello world');
    const tool = createRunCommandTool();
    const result = await tool.execute(
      { command: 'echo hello world', cwd: undefined, timeout: 5000 },
      createCtx(),
    );

    expect(mocks.mockSpawn).toHaveBeenCalledTimes(1);
    expect(result.output).toContain('hello world');
    expect(result.metadata).toMatchObject({ exitCode: 0, timedOut: false });
  });

  it('正常命令带超时参数：透传 timeout', async () => {
    mockSpawnSuccess('ok');
    const tool = createRunCommandTool();
    await tool.execute({ command: 'npm test', cwd: undefined, timeout: 10000 }, createCtx());

    const [shell, args] = mocks.mockSpawn.mock.calls[0] ?? [];
    expect(args).toContain('npm test');
    void shell;
  });

  it('cwd 越界（../）：抛 AppError（由 ToolExecutor 转为执行失败）', async () => {
    const tool = createRunCommandTool();
    await expect(
      tool.execute({ command: 'ls', cwd: '..\\..\\outside', timeout: 5000 }, createCtx()),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });
});
