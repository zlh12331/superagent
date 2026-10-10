import type { ChildProcess } from 'node:child_process';
import { logger } from './logger';

/** 强杀升级等待时长（毫秒）：SIGTERM 后多久仍未退出则 SIGKILL */
export const SIGKILL_ESCALATION_MS = 3_000;

/**
 * 终止子进程：先 SIGTERM，超时后 SIGKILL 升级
 *
 * @param child 目标子进程（可为 null/undefined，直接返回）
 * @param label 日志标签（定位是哪个服务的子进程）
 * @param timeoutMs 强杀升级等待（缺省 3s）
 */
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
