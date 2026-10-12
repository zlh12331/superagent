import { Moon, PanelLeft, PanelRight, Search, Sun } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import type { ReactElement } from 'react';

import { BrandMark } from '@/components/common/BrandMark';
import { Button } from '@/components/ui/button';
import { useAppInfo } from '@/hooks/use-app-info';
import { useTranslation } from '@/i18n/use-translation';
import { microTransition } from '@/lib/motion';
import { cn } from '@/lib/utils';
import { useTheme } from '@/providers/ThemeProvider';
import { nextTheme } from '@/stores/persistent/settings-store';
import { UpdateIndicator } from './update-indicator';

interface TopbarProps {
  /** 侧栏是否已折叠（控制 sb-collapse-btn 图标方向） */
  sidebarCollapsed: boolean;
  /** 切换侧栏折叠态 */
  onToggleSidebar: () => void;
  /** 右面板是否已折叠（控制 rp-toggle-btn 图标方向） */
  rightPanelCollapsed: boolean;
  /** 切换右面板折叠态 */
  onToggleRightPanel: () => void;
  /** 打开命令面板（由 AppShell 通过 ⌘P 快捷键或点击按钮触发） */
  onOpenCommandPalette: () => void;
  /** 是否隐藏右面板开关（欢迎页模式右面板隐藏，按钮无意义——对齐原型 welcome-mode） */
  hideRightPanelToggle?: boolean;
}

/**
 * 顶部栏组件
 *
 * 中性表面 + 品牌标识。
 * 集成侧栏/右面板折叠开关 + 命令面板按钮(⌘P) + 设置 + 主题切换。
 */
export function Topbar({
  sidebarCollapsed,
  onToggleSidebar,
  rightPanelCollapsed,
  onToggleRightPanel,
  onOpenCommandPalette,
  hideRightPanelToggle = false,
}: TopbarProps): ReactElement {
  const { theme, resolvedTheme, setTheme } = useTheme();
  const isMac =
    typeof navigator !== 'undefined' && navigator.platform?.toLowerCase().includes('mac') === true;
  const paletteKbd = isMac ? '⌘P' : 'Ctrl+P';
  const { t } = useTranslation();
  const appInfo = useAppInfo();
  const appVersion = appInfo?.version !== undefined ? `v${appInfo.version}` : 'dev';

  return (
    <header className="topbar">
      <button
        type="button"
        className="icon-btn sb-collapse-btn"
        aria-label={sidebarCollapsed ? t('topbar.expandSidebar') : t('topbar.collapseSidebar')}
        title={sidebarCollapsed ? t('topbar.expandSidebar') : t('topbar.collapseSidebar')}
        aria-expanded={!sidebarCollapsed}
        onClick={onToggleSidebar}
      >
        <PanelLeft className="size-4" strokeWidth={1.5} />
      </button>

      <div className="brand">
        <BrandMark className="brand-mark shrink-0" />
        <span className="brand-name">
          Code Agent<span>desktop</span>
        </span>
        <span className="brand-telemetry">{appVersion}</span>
      </div>

      <div className="topbar-spacer" />

      <div className="flex items-center gap-1">
        {!hideRightPanelToggle && (
          <button
            type="button"
            className="icon-btn rp-toggle-btn"
            aria-label={rightPanelCollapsed ? t('topbar.expandPanel') : t('topbar.collapsePanel')}
            title={rightPanelCollapsed ? t('topbar.expandPanel') : t('topbar.collapsePanel')}
            aria-expanded={!rightPanelCollapsed}
            onClick={onToggleRightPanel}
          >
            <PanelRight className="size-4" strokeWidth={1.5} />
          </button>
        )}
        <Button
          variant="outline"
          size="sm"
          className="text-muted-foreground hover:bg-muted/60 hover:text-foreground gap-1.5 px-2 py-1 text-xs"
          aria-label={t('topbar.commandPalette')}
          onClick={onOpenCommandPalette}
        >
          <Search className="size-3" strokeWidth={1.5} />
          <span>{t('topbar.commandPalette')}</span>
          <kbd className="text-muted-foreground font-mono text-2xs">{paletteKbd}</kbd>
        </Button>
        <UpdateIndicator />
        <Button
          variant="ghost"
          size="icon"
          aria-label={t('topbar.toggleTheme')}
          title={t('topbar.toggleTheme')}
          onClick={() => setTheme(nextTheme(theme))}
          className={cn(
            'text-muted-foreground hover:bg-sidebar-accent',
            'hover:text-sidebar-accent-foreground size-8',
          )}
        >
          <AnimatePresence mode="wait" initial={false}>
            <motion.span
              key={resolvedTheme}
              className="inline-flex"
              initial={{ rotate: -90, scale: 0.6, opacity: 0 }}
              animate={{ rotate: 0, scale: 1, opacity: 1 }}
              exit={{ rotate: 90, scale: 0.6, opacity: 0 }}
              transition={microTransition}
            >
              {resolvedTheme === 'dark' ? (
                <Sun className="size-4" strokeWidth={1.5} />
              ) : (
                <Moon className="size-4" strokeWidth={1.5} />
              )}
            </motion.span>
          </AnimatePresence>
        </Button>
      </div>
    </header>
  );
}
