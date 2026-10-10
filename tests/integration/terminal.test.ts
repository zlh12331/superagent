import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { TerminalService } from '../../src/main/infra/terminal/terminal-service';
import { createTerminalHandlers } from '../../src/main/ipc/terminal.handler';
import { createFakeWebContents } from './helpers/fake-webcontents';

/** 每用例独立临时工作目录 */
async function withTempCwd<T>(fn: (dir: string) => Promise<T> | T): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'code-agent-term-'));
  try {
    return await fn(dir);
  } finally {
    await new Promise((resolve) => setTimeout(resolve, 300));
    try {
      rmSync(dir, { recursive: true, maxRetries: 5 });
    } catch {}
  }
}

/** 平台 shell 绝对路径（Windows node-pty 不查 PATH——用 ComSpec；Linux 用 /bin/bash） */
const PLATFORM_SHELL =
  process.platform === 'win32'
    ? (process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe')
    : '/bin/bash';

/** 平台化 node 命令（cmd/bash 均可解析 PATH 中的 node） */
const NODE_PRINT = 'node -e "console.log(12345)"';

/** 等待 PTY 输出事件到达（真实进程异步；waitFor 轮询） */
async function waitForOutput(
  sent: Array<{ channel: string; payload: unknown }>,
  needle: string,
): Promise<void> {
  await vi.waitFor(
    () => {
      const outputs = sent
        .filter((s) => s.channel.includes('event:output'))
        .map((s) => (s.payload as { data: string }).data)
        .join('');
      expect(outputs).toContain(needle);
    },
    { timeout: 3000 },
  );
}

describe('terminal 域集成链路（batch 5）', () => {
  it('正向：create→output→exit 全链（node -e 一次性输出）', async () => {
    await withTempCwd(async (cwd) => {
      const handlers = createTerminalHandlers({ terminalService: new TerminalService() });
      const { wc, sent } = createFakeWebContents();

      const { terminalId } = await handlers.create(
        { command: PLATFORM_SHELL, cwd, cols: 80, rows: 24 },
        { traceId: 't', sender: wc } as never,
      );
      expect(terminalId).toBeDefined();

      await handlers.input({ terminalId, data: `${NODE_PRINT}\r` });
      await waitForOutput(sent, '12345');
      const created = sent.find((s) => s.channel.includes('event:created'))?.payload as {
        terminalId: string;
      };
      expect(created.terminalId).toBe(terminalId);
      await handlers.kill({ terminalId });
      await vi.waitFor(
        () => {
          expect(sent.some((s) => s.channel.includes('event:exit'))).toBe(true);
        },
        { timeout: 3000 },
      );
    });
  });

  it('正向：input→output 往返（node REPL 交互）', async () => {
    await withTempCwd(async (cwd) => {
      const handlers = createTerminalHandlers({ terminalService: new TerminalService() });
      const { wc, sent } = createFakeWebContents();

      const { terminalId } = await handlers.create(
        { command: PLATFORM_SHELL, cwd, cols: 80, rows: 24 },
        { traceId: 't', sender: wc } as never,
      );
      await vi.waitFor(() => {
        expect(sent.some((s) => s.channel.includes('event:output'))).toBe(true);
      });

      const inputRes = await handlers.input({ terminalId, data: `${NODE_PRINT}\r` });
      expect(inputRes.ok).toBe(true);
      await waitForOutput(sent, '12345');
      await handlers.kill({ terminalId });
    });
  });

  it('正向：resize → ok true', async () => {
    await withTempCwd(async (cwd) => {
      const handlers = createTerminalHandlers({ terminalService: new TerminalService() });
      const { wc } = createFakeWebContents();
      const { terminalId } = await handlers.create(
        { command: PLATFORM_SHELL, cwd, cols: 80, rows: 24 },
        { traceId: 't', sender: wc } as never,
      );
      const resizeRes = await handlers.resize({ terminalId, cols: 100, rows: 40 });
      expect(resizeRes.ok).toBe(true);
      await handlers.kill({ terminalId });
    });
  });

  it('正向：kill → ok true + exit 事件', async () => {
    await withTempCwd(async (cwd) => {
      const handlers = createTerminalHandlers({ terminalService: new TerminalService() });
      const { wc, sent } = createFakeWebContents();
      const { terminalId } = await handlers.create(
        { command: PLATFORM_SHELL, cwd, cols: 80, rows: 24 },
        { traceId: 't', sender: wc } as never,
      );
      const killRes = await handlers.kill({ terminalId });
      expect(killRes.ok).toBe(true);
      await vi.waitFor(
        () => {
          expect(sent.some((s) => s.channel.includes('event:exit'))).toBe(true);
        },
        { timeout: 3000 },
      );
    });
  });

  it('异常：spawn 抛错 → 错误传播（TERMINAL_SPAWN_FAILED）', async () => {
    await withTempCwd(async (cwd) => {
      const handlers = createTerminalHandlers({
        terminalService: new TerminalService({
          spawnFn: () => {
            throw new Error('pty spawn failed');
          },
        }),
      });
      const { wc } = createFakeWebContents();
      await expect(
        handlers.create({ command: 'definitely-not-exist-cmd-xyz', cwd, cols: 80, rows: 24 }, {
          traceId: 't',
          sender: wc,
        } as never),
      ).rejects.toMatchObject({ code: 'TERMINAL_SPAWN_FAILED' });
    });
  });

  it('异常+资源：input/resize/kill 不存在 → ok=false（不抛）', async () => {
    const handlers = createTerminalHandlers({ terminalService: new TerminalService() });
    expect((await handlers.input({ terminalId: 'ghost', data: 'x' })).ok).toBe(false);
    expect((await handlers.resize({ terminalId: 'ghost', cols: 10, rows: 10 })).ok).toBe(false);
    expect((await handlers.kill({ terminalId: 'ghost' })).ok).toBe(false);
  });

  it('并发：并行 create 独立 terminalId', async () => {
    await withTempCwd(async (cwd) => {
      const handlers = createTerminalHandlers({ terminalService: new TerminalService() });
      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          handlers.create({ command: PLATFORM_SHELL, cwd, cols: 80, rows: 24 }, {
            traceId: 't',
            sender: createFakeWebContents().wc,
          } as never),
        ),
      );
      const ids = new Set(results.map((r) => r.terminalId));
      expect(ids.size).toBe(5);
      for (const r of results) {
        await handlers.kill({ terminalId: r.terminalId });
      }
    });
  });
});
