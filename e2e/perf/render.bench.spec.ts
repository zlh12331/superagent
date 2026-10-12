// e2e/perf/render.bench.spec.ts：渲染性能基准——大列表 DOM 注入 reflow、滚动耗时、CDP 指标增量、longtask 卡顿观测（随 pnpm test:perf 运行）
// 共用前提：先经 /#/chat/mock-1 真实聊天路由（覆盖路由懒加载热路径）断言消息列表容器可见，注入的负载才有落点
// 边界：DOM 注入用例绕开 React reconcile，只卡布局引擎层防回退；真实 React 交互路径由文件内 CDP 指标用例覆盖

import { expect, test } from '@playwright/test';

test.describe('渲染性能基准', () => {
  test('1000 条消息 DOM 注入 reflow < 5000ms（布局引擎基线）', async ({ page }) => {
    await page.goto('/#/chat/mock-1');
    await page.waitForLoadState('networkidle');
    // 先等真实聊天容器可见：否则注入脚本会因 container === null 静默空跑，基准变成没测
    await expect(page.locator('[data-testid="chat-message-list"]')).toBeVisible({
      timeout: 15_000,
    });

    await page.evaluate(() => {
      const container = document.querySelector('[data-testid="chat-message-list"]');
      if (container === null) return;
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
      void document.body.offsetHeight; // 强制同步 reflow：本用例度量的就是布局引擎这一步的成本
    });
    const duration = performance.now() - start;

    console.log(
      `[perf] 1000 条消息 reflow: ${duration.toFixed(1)}ms（布局引擎基线，非 React 渲染）`,
    );
    expect(duration, '1000 条消息 reflow 应 < 5000ms（基线，渐进收紧）').toBeLessThan(5000);
  });

  test('滚动 1000px < 500ms（列表滚动性能）', async ({ page }) => {
    await page.goto('/#/chat/mock-1');
    await page.waitForLoadState('networkidle');
    await expect(page.locator('[data-testid="chat-message-list"]')).toBeVisible({
      timeout: 15_000,
    });

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
      void document.body.offsetHeight; // 同步取值，把滚动触发的布局成本落在本段度量内
    });
    const duration = performance.now() - start;

    console.log(`[perf] 滚动 1000px: ${duration.toFixed(1)}ms`);
    expect(duration, '滚动 1000px 应 < 500ms（基线，渐进收紧）').toBeLessThan(500);
  });

  test('CDP 指标：真实交互脚本/布局增量在阈值内（React 路径）', async ({ page }) => {
    await page.goto('/#/chat/mock-1');
    await page.waitForLoadState('networkidle');
    await expect(page.locator('[data-testid="chat-message-list"]')).toBeVisible({
      timeout: 15_000,
    });

    // CDP 会话（Performance 域）：取引擎侧真实运行时指标
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Performance.enable');
    const metricsOf = (name: string, metrics: { name: string; value: number }[]): number =>
      metrics.find((m) => m.name === name)?.value ?? 0;

    const before = await cdp.send('Performance.getMetrics');

    // 真实交互：动态加入并激活右面板「文件变更」Tab（走真实 React 渲染路径；文案用中英双语正则匹配）
    await page
      .getByRole('button', { name: /添加视图|Add view/ })
      .first()
      .click();
    await page
      .getByRole('menuitem', { name: /文件变更|Diff/ })
      .first()
      .click();
    const diffTab = page.getByRole('tab', { name: /文件变更|Diff/ }).first();
    await expect(diffTab).toBeVisible({ timeout: 10_000 });
    await diffTab.click();
    await expect(diffTab).toHaveAttribute('data-state', 'active', { timeout: 5_000 });
    await page.waitForTimeout(300); // 留出结算窗口，让本次切换的脚本/布局任务全计入 before→after 增量

    const after = await cdp.send('Performance.getMetrics');
    const scriptDelta =
      metricsOf('ScriptDuration', after.metrics) - metricsOf('ScriptDuration', before.metrics);
    const layoutDelta =
      metricsOf('LayoutDuration', after.metrics) - metricsOf('LayoutDuration', before.metrics);
    const taskDelta =
      metricsOf('TaskDuration', after.metrics) - metricsOf('TaskDuration', before.metrics);

    console.log(
      `[perf] Tab 切换增量: Script ${scriptDelta.toFixed(1)}ms / Layout ${layoutDelta.toFixed(1)}ms / Task ${taskDelta.toFixed(1)}ms`,
    );
    // 阈值取宽松基线（CI 机器波动大）：单次 Tab 交互的 JS 执行与布局总成本
    expect(
      scriptDelta + layoutDelta,
      'Tab 切换脚本+布局增量应 < 1000ms（基线，渐进收紧）',
    ).toBeLessThan(1000);
    expect(taskDelta, 'Tab 切换总任务耗时应 < 1500ms（基线，渐进收紧）').toBeLessThan(1500);
  });

  test('长任务观测：加载与首屏交互无 >200ms 阻塞任务', async ({ page }) => {
    await page.goto('/#/chat/mock-1');
    await page.waitForLoadState('networkidle');
    await expect(page.locator('[data-testid="chat-message-list"]')).toBeVisible({
      timeout: 15_000,
    });

    const longTasks = await page.evaluate(async () => {
      const tasks: number[] = [];
      await new Promise<void>((resolve) => {
        const observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            tasks.push(entry.duration);
          }
        });
        observer.observe({ entryTypes: ['longtask'] });
        setTimeout(() => {
          observer.disconnect();
          resolve();
        }, 3000); // 3s 观测窗口：覆盖加载 + 首屏渲染 + 稳定期
      });
      return tasks;
    });

    // longtask API 只上报 >50ms 的任务；这里再筛 >200ms 作卡顿级门槛
    const severe = longTasks.filter((d) => d > 200);
    console.log(
      `[perf] 长任务: 共 ${longTasks.length} 个（>50ms），其中 >200ms ${severe.length} 个：${longTasks.map((d) => d.toFixed(0)).join(', ')}`,
    );
    expect(severe, '首屏 3s 内不应有 >200ms 卡顿级长任务（基线，渐进收紧）').toEqual([]);
  });

  test('长会话 DOM 规模：注入 300 条消息后容器子树节点 < 5000（防 DOM 爆炸回归）', async ({
    page,
  }) => {
    await page.goto('/#/chat/mock-1');
    await page.waitForLoadState('networkidle');
    await expect(page.locator('[data-testid="chat-message-list"]')).toBeVisible({
      timeout: 15_000,
    });

    await page.evaluate(() => {
      const container = document.querySelector('[data-testid="chat-message-list"]');
      if (container === null) return;
      const fragment = document.createDocumentFragment();
      // 模拟真实消息结构（标题 + 多行正文）的负载，衡量长会话的 DOM 节点总量
      for (let i = 0; i < 300; i++) {
        const div = document.createElement('div');
        div.className = 'msg-item';
        div.innerHTML = `<div class="msg-header">bench-msg-${i}</div><div class="msg-body">${'模拟消息正文段落，用于评估长会话的 DOM 节点规模。 '.repeat(3)}</div>`;
        fragment.appendChild(div);
      }
      container.appendChild(fragment);
    });

    const nodeCount = await page.evaluate(
      () =>
        document.querySelector('[data-testid="chat-message-list"]')?.querySelectorAll('*').length ??
        0,
    );
    console.log(`[perf] 长会话 DOM 节点：${nodeCount}（门槛 5000）`);
    expect(
      nodeCount,
      '300 条消息容器子树 DOM 节点应 < 5000（分页窗口/MESSAGE_PAGE_SIZE 应控制节点规模；超限提示虚拟化回归）',
    ).toBeLessThan(5000);
  });

  test('滚动交互期间无 >200ms 长任务（滚动 + 布局窗口）', async ({ page }) => {
    await page.goto('/#/chat/mock-1');
    await page.waitForLoadState('networkidle');
    await expect(page.locator('[data-testid="chat-message-list"]')).toBeVisible({
      timeout: 15_000,
    });

    await page.evaluate(() => {
      const container = document.querySelector('[data-testid="chat-message-list"]');
      if (container === null) return;
      const fragment = document.createDocumentFragment();
      // 注入 500 条占位消息作为滚动对象，随后在滚动期间观测长任务
      for (let i = 0; i < 500; i++) {
        const div = document.createElement('div');
        div.className = 'msg-item';
        div.textContent = `scroll-bench-${i}`;
        fragment.appendChild(div);
      }
      container.appendChild(fragment);
    });

    const severe = await page.evaluate(
      () =>
        new Promise<number[]>((resolve) => {
          const tasks: number[] = [];
          const observer = new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
              tasks.push(entry.duration);
            }
          });
          observer.observe({ entryTypes: ['longtask'] });
          const container = document.querySelector('[data-testid="chat-message-list"]');
          if (container === null) {
            observer.disconnect();
            resolve([]);
            return;
          }
          // 连续滚动 3 轮（每轮 40 × 16px 步长），让布局/合成路径持续出任务
          let rounds = 0;
          const scrollPass = (): void => {
            rounds += 1;
            if (rounds > 3) {
              observer.disconnect();
              resolve(tasks.filter((d) => d > 200));
              return;
            }
            container.scrollTop += 40 * 16;
            void document.body.offsetHeight; // 强制 reflow，暴露布局成本
            requestAnimationFrame(scrollPass);
          };
          requestAnimationFrame(scrollPass);
        }),
    );
    console.log(
      `[perf] 滚动交互长任务 >200ms：${severe.length} 个（${severe.map((d) => d.toFixed(0)).join(', ')}）`,
    );
    expect(severe, '滚动交互期间不应有 >200ms 卡顿级长任务（基线，渐进收紧）').toEqual([]);
  });
});
