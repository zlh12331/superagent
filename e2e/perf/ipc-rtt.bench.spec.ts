// e2e/perf/ipc-rtt.bench.spec.ts
// IPC 调用延迟基准：渲染层 API 调用 RTT
// ──────────────────────────────────────────────────────────────
// 职责：
// - 浏览器模式（mock-api）：window.api 调用往返延迟（渲染层调用开销 + mock 处理）
// - 阈值：100 次调用平均 < 10ms（宽松基线；真实 IPC 链路在 Electron 模式验证）
//
// 诚实标注：浏览器模式为 mock 实现（无真实进程间通信）；
// 真实 IPC RTT 受主进程负载/序列化影响，由 Electron E2E 链路间接覆盖。
// 本基准价值 = 渲染层调用路径回归检测（防意外开销）。
//
// 运行：pnpm test:perf
// ──────────────────────────────────────────────────────────────

import { expect, test } from '@playwright/test';

test.describe('IPC 基准：渲染层调用 RTT', () => {
  test('window.api 100 次调用平均 < 10ms', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await expect(page.getByText('Code Agent').first()).toBeVisible({ timeout: 15_000 });

    // 选择一组高频 IPC 调用（mock 下存在的方法），测 100 次往返
    const samples = await page.evaluate(async () => {
      const api = (window as unknown as { api?: Record<string, unknown> }).api;
      if (api === undefined) return null;
      // 优先 session:list（真实高频），回退任意 invoke 方法
      const sessionApi = api['session'] as Record<string, unknown> | undefined;
      const fn = (
        (sessionApi?.['list'] ?? Object.values(api).find((v) => typeof v === 'object'))
          ? Object.values(Object.values(api)[0] as Record<string, unknown>).find(
              (v) => typeof v === 'function',
            )
          : undefined
      ) as ((...args: unknown[]) => Promise<unknown>) | undefined;
      if (fn === undefined) return null;

      const timings: number[] = [];
      for (let i = 0; i < 100; i++) {
        const start = performance.now();
        await fn();
        timings.push(performance.now() - start);
      }
      return timings;
    });

    if (samples === null) {
      test.skip(true, '浏览器模式无 window.api（非 dev:web 环境）');
      return;
    }
    const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
    const p95 = [...samples].sort((a, b) => a - b)[Math.floor(samples.length * 0.95)];

    console.log(`[perf] IPC RTT 平均 ${avg.toFixed(2)}ms / p95 ${p95.toFixed(2)}ms`);
    expect(avg, 'window.api 调用平均 RTT 应 < 10ms（基线，渐进收紧）').toBeLessThan(10);
  });
});
