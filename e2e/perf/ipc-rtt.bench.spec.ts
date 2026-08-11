// e2e/perf/ipc-rtt.bench.spec.ts
// IPC 调用延迟基准：渲染层 API 调用 RTT
// ──────────────────────────────────────────────────────────────
// 职责：
// - 浏览器模式（mock-api）：window.api 明确方法（session.list / system.getStatus）
//   的调用往返延迟，100 次采样报告平均 + p95
// - 阈值：平均 < 10ms（宽松基线；渲染层调用路径回归检测）
//
// 诚实标注：
// - 浏览器模式为 mock 实现（无真实进程间通信），本基准只测"渲染层调用路径
//   开销"；真实 IPC RTT（进程间序列化/主进程处理）由 e2e/perf-electron.spec.ts
//   （Electron 真实窗口）覆盖——两文件互补
// - window.api 不可用（非 dev:web 环境）时明确 skip 并说明原因
//
// 运行：pnpm test:perf
// ──────────────────────────────────────────────────────────────

import { expect, test } from '@playwright/test';

test.describe('IPC 基准：渲染层调用 RTT（mock 链路）', () => {
  test('window.api.session.list 100 次平均 < 10ms 且 p95 有界', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await expect(page.getByText('Code Agent').first()).toBeVisible({ timeout: 15_000 });

    // 明确方法探测（按已知高频方法顺序），不随机遍历
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

      // 传默认参数（session.list 的 mock 实现解构 limit/offset，无参调用会报错）
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
