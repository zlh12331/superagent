// src/renderer/components/layout/Topbar.tsx
// 顶部栏 · 玻璃质感 + 双 accent 发光刻度线
// ──────────────────────────────────────────────────────────────
// 设计（对齐原型 docs/prototype/prototype-v2.html）：
// - 半透明玻璃背景 + 模糊（让下方光晕透出）
// - 底部双 accent 渐变发光刻度线（青 → 蓝紫 → 青）
// - 左侧：折叠侧栏按钮 + 品牌标识（brand-mark + 名称 + 遥测带）
// - 中部：弹性 spacer（未来放命令面板入口）
// - 右侧：右面板开关 + 命令面板按钮(功能预留) + 设置 + 主题切换
// - 高度 52px（由 --aurora-topbar-h 控制）
//
// 按钮位（对齐原型）：
// - sb-collapse-btn：折叠/展开侧栏（真实功能，由 AppShell 控制）
// - rp-toggle-btn：折叠/展开右面板（真实功能，由 AppShell 控制）
// - paletteBtn：命令面板（⌘P 触发，由 AppShell 控制 open 状态）
// - 设置/主题切换：项目独有功能，保留在右侧末尾
// ──────────────────────────────────────────────────────────────

import { Moon, PanelLeft, PanelRight, Search, Settings, Sun } from 'lucide-react';
import type { ReactElement } from 'react';

import { Button } from '@/components/ui/button';
import { useTranslation } from '@/i18n/use-translation';
import { cn } from '@/lib/utils';
import { useTheme } from '@/providers/ThemeProvider';
import { useUiStore } from '@/stores/transient/ui-store';

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
 * 玻璃质感 + 双 accent 发光刻度线 + 品牌标识。
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
  const { resolvedTheme, setTheme } = useTheme();
  // 全局 UI store：设置对话框入口（Topbar / 命令面板 / 错误动作共享）
  const openSettings = useUiStore((state) => state.openSettings);
  // 快捷键展示平台化：macOS ⌘ / Windows-Linux Ctrl（与 settings-store 默认一致）
  const isMac =
    typeof navigator !== 'undefined' && navigator.platform?.toLowerCase().includes('mac') === true;
  const paletteKbd = isMac ? '⌘P' : 'Ctrl+P';
  // 本地化文案
  const { t } = useTranslation();

  return (
    <header className="topbar">
      {/* 左侧：折叠侧栏按钮 */}
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

      {/* 品牌标识（brand-mark + 名称 + 遥测带） */}
      <div className="brand">
        <span className="brand-mark" aria-hidden="true" />
        <span className="brand-name">
          Code Agent<span>desktop</span>
        </span>
        <span className="brand-telemetry">v0.1.0 · main</span>
      </div>

      {/* 中部：弹性 spacer（未来可放置命令面板入口 / 模型选择器） */}
      <div className="topbar-spacer" />

      {/* 右侧：右面板开关（欢迎页隐藏）+ 命令面板 + 设置 + 主题切换 */}
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
        {/* 命令面板文字入口（对齐原型 .palette-entry-btn：icon + 文案 + kbd，单一入口）
            始终显示（不随断点隐藏）：删除重复的图标按钮后，此入口是唯一命令面板触发点 */}
        <button
          type="button"
          className="text-muted-foreground hover:bg-muted/60 hover:text-foreground flex cursor-pointer items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition-colors"
          aria-label={t('topbar.commandPalette')}
          onClick={onOpenCommandPalette}
        >
          <Search className="size-3" strokeWidth={1.5} />
          <span>{t('topbar.commandPalette')}</span>
          <kbd className="text-muted-foreground/70 font-mono text-[9px]">{paletteKbd}</kbd>
        </button>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t('topbar.settings')}
          onClick={openSettings}
          className={cn(
            'text-muted-foreground hover:bg-sidebar-accent',
            'hover:text-sidebar-accent-foreground h-8 w-8',
          )}
        >
          <Settings className="size-4" strokeWidth={1.5} />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t('topbar.toggleTheme')}
          onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}
          className={cn(
            'text-muted-foreground hover:bg-sidebar-accent',
            'hover:text-sidebar-accent-foreground h-8 w-8',
          )}
        >
          {resolvedTheme === 'dark' ? (
            <Sun className="size-4" strokeWidth={1.5} />
          ) : (
            <Moon className="size-4" strokeWidth={1.5} />
          )}
        </Button>
      </div>
    </header>
  );
}
