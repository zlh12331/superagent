// terminate-child.ts：子进程优雅终止——先 SIGTERM 给清理窗口，超时升级 SIGKILL（防孤儿进程）
import type { ChildProcess } from 'node:child_process';
import { logger } from './logger';

// SIGTERM→SIGKILL 升级宽限：3 秒足够大多数子进程收尾，又不至于让退出链久等
export const SIGKILL_ESCALATION_MS = 3_000;

/**
 * 终止子进程：已退出直接返回；SIGTERM 后 timeoutMs 内未退则升级 SIGKILL
 *
 * SIGKILL 后不等待真正退出（kill 是异步信号）——调用方需要强保证时自行再等 exit 事件
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
    timer.unref?.(); // 计时器不阻止主进程退出（退出链中杀子进程不该反过来拖住退出）
  });
}
