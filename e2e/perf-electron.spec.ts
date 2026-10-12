// e2e/perf-electron.spec.ts：真实 Electron 进程间 IPC 性能基准（dev 模式，非 mock 链路）
// 覆盖 invoke RTT / 500KB 大 payload 往返 / 事件推送吞吐（零丢失）/ 启动分段（仅报告），运行 pnpm test:perf:electron；
// 边界：阈值是渐进收紧的宽松基线，不测渲染——渲染与内存基准在 e2e/perf/（mock 链路，两者互补），生产构建的启动门槛由 smoke.prod.spec.ts 卡关。

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
 * 渲染层仅在 sendMessages 期间订阅该通道，空闲态无业务 hook → 量到的是纯 IPC 分发吞吐。
 * 不用 terminal:event:output：它有渲染层业务 hook（terminal-store→xterm），量到的是业务链路而非 IPC 分发 */
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
    // 关窗协商豁免：E2E 场景跳过「运行中回合确认」模态框，防测试卡死
    CODE_AGENT_SKIP_CLOSE_GUARD: '1',
    // 记忆引擎预热豁免：预热会拉起子进程且抢 CPU，污染启动分段与吞吐时序
    CODE_AGENT_SKIP_MEMORY_PREWARM: '1',
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
    // waitForEvent 可能等不到目标窗口（新窗口事件迟迟不来，或只等来 DevTools）→ 2s 到期重扫窗口列表
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

/** 多次采样取中位数（抗 GC/系统抖动，避免单次尖峰决定判定） */
function medianOf(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

test.describe('真实 Electron IPC 性能基准', () => {
  test.beforeAll(() => {
    // 落真实文件（而非页内构造字符串），让 file.read 走完整磁盘读 + 编码检测路径
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
      // p95 上限按机型/负载特征分档，median 保持严格（真正的回归信号在 median）：
      // - macOS Intel runner（macos-26-intel）：实测 p95 102~165ms，同批次其他平台仅 11~15ms，属机型真实特征 → 250ms 档；
      // - 其余均为共享 hosted runner（宿主负载不可控）：p95 在 ~25ms（通过）与 >50ms（失败）间两倍抖动、median 恒 1~3ms
      //   （2026-09/10 实测，发版批次翻车重跑即过）→ 统一 150ms 档，不分架构碎片化
      const isMacIntel = process.platform === 'darwin' && process.arch === 'x64';
      const p95Limit = isMacIntel ? 250 : 150;
      expect(p95, `真实 IPC RTT p95 应 < ${p95Limit}ms（防长尾）`).toBeLessThan(p95Limit);
    } finally {
      await closeElectronApp(app);
    }
  });

  test('大 payload：file.read 500KB 10 次平均 < 200ms', async () => {
    const { app, page } = await launchElectron();
    try {
      await expect(page.getByText('Code Agent').first()).toBeVisible({ timeout: 15_000 });

      // file.read 经 confineToWorkspace fail-closed（边界 = 会话 workingDir 集合）。payload 在 .e2e-user-data 下，
      // 须先建一个以该目录为 workingDir 的会话（公共 API），把 payload 目录登记进边界
      await page.evaluate(async (dir) => {
        const res = await window.api.session.create({ workingDir: dir, title: 'perf-payload' });
        if ('error' in res) {
          throw new Error(`session.create 失败：${String(res.error?.message)}`);
        }
      }, E2E_USER_DATA);
      // 边界走 2s TTL 缓存（src/main/ipc/file.handler.ts 的 ROOTS_TTL_MS），等其过期后新会话才生效
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
      // 等页面稳定：DevTools 恢复可能触发主窗口重载，重载会让已取得的 page 失效
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(1500);

      // 渲染层预注册订阅（走真实 preload subscribe 链路）
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
            // 兜底超时（防事件丢失时用例挂死）
            setTimeout(() => {
              off();
              resolve({ received, elapsed: performance.now() - start });
            }, 30_000);
          }),
        EVENT_COUNT,
      );

      // 屏障：确保渲染层订阅已注册（Playwright evaluate 同页 FIFO）——否则主进程 send 先于订阅注册，
      // 第一批事件丢失（分批 20 个/批时实测稳定丢 20 个/批）
      await page.evaluate(() => 1);

      // 主进程真实推送（webContents.send → ipcRenderer → preload subscribe）；
      // 窗口顺序不保证主窗口在前（DevTools 可能先创建）→ 按 URL 过滤；
      // 分批 + 20ms 间隔模拟真实流式节流：一次性同步灌入会压垮渲染进程
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

      // 20 路并发 session.list：模拟多面板同时拉数据的真实 IPC 争用场景
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
