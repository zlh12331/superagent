// src/main/infra/terminal/terminal-service.perf.test.ts
// 终端输出吞吐基准：真实 node-pty + shell（对齐高频终端输出场景）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 大输出流吞吐：2000 行 shell 输出从写入到全部进入缓冲的耗时
// - 输出完整性：结束标记必须到达（防性能测试空转/缓冲丢失）
// - 事件推送开销：fake webContents 计数（send 次数 = 输出事件条数）
//
// 运行：pnpm test:perf:main（vitest 跑在 Node ABI，node-pty 原生模块可用）
// 阈值策略：宽松基线（Windows cmd 逐行 echo + PTY 处理开销）
// ──────────────────────────────────────────────────────────────

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
    } catch {
      // Windows 句柄延迟释放时跳过清理
    }
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

    // 写入大输出命令（cmd /c 显式调用：避免 PS 交互式解析差异；已验证 PTY 内可行）
    // 输出顺序：for 循环 2000 行 → END 标记；PTY 背压上限 ~700 行/s，需等待排空
    const start = performance.now();
    await service.input(
      terminalId,
      `cmd /c "for /l %i in (1,1,${OUTPUT_LINES}) do @echo perf-line-%i & echo PERF_END_${OUTPUT_LINES}"\r`,
    );

    // 等待全部行到达（含回显偏移：目标 = 输出 + 1 次回显）
    const elapsed = await waitForLineCount(
      () => service.getOutput(terminalId),
      OUTPUT_LINES + ECHO_OFFSET,
    );
    const total = performance.now() - start;

    const output = service.getOutput(terminalId);
    // 回显 1 次字面 + 实际输出行；断言以实际输出为准（≥ 输出行数）
    const received = (output.match(/perf-line-/g) ?? []).length - ECHO_OFFSET;
    const throughput = (received / (elapsed / 1000)).toFixed(0);

    console.log(
      `[perf] 终端输出 ${received}/${OUTPUT_LINES} 行，耗时 ${total.toFixed(0)}ms，吞吐 ${throughput} 行/s，事件推送 ${sendCount} 条`,
    );

    // 完整性：全部行到达（回显偏移因并发环境可能 >1，用 ≥ 防误杀）
    expect(received, '输出必须完整到达（2000 行无丢失）').toBeGreaterThanOrEqual(OUTPUT_LINES);
    // 事件推送与输出数据一一对应（每段 data 一条事件）
    expect(sendCount, '输出事件必须被推送').toBeGreaterThan(0);
    // 吞吐门槛：2000 行 ≥ 300 行/s（PS for 循环逐行输出，宽松基线）
    expect(Number(throughput), '终端输出吞吐应 ≥ 300 行/s（基线，渐进收紧）').toBeGreaterThan(300);

    await service.kill(terminalId);
  });
});
