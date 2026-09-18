// src/renderer/hooks/use-update.ts
// 自动更新状态读取 hook（薄封装：读 update-store + 暴露动作）
// ──────────────────────────────────────────────────────────────
// 状态来源：use-update-bridge（AppShell 唯一订阅点，见 update-store 头注释）。
// 本 hook 不再自行订阅——此前三个消费点各订阅一次同一通道，是启动期重复
// getStatus 的根因。
//
// 动作（check / cancel / install）直接走 IPC：它们不需要状态，也不应带来订阅。
// ──────────────────────────────────────────────────────────────

import type { UpdateStatusPayload } from '@code-agent/shared/renderer';

import { useUpdateStore } from '@/stores/transient/update-store';

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
 * 读取自动更新状态与动作
 *
 * @example
 * ```tsx
 * const { state, check, cancel } = useUpdate();
 * ```
 */
export function useUpdate(): UseUpdateResult {
  const state = useUpdateStore((s) => s.status);
  const fromSnapshot = useUpdateStore((s) => s.fromSnapshot);
  const lastCheckAt = useUpdateStore((s) => s.lastCheckAt);
  const markChecked = useUpdateStore((s) => s.markChecked);

  const check = async (): Promise<void> => {
    const api = window.api;
    if (api === undefined) {
      return;
    }
    await api.update.check({ manual: true });
    // 主进程在检查发起时记录时间，这里同步刷新（无需再发一次 getStatus）
    markChecked(Date.now());
  };

  const cancel = (): void => {
    const api = window.api;
    if (api === undefined) {
      return;
    }
    void api.update.cancel();
  };

  const install = (): void => {
    const api = window.api;
    if (api === undefined) {
      return;
    }
    void api.update.install();
  };

  return { state, fromSnapshot, lastCheckAt, check, cancel, install };
}
