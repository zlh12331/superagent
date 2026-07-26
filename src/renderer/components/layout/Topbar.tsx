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

import { Command, Moon, PanelLeft, PanelRight, Settings, Sun } from 'lucide-react';
import { memo, type ReactElement, useState } from 'react';

import { SettingsDialog } from '@/components/settings/SettingsDialog';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useTheme } from '@/providers/ThemeProvider';

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
}

/**
 * 顶部栏组件
 *
 * 玻璃质感 + 双 accent 发光刻度线 + 品牌标识。
 * 集成侧栏/右面板折叠开关 + 命令面板按钮(⌘P) + 设置 + 主题切换。
 */
export const Topbar = memo(function Topbar({
  sidebarCollapsed,
  onToggleSidebar,
  rightPanelCollapsed,
  onToggleRightPanel,
  onOpenCommandPalette,
}: TopbarProps): ReactElement {
  const { resolvedTheme, setTheme } = useTheme();
  const [settingsOpen, setSettingsOpen] = useState(false);

  return (
    <header className="topbar">
      {/* 左侧：折叠侧栏按钮 */}
      <button
        type="button"
        className="icon-btn sb-collapse-btn"
        aria-label={sidebarCollapsed ? '展开侧栏' : '折叠侧栏'}
        title={sidebarCollapsed ? '展开侧栏' : '折叠侧栏'}
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

      {/* 右侧：右面板开关 + 命令面板(预留) + 设置 + 主题切换 */}
      <div className="flex items-center gap-1">
        <button
          type="button"
          className="icon-btn rp-toggle-btn"
          aria-label={rightPanelCollapsed ? '展开右面板' : '折叠右面板'}
          title={rightPanelCollapsed ? '展开右面板' : '折叠右面板'}
          aria-expanded={!rightPanelCollapsed}
          onClick={onToggleRightPanel}
        >
          <PanelRight className="size-4" strokeWidth={1.5} />
        </button>
        <button
          type="button"
          className="icon-btn"
          aria-label="命令面板"
          title="命令面板 (⌘P)"
          onClick={onOpenCommandPalette}
        >
          <Command className="size-4" strokeWidth={1.5} />
        </button>
        <Button
          variant="ghost"
          size="icon"
          aria-label="设置"
          onClick={() => setSettingsOpen(true)}
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
          aria-label="切换主题"
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

      {/* 设置对话框（受控，Topbar 持有开关状态）
          延迟挂载：仅 open=true 时渲染，避免首屏 mount Dialog 组件树 + IPC 查询 hooks */}
      {settingsOpen && <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />}
    </header>
  );
});
