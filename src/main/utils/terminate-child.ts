import type { ChildProcess } from 'node:child_process';
import { logger } from './logger';

export const SIGKILL_ESCALATION_MS = 3_000;

export async function terminateChild(
  child: ChildProcess | null | undefined,
  label: string,
  timeoutMs: number = SIGKILL_ESCALATION_MS,
): Promise<void> {
  if (child === null || child === undefined || typeof child.exitCode === 'number') {
    return;
  }
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    child.once('exit', finish);
    try {
      child.kill();
    } catch (error: unknown) {
      logger.warn(
        { label, error: error instanceof Error ? error.message : String(error) },
        '子进程 SIGTERM 发送失败',
      );
    }
    const timer = setTimeout(() => {
      if (typeof child.exitCode !== 'number') {
        logger.warn({ label, timeoutMs }, '子进程未响应 SIGTERM，升级为 SIGKILL');
        try {
          child.kill('SIGKILL');
        } catch (error: unknown) {
          logger.warn(
            { label, error: error instanceof Error ? error.message : String(error) },
            '子进程 SIGKILL 发送失败',
          );
        }
      }
      finish();
    }, timeoutMs);
    timer.unref?.();
  });
}
