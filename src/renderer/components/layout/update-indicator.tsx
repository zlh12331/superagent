// src/renderer/components/layout/update-indicator.tsx
// 顶栏更新常驻指示（静默可见性：下载中/就绪时可见但不打扰）
// ──────────────────────────────────────────────────────────────
// 设计（docs/design/27-auto-update-spec.md §6.4）：
// - 只在"下载中"与"就绪"两态出现，其余隐藏（启动时不闪图标）
// - 下载中：旋转图标 + 百分比；点击 → 打开设置并直达"关于"面板
// - 就绪：强调色圆点 + 操作菜单（重启并安装 / 稍后）；"稍后"只在本会话隐藏该
//   版本的提示，出现更高版本后自动恢复（按版本号记忆，本地瞬态，不入库）
// - 提示文案走 aria-label/title（与顶栏既有图标按钮同惯例）
// ──────────────────────────────────────────────────────────────

import { Loader2, PackageCheck } from 'lucide-react';
import { type ReactElement, useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useUpdate } from '@/hooks/use-update';
import { useTranslation } from '@/i18n/use-translation';
import { cn } from '@/lib/utils';
import { useUiStore } from '@/stores/transient/ui-store';

/**
 * 顶栏更新指示
 *
 * @example
 * ```tsx
 * // Topbar 右侧按钮簇内挂载（全局单实例）
 * <UpdateIndicator />
 * ```
 */
export function UpdateIndicator(): ReactElement | null {
  const { state, install } = useUpdate();
  const openSettings = useUiStore((s) => s.openSettings);
  const { t } = useTranslation();
  // 本次会话已"稍后"的版本（local 瞬态：重启后恢复提醒，换版本自动失效）
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(null);

  const phase = state?.phase;
  const version = state?.version ?? '';
  const iconButtonClass = cn(
    'text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground size-8',
  );

  if (phase === 'downloading') {
    const percent = Math.round(state?.progress ?? 0);
    const label = t('update.indicatorDownloading', { percent: String(percent) });
    return (
      <Button
        variant="ghost"
        size="icon"
        className={cn(iconButtonClass, 'gap-0 text-[10px] tabular-nums')}
        aria-label={label}
        title={label}
        onClick={() => openSettings('about')}
      >
        <Loader2 className="size-4 animate-spin" strokeWidth={1.5} />
      </Button>
    );
  }

  if (phase === 'downloaded' && version !== dismissedVersion) {
    const label = t('update.indicatorReady', { version });
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className={cn(iconButtonClass, 'relative')}
            aria-label={label}
            title={label}
          >
            <PackageCheck className="text-accent-text size-4" strokeWidth={1.5} />
            <span
              className="bg-accent absolute top-1.5 right-1.5 size-1.5 rounded-full"
              aria-hidden
            />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={install}>{t('update.restartNow')}</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setDismissedVersion(version)}>
            {t('update.later')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  return null;
}
