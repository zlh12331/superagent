// e2e/perf/ipc-rtt.bench.spec.ts：浏览器模式 mock 链路的 IPC 调用 RTT 基准（固定 window.api 方法采样 100 次，断言平均 < 10ms、p95 < 20ms）。
// 只度量渲染层调用路径开销（mock 无真实进程间通信）；真实 IPC RTT 由 e2e/perf-electron.spec.ts 的 Electron 窗口用例覆盖，两文件互补。
// 阈值是宽松基线，用于渲染层调用路径的回归检测并可渐进收紧；运行：pnpm test:perf。

import { expect, test } from '@playwright/test';

test.describe('IPC 基准：渲染层调用 RTT（mock 链路）', () => {
  test('window.api.session.list 100 次平均 < 10ms 且 p95 有界', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await expect(page.getByText('Code Agent').first()).toBeVisible({ timeout: 15_000 });

    // 明确方法探测（按已知高频方法顺序），不遍历 api 全量键
    const probe = await page.evaluate(async () => {
      const api = (window as unknown as { api?: Record<string, unknown> }).api;
      if (api === undefined) return { reason: 'window.api 不存在（非 dev:web 环境）' as const };

      const sessionApi = api['session'] as Record<string, unknown> | undefined;
      const list = sessionApi?.['list'];
      const getStatus = (api['system'] as Record<string, unknown> | undefined)?.['getStatus'];

      const fn = (typeof list === 'function' ? list : getStatus) as
        | ((...args: unknown[]) => Promise<unknown>)
        | undefined;
      if (fn === undefined) return { reason: 'session.list / system.getStatus 均不可用' as const };

      // 必须带参：mock 的 session.list 直接解构入参，无参调用会抛错
      const invokeArgs = typeof list === 'function' ? { limit: 50, offset: 0 } : {};
      const timings: number[] = [];
      for (let i = 0; i < 100; i += 1) {
        const start = performance.now();
        await fn(invokeArgs);
        timings.push(performance.now() - start);
      }
      return { reason: null as null, timings };
    });

    if (probe.reason !== null) {
      // 非 mock 链路（window.api 缺失）跳过而非判失败：本基准在该环境下没有度量对象
      test.skip(true, probe.reason);
      return;
    }

    const timings = probe.timings;
    const avg = timings.reduce((a, b) => a + b, 0) / timings.length;
    const sorted = [...timings].sort((a, b) => a - b);
    const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
    const max = sorted[sorted.length - 1] ?? 0;

    console.log(
      `[perf] IPC RTT 平均 ${avg.toFixed(2)}ms / p95 ${p95.toFixed(2)}ms / max ${max.toFixed(2)}ms`,
    );
    expect(avg, 'window.api 调用平均 RTT 应 < 10ms（基线，渐进收紧）').toBeLessThan(10);
    expect(p95, 'p95 应 < 20ms（防长尾拖垮交互）').toBeLessThan(20);
  });
});
