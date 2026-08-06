// src/renderer/hooks/use-update.ts
// 自动更新状态 hook（订阅主进程 update:event:status 事件）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 订阅自动更新状态推送（检查中/可更新/下载中/已就绪/错误）
// - 暴露手动检查与安装重启操作
// ──────────────────────────────────────────────────────────────

import type { UpdateStatusPayload } from '@code-agent/shared/renderer';
import { useCallback, useEffect, useState } from 'react';

/** useUpdate 返回值 */
export interface UseUpdateResult {
  /** 最新更新状态（无推送时为 null） */
  readonly state: UpdateStatusPayload | null;
  /** 手动触发更新检查 */
  readonly check: () => Promise<void>;
  /** 安装已下载的更新并重启 */
  readonly install: () => void;
}

/**
 * 订阅自动更新状态
 *
 * 挂载时注册事件监听（返回 unsubscribe，卸载自动清理）。
 *
 * @example
 * ```tsx
 * const { state, check, install } = useUpdate();
 * ```
 */
export function useUpdate(): UseUpdateResult {
  const [state, setState] = useState<UpdateStatusPayload | null>(null);

  // 订阅主进程更新状态推送（事件订阅返回 unsubscribe）
  // 浏览器模式（window.api 缺失）跳过订阅：与 use-agent-bridge 等守卫模式对齐
  useEffect(() => {
    if (typeof window === 'undefined' || window.api === undefined) return;
    return window.api.update.subscribeStatus(setState);
  }, []);

  const check = useCallback(async (): Promise<void> => {
    if (typeof window === 'undefined' || window.api === undefined) return;
    await window.api.update.check({ manual: true });
  }, []);

  const install = useCallback((): void => {
    if (typeof window === 'undefined' || window.api === undefined) return;
    void window.api.update.install();
  }, []);

  return { state, check, install };
}
