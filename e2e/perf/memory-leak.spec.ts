// e2e/perf/memory-leak.spec.ts：长会话内存基准——3 轮真实 UI 操作后，按 GC 后 usedJSHeapSize 判定 heap 增长趋势
// 边界：粗略回归哨兵（< 15MB 且无单调增长），不做精确泄漏定位——嫌疑时落盘 heap snapshot 交 DevTools/memlab 人工分析
// 依赖 Chromium 非标准 API performance.memory（其他内核显式 skip）；运行：pnpm test:perf
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

/** 快照落盘目录（stats/ 已 gitignore；故障取证用） */
const SNAPSHOT_DIR = join(process.cwd(), 'stats', 'heap-snapshots');
/** 泄漏判定阈值（MB）：断言与落盘共用同一常量，防改一处漏另一处 */
const GROWTH_LIMIT_MB = 15;

/** CDP 导出完整 heap 快照（流式 chunk 收集，落盘 .heapsnapshot 供 DevTools/memlab 分析） */
async function dumpHeapSnapshot(
  cdp: import('playwright-core').CDPSession,
  label: string,
): Promise<string> {
  const chunks: string[] = [];
  // Playwright 的 CDP on 回调直接给出 params（无 { params } 包装）；取错层级会收不到任何 chunk
  cdp.on('HeapProfiler.addHeapSnapshotChunk', (params) => {
    const chunk = (params as { chunk?: string }).chunk;
    if (chunk !== undefined) chunks.push(chunk);
  });
  // 必须先 enable 事件域，否则不派发 chunk 事件，落盘 0 字节快照
  await cdp.send('HeapProfiler.enable');
  await cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false });
  // chunk 事件可能在 takeHeapSnapshot resolve 之后才派发完，需轮询等排空；5s 为兜底上限
  const deadline = Date.now() + 5_000;
  let stableRounds = 0;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 150));
    if (chunks.length > 0) {
      stableRounds += 1;
      if (stableRounds >= 3) break;
    }
  }
  const file = join(SNAPSHOT_DIR, `heap-${label}-${Date.now()}.heapsnapshot`);
  mkdirSync(SNAPSHOT_DIR, { recursive: true });
  writeFileSync(file, chunks.join(''), 'utf8');
  return file;
}

test.describe('内存基准：长会话 heap 趋势', () => {
  test('3 轮操作后 heap 增长 < 15MB 且无持续增长趋势', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await expect(page.getByText('Code Agent').first()).toBeVisible({ timeout: 15_000 });

    // 非 Chromium 内核无此 API：显式 skip 而不是静默通过，避免基准假绿
    const memorySupported = await page.evaluate(() => performance.memory !== undefined);
    test.skip(!memorySupported, 'performance.memory 不可用（非 Chromium 内核），跳过内存基准');

    // 强制 GC 走 CDP HeapProfiler（window.gc 需额外启动标志，基准里不可依赖）
    const cdp = await page.context().newCDPSession(page);
    const gc = async (): Promise<void> => {
      await cdp.send('HeapProfiler.collectGarbage').catch(() => {});
      await page.waitForTimeout(200);
    };
    const heapMb = (): Promise<number> =>
      page.evaluate(() => (performance.memory ? performance.memory.usedJSHeapSize / 1048576 : 0));

    // 基线取 GC 之后的值：增长量要衡量存活对象，而非尚未回收的垃圾
    await gc();
    const baseline = await heapMb();

    // 3 轮对应 memlab baseline/target/final 三阶段采样（方法学对齐，未引入 memlab 本体）
    const samples: number[] = [];
    for (let round = 0; round < 3; round += 1) {
      // 开关设置抽屉 3 次 + 输入发送 1 条消息：走真实 UI 链路制造对象分配
      for (let i = 0; i < 3; i += 1) {
        await page.keyboard.press('Control+,');
        await page.waitForTimeout(100);
      }
      const input = page.locator('textarea, [contenteditable="true"]').first();
      if ((await input.count()) > 0) {
        await input.fill(`内存基准消息 ${round}`);
        await input.press('Enter');
        await page.waitForTimeout(200);
      }
      await gc();
      samples.push(await heapMb());
    }

    const finalGrowth = samples[samples.length - 1] - baseline;
    // 每轮相对上一轮的增量：泄漏特征是轮轮净增，正常应在 GC 后回落到基线附近
    const deltas = samples.map((v, i) => v - (i === 0 ? baseline : (samples[i - 1] ?? v)));
    const monotonicGrowth = deltas.every((d) => d > 0.5); // 每轮都净增 >0.5MB 才算单调增长（疑似泄漏）

    console.log(
      `[perf] heap 趋势: 基线 ${baseline.toFixed(1)}MB → ${samples.map((s) => `${s.toFixed(1)}MB`).join(' → ')}（增长 ${finalGrowth.toFixed(2)}MB，每轮增量 ${deltas.map((d) => d.toFixed(2)).join('/')}MB）`,
    );

    // ⚠️ 落盘必须先于断言执行：expect 抛错会中断后续代码，落盘放在断言之后则失败时永远拿不到快照
    const leakSuspected = finalGrowth >= GROWTH_LIMIT_MB || monotonicGrowth;
    if (leakSuspected) {
      const file = await dumpHeapSnapshot(cdp, 'leak-suspect');
      console.log(
        `[perf] 泄漏嫌疑快照已落盘：${file}（DevTools Memory → Load 或 memlab analyze 分析）`,
      );
    }

    expect(finalGrowth, '3 轮操作后 heap 增长应 < 15MB（基线，防明显泄漏回退）').toBeLessThan(
      GROWTH_LIMIT_MB,
    );
    expect(
      monotonicGrowth,
      `每轮增量 ${deltas.map((d) => d.toFixed(2)).join('/')}MB：持续单调增长疑似泄漏（GC 后应回落）`,
    ).toBe(false);
  });
});
