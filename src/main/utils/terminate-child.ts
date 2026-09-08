// src/main/utils/terminate-child.ts
// 子进程优雅终止 + 强杀升级（跨服务复用）
// ──────────────────────────────────────────────────────────────
// 背景（2026-09-08 可靠性修复）：
// 多处 dispose 只发一次 SIGTERM（lsp-client / terminal / search / codebase），
// 子进程若忽略该信号就永远残留（Electron 进程可能延迟退出、端口/句柄不释放）。
// memory-hub-service 与 run-command.tool 各自实现了「SIGTERM → 3s SIGKILL」
// 的正确范式，本模块把它抽成单一实现，避免各服务重复且口径不一。
//
// 设计：
// - 幂等：进程已退出立即返回
// - 不抛错：kill 失败只记日志（dispose 路径不应因清理失败中断）
// - 可注入 kill 函数（测试用）
// ──────────────────────────────────────────────────────────────

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
  // exitCode 语义：null = 尚未退出；number = 已退出；undefined（部分实现/测试替身）
  // 视为「未知」而非「已退出」——此前用 `!== null` 判断会把 undefined 当已退出，
  // 导致进程根本不被 kill。
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
