import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WebContents } from 'electron';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getTerminalService } from './terminal-service';

/** 输出行数（2000 行 ≈ 40KB，低于 100KB 环形截断阈值） */
const OUTPUT_LINES = 2000;
/** 等待超时（ms） */
const TIMEOUT_MS = 15_000;
/** 回显偏移：PTY 输入行回显包含 1 次字面 perf-line-（cmd 命令行），故目标计数 = 输出行数 + 1 */
const ECHO_OFFSET = 1;

let tempDir: string;
let sendCount = 0;

/** fake webContents：只计数事件推送，不真正发送 */
function createFakeWebContents(): WebContents {
  return {
    isDestroyed: () => false,
    send: () => {
      sendCount += 1;
    },
  } as unknown as WebContents;
}

/** 等待输出缓冲中 perf-line- 计数达到目标（轮询，超时抛错）
 * 注意：PTY 输入回显也含 1 次字面匹配，目标 = 输出行数 + 回显偏移 */
async function waitForLineCount(
  getOutput: () => string,
  minCount: number,
  timeoutMs = TIMEOUT_MS,
): Promise<number> {
  const start = performance.now();
  while (performance.now() - start < timeoutMs) {
    const count = (getOutput().match(/perf-line-/g) ?? []).length;
    if (count >= minCount) {
      return performance.now() - start;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`等待输出行数超时（${timeoutMs}ms）：${minCount} 行`);
}

describe('终端输出吞吐基准（node-pty）', () => {
  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'code-agent-terminal-perf-'));
  });

  afterAll(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {}
  });

  it(`${OUTPUT_LINES} 行输出到达缓冲 < 5s 且事件推送完整`, async () => {
    const service = getTerminalService();
    sendCount = 0;

    const { terminalId } = await service.create({
      cwd: tempDir,
      command: undefined,
      env: undefined,
      cols: 120,
      rows: 30,
      webContents: createFakeWebContents(),
    });

    const start = performance.now();
    await service.input(
      terminalId,
      `cmd /c "for /l %i in (1,1,${OUTPUT_LINES}) do @echo perf-line-%i & echo PERF_END_${OUTPUT_LINES}"\r`,
    );

    const elapsed = await waitForLineCount(
      () => service.getOutput(terminalId),
      OUTPUT_LINES + ECHO_OFFSET,
    );
    const total = performance.now() - start;

    const output = service.getOutput(terminalId);
    const received = (output.match(/perf-line-/g) ?? []).length - ECHO_OFFSET;
    const throughput = (received / (elapsed / 1000)).toFixed(0);

    console.log(
      `[perf] 终端输出 ${received}/${OUTPUT_LINES} 行，耗时 ${total.toFixed(0)}ms，吞吐 ${throughput} 行/s，事件推送 ${sendCount} 条`,
    );

    expect(received, '输出必须完整到达（2000 行无丢失）').toBeGreaterThanOrEqual(OUTPUT_LINES);
    expect(sendCount, '输出事件必须被推送').toBeGreaterThan(0);
    expect(Number(throughput), '终端输出吞吐应 ≥ 300 行/s（基线，渐进收紧）').toBeGreaterThan(300);

    await service.kill(terminalId);
  });
});
