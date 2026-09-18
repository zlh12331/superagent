// src/renderer/hooks/use-install-update.ts
// 重启并安装入口（危险操作统一语义：有运行中回合时先确认）
// ──────────────────────────────────────────────────────────────
// 为什么抽成 hook：关于面板与顶栏更新指示是两个独立入口，但"安装会重启应用、
// 中断正在跑的回合"这一语义必须一致（项目规范：危险操作统一走 confirm()
// store，禁止各入口自行弹窗，避免双份实现漂移）。
//
// 为什么不复用 useUpdate().install：那会让本 hook 再挂一份状态订阅（getStatus
// 请求 + subscribeStatus），同一组件内出现两份更新状态订阅；本 hook 只需要
// "触发安装"这一个动作，直接调 IPC 即可。
// ──────────────────────────────────────────────────────────────

import { useTranslation } from '@/i18n/use-translation';
import { useAgentRunStore } from '@/stores/transient/agent-run-store';
import { confirm } from '@/stores/transient/confirm-dialog-store';

/**
 * 返回"重启并安装"动作
 *
 * 有回合在跑时先弹确认（重启会中断该回合），确认后才触发安装。
 *
 * @example
 * ```tsx
 * const install = useInstallUpdate();
 * <Button onClick={() => void install()}>重启并安装</Button>
 * ```
 */
export function useInstallUpdate(): () => Promise<void> {
  const running = useAgentRunStore((s) => s.running);
  const { t } = useTranslation();

  return async (): Promise<void> => {
    if (running) {
      const confirmed = await confirm({
        title: t('update.confirmRestartTitle'),
        message: t('update.confirmRestartMessage'),
        confirmText: t('settings.aboutInstallRestart'),
        danger: true,
      });
      if (!confirmed) {
        return;
      }
    }
    // 浏览器模式（window.api 缺失）下为 no-op
    const api = window.api;
    if (api === undefined) {
      return;
    }
    void api.update.install();
  };
}
