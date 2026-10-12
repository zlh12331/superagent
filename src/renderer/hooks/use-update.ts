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
