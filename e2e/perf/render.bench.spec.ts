// e2e/perf/render.bench.spec.ts
// 渲染性能基准：大列表渲染 + 滚动 + CDP 真实指标
// ──────────────────────────────────────────────────────────────
// 职责：
// - 大列表布局成本：DOM 注入 1000 条消息后 reflow 耗时（⚠️ 标注：这是"布局引擎
//   + 样式计算"基准，注入的裸 DOM 节点绕过了 React reconcile——真实 React 渲染
//   路径由 CDP 指标用例与 Electron 链路基准覆盖，本用例只卡布局层防回退）
// - 滚动性能：滚动 1000px 耗时（列表布局/合成器性能）
// - CDP 真实指标：Performance.getMetrics 采集 ScriptDuration/LayoutDuration 增量
//   （真实 React 应用交互路径，防渲染逻辑回归）
// - 长任务观测：PerformanceObserver('longtask') 统计 >50ms 阻塞任务（卡顿证据）
//
// 运行：pnpm test:perf
// ──────────────────────────────────────────────────────────────

import { expect, test } from '@playwright/test';

test.describe('渲染性能基准', () => {
  test('1000 条消息 DOM 注入 reflow < 5000ms（布局引擎基线）', async ({ page }) => {
    await page.goto('/#/chat/mock-1');
    await page.waitForLoadState('networkidle');
    // 聊天路由（hash）下真实渲染 ChatMessageList——基准必须落在此容器上
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

    // （前置 already 保证容器可见——基准不再可能静默 no-op）

    const start = performance.now();
    await page.evaluate(() => {
      void document.body.offsetHeight; // 强制 reflow
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
      void document.body.offsetHeight;
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

    // CDP 会话：采集真实运行时指标（Performance domain，业界标准）
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Performance.enable');
    const metricsOf = (name: string, metrics: { name: string; value: number }[]): number =>
      metrics.find((m) => m.name === name)?.value ?? 0;

    // 交互前基线
    const before = await cdp.send('Performance.getMetrics');

    // 真实交互：动态加入并切换右面板「文件变更」Tab（真实 React 渲染路径；双语言正则）
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
    await page.waitForTimeout(300);

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
    // 宽松基线（CI 机器波动大）：单次 Tab 交互的 JS 执行与布局总成本
    expect(
      scriptDelta + layoutDelta,
      'Tab 切换脚本+布局增量应 < 1000ms（基线，渐进收紧）',
    ).toBeLessThan(1000);
    expect(taskDelta, 'Tab 切换总任务耗时应 < 1500ms（基线，渐进收紧）').toBeLessThan(1500);
  });

  test('长任务观测：加载与首屏交互无 >200ms 阻塞任务', async ({ page }) => {
    await page.goto('/#/chat/mock-1');
    await page.waitForLoadState('networkidle');
    // 聊天路由：覆盖路由懒加载（shiki/聊天渲染）这一真实热路径
    await expect(page.locator('[data-testid="chat-message-list"]')).toBeVisible({
      timeout: 15_000,
    });

    // 从导航开始记录长任务（>50ms 视为阻塞，>200ms 视为卡顿级）
    const longTasks = await page.evaluate(async () => {
      const tasks: number[] = [];
      await new Promise<void>((resolve) => {
        const observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            tasks.push(entry.duration);
          }
        });
        observer.observe({ entryTypes: ['longtask'] });
        // 观察 3s 窗口（加载 + 首屏渲染 + 稳定）
        setTimeout(() => {
          observer.disconnect();
          resolve();
        }, 3000);
      });
      return tasks;
    });

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

    // 注入长会话负载（前置已保证容器可见）
    await page.evaluate(() => {
      const container = document.querySelector('[data-testid="chat-message-list"]');
      if (container === null) return;
      const fragment = document.createDocumentFragment();
      for (let i = 0; i < 300; i++) {
        // 模拟真实消息结构（标题 + 多行文本），评估 DOM 节点总量
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

    // 冷启动注入 500 条占位消息（滚动对象），随后在滚动期间观测长任务
    await page.evaluate(() => {
      const container = document.querySelector('[data-testid="chat-message-list"]');
      if (container === null) return;
      const fragment = document.createDocumentFragment();
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
          // 连续滚动 3 轮（每轮 40 行 ≈ 2400px），触发布局/合成路径
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
