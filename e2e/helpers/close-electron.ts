// e2e/helpers/close-electron.ts
// Electron 测试实例关闭助手
// ──────────────────────────────────────────────────────────────
// 背景（2026-08-27 实测）：app.close() 偶发挂起（主进程个别服务
// dispose 链未在时限内退出），触发 Playwright "Worker teardown
// timeout of 60000ms exceeded"——用例全过但整体退出码为 1。
//
// 策略：优雅关闭 + 超时强制终止兜底。关闭超时只影响清理速度，
// 不影响用例断言结果；强杀保证测试进程树必然回收。
// ──────────────────────────────────────────────────────────────

import { spawnSync } from 'node:child_process';

import type { ElectronApplication } from '@playwright/test';

/** 优雅关闭超时（超过则强制终止进程树） */
const CLOSE_TIMEOUT_MS = 15_000;

/**
 * 关闭 Electron 测试实例（优雅 → 强制兜底）
 *
 * @param app Playwright ElectronApplication 实例
 */
export async function closeElectronApp(app: ElectronApplication): Promise<void> {
  const child = app.process();
  await Promise.race([
    app.close().catch(() => undefined),
    new Promise<void>((resolve) => {
      setTimeout(resolve, CLOSE_TIMEOUT_MS);
    }),
  ]);
  // 进程仍存活（优雅关闭超时）→ 强制终止整个进程树。
  // 注：Windows 上 child.kill() 只杀主进程，renderer/GPU 子进程残留会持有
  // stdio 管道，导致 Playwright 等待 'close' 事件而 teardown 超时；
  // taskkill /T 按进程树终止才能彻底释放。
  if (child.exitCode === null && !child.killed) {
    // 双保险：taskkill /T 杀整棵进程树（正常环境）；受限环境 taskkill 可能被拒，
    // 再用 child.kill() 经自持句柄终止主进程兜底。
    try {
      if (process.platform === 'win32' && child.pid !== undefined) {
        spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' });
      }
    } catch {
      // 忽略，走下方兜底
    }
    try {
      child.kill('SIGKILL');
    } catch {
      // 进程可能恰好在 kill 前退出
    }
  }
}
