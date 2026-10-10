// close-electron.ts：Electron E2E 测试实例的关闭助手——优雅关闭，超时则强杀整棵进程树
// app.close() 偶发挂起（主进程 dispose 链未在时限内退出）会让 Playwright 报 worker teardown
// 超时——用例全过但整体退出码为 1；故这里的清理路径只负责回收进程树，不产出断言。

import { spawnSync } from 'node:child_process';

import type { ElectronApplication } from '@playwright/test';

/**
 * 优雅关闭的等待上限，超过即转入强制终止。
 * 须远低于 Playwright 的 teardown 超时预算（本套配置 60s，见 e2e/playwright.electron.config.ts），
 * 否则强杀兜底会被 Playwright 自己的超时掐断。
 */
const CLOSE_TIMEOUT_MS = 15_000;

/**
 * 关闭 Electron 测试实例：先等 app.close() 优雅退出，超时或失败则强杀进程树兜底。
 *
 * 不抛错（各失败路径均已吞掉），可在 afterEach 或 catch 分支里直接 await，不会掩盖原始错误。
 *
 * @param app electron.launch() 返回的 Playwright ElectronApplication 实例
 */
export async function closeElectronApp(app: ElectronApplication): Promise<void> {
  // 先持有子进程句柄：超时后的强杀路径要以它为根做进程树终止
  const child = app.process();
  // 与定时器竞速——close() 挂起时不能被动等到 Playwright 判 teardown 超时；
  // close 自身失败（窗口已关等）无需上报，吞掉即可
  await Promise.race([
    app.close().catch(() => undefined),
    new Promise<void>((resolve) => {
      setTimeout(resolve, CLOSE_TIMEOUT_MS);
    }),
  ]);
  // 优雅关闭超时后进程仍存活 → 强制终止。Windows 上 child.kill() 只结束主进程，
  // renderer/GPU 子进程残留会一直持有 stdio 管道，使 Playwright 等不到 'close' 事件而
  // 报 teardown 超时；taskkill /T 按进程树终止才能彻底释放。
  if (child.exitCode === null && !child.killed) {
    // 双保险：先 taskkill /T 杀整棵进程树；受限环境可能被拒，失败则走下方 child.kill() 兜底
    try {
      if (process.platform === 'win32' && child.pid !== undefined) {
        spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' });
      }
    } catch {}
    // 兜底：经自持句柄强杀主进程；进程可能恰好在 kill 前退出，抛错忽略
    try {
      child.kill('SIGKILL');
    } catch {}
  }
}
