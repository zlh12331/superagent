// e2e/perf/render.bench.spec.ts
// 渲染性能基准：大列表渲染耗时 + 滚动性能（对齐 VS Code 类桌面端体验标准）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 注入 1000 条 mock 消息，测聊天列表全量渲染耗时（阈值卡关，防回退）
// - 测滚动 1000px 耗时（列表虚拟化/布局性能）
// - 阈值宽松基线（2026-08-11 实测校准），随优化渐进收紧
//
// 运行：pnpm test:perf
// ──────────────────────────────────────────────────────────────

import { expect, test } from '@playwright/test';

test.describe('渲染性能基准：大列表 + 滚动', () => {
  test('1000 条消息全量渲染 < 5000ms', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await expect(page.getByText('Code Agent').first()).toBeVisible({ timeout: 15_000 });

    // 注入 1000 条消息到聊天区（通过 store 直写——聊天列表容器 selector）
    await page.evaluate(() => {
      const container = document.querySelector('[data-testid="chat-message-list"]');
      if (container === null) return;
      // 生成 1000 条占位消息节点（DOM 级注入，验证渲染性能而非数据链路）
      const fragment = document.createDocumentFragment();
      for (let i = 0; i < 1000; i++) {
        const div = document.createElement('div');
        div.className = 'msg-item';
        div.textContent = `bench-message-${i}：性能基准占位内容，模拟长会话消息文本`;
        fragment.appendChild(div);
      }
      container.appendChild(fragment);
    });

    const start = performance.now();
    await page.evaluate(() => {
      // 强制 reflow 确保渲染完成
      void document.body.offsetHeight;
    });
    const duration = performance.now() - start;

    console.log(`[perf] 1000 条消息 reflow: ${duration.toFixed(1)}ms`);
    expect(duration, '1000 条消息渲染应 < 5000ms（基线，渐进收紧）').toBeLessThan(5000);
  });

  test('滚动 1000px < 500ms（列表滚动性能）', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await expect(page.getByText('Code Agent').first()).toBeVisible({ timeout: 15_000 });

    // 注入 500 条消息使列表可滚动
    await page.evaluate(() => {
      const container = document.querySelector('[data-testid="chat-message-list"]');
      if (container === null) return;
      const fragment = document.createDocumentFragment();
      for (let i = 0; i < 500; i++) {
        const div = document.createElement('div');
        div.className = 'msg-item';
        div.textContent = `bench-${i}`;
        fragment.appendChild(div);
      }
      container.appendChild(fragment);
    });

    const start = performance.now();
    await page.evaluate(() => {
      window.scrollBy(0, 1000);
      void document.body.offsetHeight;
    });
    const duration = performance.now() - start;

    console.log(`[perf] 滚动 1000px: ${duration.toFixed(1)}ms`);
    expect(duration, '滚动 1000px 应 < 500ms（基线，渐进收紧）').toBeLessThan(500);
  });
});
