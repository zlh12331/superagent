// e2e/perf/memory-leak.spec.ts
// 内存泄漏基准：长会话操作后 heap 增长趋势（对齐 memlab 三阶段方法论）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 3 轮循环操作（开关设置抽屉 + 消息流），每轮采样 usedJSHeapSize
// - 强制 GC（CDP HeapProfiler.collectGarbage，比 window.gc 可靠）
// - 断言：末轮 vs 基线增长 < 15MB，且无"持续增长"趋势（每轮增量递减）
//   ——泄漏的特征是单调增长，GC 后仍不回落的对象引用
//
// 诚实标注：
// - performance.memory 为 Chromium 非标准 API（浏览器/Electron 均支持）
// - 本基准为"粗略回归哨兵"：真实泄漏定位需 heap snapshot 分析
//   （业界标准 memlab 已评估：基于 Puppeteer 场景，与 Playwright 集成成本高，
//   方法论对齐落地为本三阶段采样；需要精确 retainer trace 时再引入 memlab）
//
// 运行：pnpm test:perf
// ──────────────────────────────────────────────────────────────

import { expect, test } from '@playwright/test';

test.describe('内存基准：长会话 heap 趋势', () => {
  test('3 轮操作后 heap 增长 < 15MB 且无持续增长趋势', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await expect(page.getByText('Code Agent').first()).toBeVisible({ timeout: 15_000 });

    // 检查 performance.memory 可用性（不可用则明确 skip 而非静默通过）
    const memorySupported = await page.evaluate(() => performance.memory !== undefined);
    test.skip(!memorySupported, 'performance.memory 不可用（非 Chromium 内核），跳过内存基准');

    // CDP 会话：HeapProfiler.collectGarbage 强制 GC（比 window.gc 更可靠）
    const cdp = await page.context().newCDPSession(page);
    const gc = async (): Promise<void> => {
      await cdp.send('HeapProfiler.collectGarbage').catch(() => {});
      await page.waitForTimeout(200);
    };
    const heapMb = (): Promise<number> =>
      page.evaluate(() => (performance.memory ? performance.memory.usedJSHeapSize / 1048576 : 0));

    // 基线采样（操作前 GC 后）
    await gc();
    const baseline = await heapMb();

    // 3 轮操作，每轮采样（对齐 memlab baseline/target/final 三阶段）
    const samples: number[] = [];
    for (let round = 0; round < 3; round += 1) {
      // 开关设置抽屉 3 次 + 消息输入发送 1 次（真实 UI 链路）
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
    // 每轮增量（泄漏特征：持续增长；正常：GC 后回落，增量递减）
    const deltas = samples.map((v, i) => v - (i === 0 ? baseline : (samples[i - 1] ?? v)));
    const monotonicGrowth = deltas.every((d) => d > 0.5); // 每轮都净增 >0.5MB = 疑似泄漏

    console.log(
      `[perf] heap 趋势: 基线 ${baseline.toFixed(1)}MB → ${samples.map((s) => `${s.toFixed(1)}MB`).join(' → ')}（增长 ${finalGrowth.toFixed(2)}MB，每轮增量 ${deltas.map((d) => d.toFixed(2)).join('/')}MB）`,
    );

    expect(finalGrowth, '3 轮操作后 heap 增长应 < 15MB（基线，防明显泄漏回退）').toBeLessThan(15);
    expect(
      monotonicGrowth,
      `每轮增量 ${deltas.map((d) => d.toFixed(2)).join('/')}MB：持续单调增长疑似泄漏（GC 后应回落）`,
    ).toBe(false);
  });
});
