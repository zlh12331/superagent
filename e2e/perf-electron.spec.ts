// e2e/perf-electron.spec.ts
// 真实 Electron IPC 性能基准（dev 模式，真实进程间通信）
// ──────────────────────────────────────────────────────────────
// 职责（对齐 e2e/perf/ 的 mock 链路基准——本文件是真实链路，两者互补）：
// - 真实 invoke RTT：session.list 100 次采样（median/p95/max）
// - 大 payload：file.read 读取 500KB 文件（真实序列化 + 传输成本）
// - 事件推送吞吐：主进程 send → 渲染层 subscribe 计数（无丢失 + 吞吐）
// - 启动分段耗时（仅报告；生产构建由 smoke.prod.spec.ts 卡关）
//
// 运行：pnpm test:perf:electron（前置：dev server + main/preload 构建，与 test:e2e:electron 相同）
// 阈值策略：宽松基线（本地 IPC 往返 ~1-5ms，500KB 序列化 ~10-50ms）
// ──────────────────────────────────────────────────────────────

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ElectronApplication, Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { _electron as electron } from 'playwright';

import { closeElectronApp } from './helpers/close-electron';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const MAIN_ENTRY = join(__dirname, '..', 'out', 'main', 'index.js');
const E2E_USER_DATA = join(__dirname, '..', '.e2e-user-data');
/** 大 payload 测试文件（500KB，测试进程预写入） */
const PAYLOAD_PATH = join(E2E_USER_DATA, 'perf-payload.txt');
/** 事件推送通道：agent:stream:part（chat 域已从定义表移除）
 * 渲染层仅在 sendMessages 期间订阅该通道，空闲态无业务 hook → 测纯 IPC 分发吞吐。
 * 注意：terminal:event:output 有业务 hook（terminal-store→xterm），其全链路吞吐受
 * 渲染层路径限制（实测 ~1-6 事件/s，见 12-performance-spec 待优化项），不适合测 IPC 层 */
const EVENT_CHANNEL = 'agent:stream:part';
/** 事件吞吐用例的推送数量 */
const EVENT_COUNT = 200;
/** 测试实例独立调试端口（避免与 dev 实例的 9222 冲突，CDP 连不上会 launch 超时） */
const DEBUG_PORT = '9223';

/** 测试实例启动环境（统一注入独立调试端口） */
function testEnv(): Record<string, string | undefined> {
  return {
    ...process.env,
    NODE_ENV: 'development',
    ELECTRON_RENDERER_URL: 'http://localhost:5173',
    CODE_AGENT_USER_DATA: E2E_USER_DATA,
    CODE_AGENT_DEBUG_PORT: DEBUG_PORT,
    // 关窗协商豁免：E2E 无头场景跳过"运行中回合确认"模态框（防测试卡死）
    CODE_AGENT_SKIP_CLOSE_GUARD: '1',
  };
}

/** 等待主窗口（非 devtools://）：DevTools 可能先于主窗口恢复，需循环等待 */
async function waitForMainWindow(app: ElectronApplication): Promise<Page> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const existing = app.windows().find((w) => !w.url().startsWith('devtools://'));
    if (existing !== undefined) {
      return existing;
    }
    // 等待任意新窗口出现后再检查（超时 2s 继续轮询）
    const winPromise = app.waitForEvent('window');
    await Promise.race([winPromise, new Promise((resolve) => setTimeout(resolve, 2000))]);
  }
  throw new Error('等待主窗口超时（20s）：仅出现 DevTools 窗口');
}

/** 启动 Electron（dev 模式，与 electron.spec.ts 同构） */
async function launchElectron(): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    args: [MAIN_ENTRY],
    env: testEnv(),
  });

  try {
    const page = await waitForMainWindow(app);
    await page.waitForLoadState('domcontentloaded');
    return { app, page };
  } catch (err) {
    // 启动半途失败必须回收已拉起的实例，否则残留进程导致 worker teardown 超时
    await closeElectronApp(app);
    throw err;
  }
}

/** 多次采样取中位数 */
function medianOf(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

test.describe('真实 Electron IPC 性能基准', () => {
  test.beforeAll(() => {
    // 预写 500KB 大 payload 文件（真实文件，file.read 读取）
    mkdirSync(E2E_USER_DATA, { recursive: true });
    writeFileSync(PAYLOAD_PATH, 'x'.repeat(500 * 1024), 'utf8');
  });

  test('真实 invoke RTT：session.list 100 次 median < 20ms / p95 < 50ms', async () => {
    const { app, page } = await launchElectron();
    try {
      await expect(page.getByText('Code Agent').first()).toBeVisible({ timeout: 15_000 });

      const timings = await page.evaluate(async () => {
        const samples: number[] = [];
        for (let i = 0; i < 100; i += 1) {
          const start = performance.now();
          const res = await window.api.session.list({ limit: 50, offset: 0 });
          if ('error' in res) throw new Error('session.list 失败');
          samples.push(performance.now() - start);
        }
        return samples;
      });

      const median = medianOf(timings);
      const sorted = [...timings].sort((a, b) => a - b);
      const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
      console.log(
        `[perf:electron] invoke RTT median ${median.toFixed(2)}ms / p95 ${p95.toFixed(2)}ms / max ${(sorted[sorted.length - 1] ?? 0).toFixed(2)}ms`,
      );
      expect(median, '真实 IPC RTT 中位数应 < 20ms（基线，渐进收紧）').toBeLessThan(20);
      expect(p95, '真实 IPC RTT p95 应 < 50ms（防长尾）').toBeLessThan(50);
    } finally {
      await closeElectronApp(app);
    }
  });

  test('大 payload：file.read 500KB 10 次平均 < 200ms', async () => {
    const { app, page } = await launchElectron();
    try {
      await expect(page.getByText('Code Agent').first()).toBeVisible({ timeout: 15_000 });

      // P1 路径收口适配：file.read 经 confineToWorkspace fail-closed（边界 = 会话
      // workingDir 并集）。payload 在 .e2e-user-data 下，需先经公共 API 创建一个
      // 以该目录为 workingDir 的会话，将 payload 目录登记进边界（TTL 2s 缓存过期后生效）。
      await page.evaluate(async (dir) => {
        const res = await window.api.session.create({ workingDir: dir, title: 'perf-payload' });
        if ('error' in res) {
          throw new Error(`session.create 失败：${String(res.error?.message)}`);
        }
      }, E2E_USER_DATA);
      await page.waitForTimeout(2200);

      const result = await page.evaluate(async (payloadPath) => {
        // 预热一次（编码检测缓存/模块加载不计入）
        await window.api.file.read({ path: payloadPath });
        const samples: number[] = [];
        let sizeBytes = 0;
        for (let i = 0; i < 10; i += 1) {
          const start = performance.now();
          const res = await window.api.file.read({ path: payloadPath });
          if ('error' in res) throw new Error('file.read 失败');
          sizeBytes = (res.data.content as string).length;
          samples.push(performance.now() - start);
        }
        return { samples, sizeBytes };
      }, PAYLOAD_PATH);

      const avg = result.samples.reduce((a, b) => a + b, 0) / result.samples.length;
      console.log(
        `[perf:electron] file.read ${(result.sizeBytes / 1024).toFixed(0)}KB 平均 ${avg.toFixed(1)}ms（含编码检测 + 序列化 + 传输）`,
      );
      expect(result.sizeBytes, '500KB 文件内容应完整返回（防空转）').toBeGreaterThan(400 * 1024);
      expect(avg, '500KB 大 payload 往返应 < 300ms（基线含编码检测，渐进收紧）').toBeLessThan(300);
    } finally {
      await closeElectronApp(app);
    }
  });

  test(`事件推送吞吐：主进程 send ${EVENT_COUNT} 事件无丢失`, async () => {
    const { app, page } = await launchElectron();
    try {
      await expect(page.getByRole('main').first()).toBeAttached({ timeout: 15_000 });
      // 等待页面稳定（DevTools 恢复可能触发主窗口重载，重载会让 evaluate 的 page 失效）
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(1500);

      // 渲染层预注册订阅（真实 subscribe 链路）
      const receivePromise = page.evaluate(
        (count) =>
          new Promise<{ received: number; elapsed: number }>((resolve) => {
            let received = 0;
            const start = performance.now();
            const off = window.api.agent.subscribeStreamPart(() => {
              received += 1;
              if (received >= count) {
                off();
                resolve({ received, elapsed: performance.now() - start });
              }
            });
            // 兜底超时（防挂死）
            setTimeout(() => {
              off();
              resolve({ received, elapsed: performance.now() - start });
            }, 30_000);
          }),
        EVENT_COUNT,
      );

      // 屏障：确保渲染层订阅 evaluate 已完成（Playwright evaluate 同页 FIFO）
      // 否则主进程 send 先于订阅注册，第一批事件丢失（实测稳定丢 20 个/批）
      await page.evaluate(() => 1);

      // 主进程真实推送（经 webContents.send → ipcRenderer → preload subscribe）
      // 注意：窗口顺序不保证主窗口在前（DevTools 可能先创建），需按 URL 过滤；
      // 分批发送（20 个/批 + 20ms 间隔）模拟真实流式节流——同步灌 500 个会压垮渲染进程
      await app.evaluate(
        async ({ BrowserWindow }, { channel, count, batchSize }) => {
          const wc = BrowserWindow.getAllWindows().find(
            (w) => !w.webContents.getURL().startsWith('devtools://'),
          )?.webContents;
          if (wc === undefined) return;
          const payload = { terminalId: 'perf-bench', data: 'y'.repeat(64) };
          for (let sent = 0; sent < count; sent += batchSize) {
            for (let i = 0; i < batchSize && sent + i < count; i += 1) {
              wc.send(channel, payload);
            }
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
        },
        { channel: EVENT_CHANNEL, count: EVENT_COUNT, batchSize: 20 },
      );

      const result = await receivePromise;
      const throughput = result.received / (result.elapsed / 1000);
      console.log(
        `[perf:electron] 事件推送 ${result.received}/${EVENT_COUNT} 条，耗时 ${result.elapsed.toFixed(0)}ms，吞吐 ${throughput.toFixed(0)} 事件/s（纯 IPC 分发，无渲染路径）`,
      );
      expect(result.received, `${EVENT_COUNT} 条事件必须全部到达（无丢失）`).toBe(EVENT_COUNT);
      expect(throughput, '纯 IPC 事件分发吞吐应 ≥ 500 事件/s（基线，渐进收紧）').toBeGreaterThan(
        500,
      );
    } finally {
      await closeElectronApp(app);
    }
  });

  test('并发 IPC：20 路并行 invoke p95 < 100ms（争用延迟）', async () => {
    const { app, page } = await launchElectron();
    try {
      await expect(page.getByRole('main').first()).toBeAttached({ timeout: 15_000 });
      await page.waitForTimeout(1500);

      // 20 路并发 session.list（模拟多面板同时拉数据；真实 IPC 争用场景）
      const rounds: number[] = [];
      for (let round = 0; round < 5; round += 1) {
        const start = performance.now();
        await page.evaluate(async () => {
          await Promise.all(
            Array.from({ length: 20 }, () => window.api.session.list({ limit: 50, offset: 0 })),
          );
        });
        rounds.push((performance.now() - start) / 20); // 单路均摊
      }
      const sorted = [...rounds].sort((a, b) => a - b);
      const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
      console.log(
        `[perf:electron] 并发 20 路 invoke 单路均摊: p95 ${p95.toFixed(2)}ms / max ${(sorted[sorted.length - 1] ?? 0).toFixed(2)}ms`,
      );
      expect(p95, '并发争用下单路 invoke 均摊 p95 应 < 100ms（基线，渐进收紧）').toBeLessThan(100);
    } finally {
      await closeElectronApp(app);
    }
  });

  test('启动分段耗时（仅报告：launch → firstWindow → domcontentloaded）', async () => {
    const launchStart = performance.now();
    const app = await electron.launch({
      args: [MAIN_ENTRY],
      env: testEnv(),
    });
    const launchElapsed = performance.now() - launchStart;

    const windowStart = performance.now();
    const page = await waitForMainWindow(app);
    const windowElapsed = performance.now() - windowStart;

    const loadStart = performance.now();
    await page.waitForLoadState('domcontentloaded');
    const loadElapsed = performance.now() - loadStart;

    console.log(
      `[perf:electron] 启动分段（dev 模式，仅报告）：launch ${launchElapsed.toFixed(0)}ms / firstWindow ${windowElapsed.toFixed(0)}ms / domcontentloaded ${loadElapsed.toFixed(0)}ms`,
    );
    await closeElectronApp(app);
  });
});
