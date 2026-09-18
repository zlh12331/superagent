// src/renderer/hooks/use-update.ts
// 自动更新状态 hook（订阅主进程 update:event:status + 挂载时取状态快照）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 订阅自动更新状态推送（检查中/发现新版/下载中/就绪/已取消/错误）
// - 挂载时经 update:getStatus 拉取主进程快照，修复窗口重载后状态丢失
//   （事件通道只在事件发生时推送，新订阅者会错过历史）
// - 暴露手动检查 / 取消下载 / 安装重启操作
//
// 快照与事件必须区分：fromSnapshot 为真表示当前状态来自回放，提示类消费方
// （UpdateNotice）不得据其弹 toast，否则窗口重载会重复弹已提示过的通知。
// ──────────────────────────────────────────────────────────────

import type { UpdateStatusPayload } from '@code-agent/shared/renderer';
import { useEffect, useState } from 'react';
import { unwrap } from '@/lib/ipc';

/** useUpdate 返回值 */
export interface UseUpdateResult {
  /** 最新更新状态（无任何事件与快照时为 null） */
  readonly state: UpdateStatusPayload | null;
  /** 当前状态是否仅来自挂载快照（回放，不应触发提示类副作用） */
  readonly fromSnapshot: boolean;
  /** 上次检查发起时间（毫秒时间戳；本次会话与快照均无记录时为 null） */
  readonly lastCheckAt: number | null;
  /** 手动触发更新检查 */
  readonly check: () => Promise<void>;
  /** 取消在途下载（无在途下载时为空操作） */
  readonly cancel: () => void;
  /** 安装已下载的更新并重启 */
  readonly install: () => void;
}

/**
 * 订阅自动更新状态
 *
 * @example
 * ```tsx
 * const { state, check, cancel, install } = useUpdate();
 * ```
 */
export function useUpdate(): UseUpdateResult {
  const [liveState, setLiveState] = useState<UpdateStatusPayload | null>(null);
  const [snapshotState, setSnapshotState] = useState<UpdateStatusPayload | null>(null);
  const [lastCheckAt, setLastCheckAt] = useState<number | null>(null);

  // 浏览器模式（window.api 缺失）跳过订阅：与 use-agent-bridge 等守卫模式对齐
  useEffect(() => {
    const api = window.api;
    if (api === undefined) {
      return;
    }
    let active = true;
    // 先拉快照（重载恢复），再订阅事件；事件到达后以事件态为准
    void api.update
      .getStatus()
      .then((res) => {
        const status = unwrap(res);
        if (active && status.snapshot !== null) {
          setSnapshotState(status.snapshot);
        }
        if (active && typeof status.lastCheckAt === 'number') {
          setLastCheckAt(status.lastCheckAt);
        }
      })
      .catch(() => {
        // 快照读取失败静默：后续状态仍由事件通道推送
      });
    const unsubscribe = api.update.subscribeStatus(setLiveState);
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const check = async (): Promise<void> => {
    const api = window.api;
    if (api === undefined) {
      return;
    }
    await api.update.check({ manual: true });
    // 主进程在检查发起时记录时间，这里同步刷新（无需再发一次 getStatus）
    setLastCheckAt(Date.now());
  };

  const cancel = (): void => {
    void window.api?.update.cancel();
  };

  const install = (): void => {
    void window.api?.update.install();
  };

  return {
    state: liveState ?? snapshotState,
    fromSnapshot: liveState === null && snapshotState !== null,
    lastCheckAt,
    check,
    cancel,
    install,
  };
}
