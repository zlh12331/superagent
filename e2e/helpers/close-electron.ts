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
  if (child.exitCode === null && !child.killed) {
    try {
      if (process.platform === 'win32' && child.pid !== undefined) {
        spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' });
      }
    } catch {}
    try {
      child.kill('SIGKILL');
    } catch {}
  }
}
