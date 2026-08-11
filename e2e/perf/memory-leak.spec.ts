// e2e/perf/memory-leak.spec.ts
// 内存泄漏基准：长会话操作后 heap 增长（对齐桌面端长期运行稳定性）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 模拟长会话（多次打开/关闭对话框、发送/清理消息）
// - 对比操作前后 performance.memory.usedJSHeapSize 增长
// - 阈值：操作循环后 heap 增长 < 15MB（宽松基线防回退；真实泄漏检测靠持续监控）
//
// 说明：performance.memory 为 Chromium 非标准 API（Electron/Chromium 均支持）；
// 浏览器 dev server 模式下可用。
//
// 运行：pnpm test:perf
// ──────────────────────────────────────────────────────────────

import { expect, test } from '@playwright/test';

test.describe('内存基准：长会话 heap 增长', () => {
  test('反复开关设置抽屉 + 消息流后 heap 增长 < 15MB', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await expect(page.getByText('Code Agent').first()).toBeVisible({ timeout: 15_000 });

    const heapBefore = await page.evaluate(() =>
      performance.memory ? performance.memory.usedJSHeapSize : 0,
    );

    // 长会话模拟：开关设置抽屉 5 次 + 触发 3 条消息流
    for (let i = 0; i < 5; i++) {
      await page.keyboard.press('Control+,'); // 开关设置（若绑定快捷键则切换）
      await page.waitForTimeout(100);
    }
    // 消息输入 + 发送（mock 链路）
    const input = page.locator('textarea, [contenteditable="true"]').first();
    if ((await input.count()) > 0) {
      for (let i = 0; i < 3; i++) {
        await input.fill(`内存基准消息 ${i}`);
        await input.press('Enter');
        await page.waitForTimeout(200);
      }
    }

    // 强制 GC 提示（Chromium 仅建议，不保证）
    await page.evaluate(() => {
      if (window.gc) window.gc();
    });
    await page.waitForTimeout(500);

    const heapAfter = await page.evaluate(() =>
      performance.memory ? performance.memory.usedJSHeapSize : 0,
    );
    const growthMB = (heapAfter - heapBefore) / (1024 * 1024);

    console.log(
      `[perf] heap 增长: ${growthMB.toFixed(2)}MB（${(heapBefore / 1048576).toFixed(1)} → ${(heapAfter / 1048576).toFixed(1)} MB）`,
    );

    if (heapBefore > 0 && heapAfter > 0) {
      expect(growthMB, '长会话操作后 heap 增长应 < 15MB（基线，防明显泄漏回退）').toBeLessThan(15);
    }
  });
});
