import { useTranslation } from '@/i18n/use-translation';
import { useAgentRunStore } from '@/stores/transient/agent-run-store';
import { confirm } from '@/stores/transient/confirm-dialog-store';

/**
 * 返回"重启并安装"动作
 *
 * 有回合在跑时先弹确认（安装会退出应用、中断该回合），确认后才触发安装。
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
    const api = window.api;
    if (api === undefined) {
      return;
    }
    void api.update.install();
  };
}
