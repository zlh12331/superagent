// src/renderer/components/layout/AppShell.tsx
// 应用外壳 · 组装层（初始宽度计算纯函数移至 layout-utils）
// ──────────────────────────────
// 拆分背景（2026-08 重构）：原文件 352 行，纯函数提取为独立文件
// ──────────────────────────────

// src/renderer/components/layout/AppShell.tsx
// 应用主布局容器 · 对齐原型布局（三段式 grid）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 三段式 grid：Topbar（52px）/ 主体（Sidebar + resizer + 内容 + resizer + 右面板）
// - 可拖拽分隔线：左右两条 resizer，鼠标拖拽调整 sidebar/rightPanel 宽度
// - 侧栏折叠：sb-collapsed 态，grid 第一列塌缩为 0
// - 右面板折叠：crp-collapsed 态，grid 第五列塌缩为 0
// - 右面板渲染 DevPanel（Terminal + Git + Logs + Metrics + Inspector）
// - 集成 ApprovalDialog：通过 useApprovalBridge 订阅 IPC 审批推送
// - 集成 useToolBridge + useTerminalBridge：订阅工具/终端 IPC 事件
//
// 布局参考：docs/prototype/prototype-v2.html
// - .app（grid 两行：topbar + body）
// - .view-chat（grid 五列：sidebar | resizer | main | resizer | right-panel）
// - .resizer（可拖拽分隔线，hover 显示 accent 光带）
// - .chat-right-panel（右面板，可折叠）
// - .sb-collapsed / .crp-collapsed（折叠态 class）
// ──────────────────────────────────────────────────────────────

import { ChevronRight } from 'lucide-react';
import { type ReactElement, type ReactNode, useCallback, useEffect, useRef, useState } from 'react';

import { ApprovalDialog } from '@/components/agent/ApprovalDialog';
import { CommandPalette } from '@/components/common/CommandPalette';
import { UpdateNotice } from '@/components/common/UpdateNotice';
import { FileViewerDialog } from '@/components/file-tree/FileViewerDialog';
import { SettingsDialog } from '@/components/settings/SettingsDialog';
import { useAgentBridge } from '@/hooks/use-agent-bridge';
import { useApprovalBridge } from '@/hooks/use-approval-bridge';
import { useKeyboardShortcuts } from '@/hooks/use-keyboard-shortcuts';
import { useLayoutBreakpoint } from '@/hooks/use-layout-breakpoint';
import { useTerminalBridge } from '@/hooks/use-terminal-bridge';
import { useToolBridge } from '@/hooks/use-tool-bridge';
import { useTranslation } from '@/i18n/use-translation';
import { DEFAULT_GIT_REPO_PATH, DRAFT_SESSION_ID } from '@/lib/constants';
import { cn } from '@/lib/utils';
import { useActiveSessionStore } from '@/stores/persistent/sessions-store';
import { useSettingsStore } from '@/stores/persistent/settings-store';
import { useUiStore } from '@/stores/transient/ui-store';
import { useWelcomeStore } from '@/stores/transient/welcome-store';

import { DevPanel } from './DevPanel';
import {
  computeInitialRightPanelWidth,
  computeInitialSidebarWidth,
  RIGHT_PANEL_WIDTH_MAX,
  RIGHT_PANEL_WIDTH_MIN,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN,
} from './layout-utils';
import { Sidebar } from './Sidebar';
import { Topbar } from './Topbar';

interface AppShellProps {
  /** 主内容区（通常由 RouterProvider 通过 <Outlet /> 传入） */
  children: ReactNode;
}
type ResizerSide = 'left' | 'right';

export function AppShell({ children }: AppShellProps): ReactElement {
  // 本地化文案
  const { t } = useTranslation();
  // 审批桥接：订阅 IPC 推送 + 提供 respondApproval 方法
  const { respondApproval } = useApprovalBridge();

  // 工具调用桥接：订阅 agent:tool:call / agent:tool:result IPC 事件
  useToolBridge();
  // Agent 生命周期桥接：回合结束 → invalidate 缓存 + 清理 L2 缓冲 + usage 累积
  useAgentBridge();

  // 终端桥接：订阅 terminal:event:output / terminal:event:exit IPC 事件
  useTerminalBridge();

  // L2 Zustand：激活会话 id（用于关联 DevPanel 中的终端实例）
  const activeSessionId = useActiveSessionStore((state) => state.activeSessionId);
  const devPanelSessionId = activeSessionId ?? DRAFT_SESSION_ID;

  // L2 Zustand：欢迎页模式（控制 .view-chat.welcome-mode class）
  // 欢迎页模式下隐藏右面板 + 右分隔线，主区域改为居中 flex 容器
  const isWelcomeMode = useWelcomeStore((state) => state.isWelcomeMode);

  // 拖拽分隔线状态 — 初始值对齐原型 clamp() 行为，按视口宽度计算
  const [sidebarWidth, setSidebarWidth] = useState(computeInitialSidebarWidth);
  const [rightPanelWidth, setRightPanelWidth] = useState(computeInitialRightPanelWidth);

  // 折叠态
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [rightPanelCollapsed, setRightPanelCollapsed] = useState(false);

  // 响应式断点联动：窄屏自动折叠面板（对齐原型 @media 行为）
  // <1200px：右面板自动隐藏；<900px：侧栏自动隐藏；宽屏自动恢复
  const { isCompact, isNarrow } = useLayoutBreakpoint();

  // 全局设置对话框开关（useUiStore）
  const settingsOpen = useUiStore((s) => s.settingsOpen);
  const closeSettings = useUiStore((s) => s.closeSettings);
  useEffect(() => {
    setRightPanelCollapsed(isCompact);
  }, [isCompact]);
  useEffect(() => {
    setSidebarCollapsed(isNarrow);
  }, [isNarrow]);

  const [draggingSide, setDraggingSide] = useState<ResizerSide | null>(null);

  // 命令面板 open 状态（由 ⌘P 快捷键或 Topbar paletteBtn 触发）
  const [paletteOpen, setPaletteOpen] = useState(false);
  const openPalette = useCallback(() => setPaletteOpen(true), []);

  const setTheme = useSettingsStore((s) => s.setTheme);
  const theme = useSettingsStore((s) => s.theme);
  const enterWelcomeMode = useWelcomeStore((s) => s.enterWelcomeMode);
  // 全局 UI store：设置对话框入口（快捷键 / 错误动作 / Topbar / 命令面板共享）
  const openSettings = useUiStore((s) => s.openSettings);

  useKeyboardShortcuts({
    onCommandPalette: () => setPaletteOpen(true),
    onSaveFile: () => {},
    onSearchFile: () => setPaletteOpen(true),
    onToggleTheme: () => {
      const nextTheme = theme === 'dark' ? 'light' : theme === 'light' ? 'system' : 'dark';
      setTheme(nextTheme);
    },
    onOpenSettings: openSettings,
    onNewSession: () => {
      enterWelcomeMode();
    },
  });

  // 拖拽起始信息（ref 避免重渲染）
  const dragStartRef = useRef<{ side: ResizerSide; startX: number; startWidth: number } | null>(
    null,
  );

  // 同步 CSS 变量到根元素（供 .view-chat 的 grid-template-columns 使用）
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty('--aurora-sidebar-w', sidebarCollapsed ? '0px' : `${sidebarWidth}px`);
    root.style.setProperty(
      '--aurora-right-panel-w',
      rightPanelCollapsed ? '0px' : `${rightPanelWidth}px`,
    );
  }, [sidebarWidth, rightPanelWidth, sidebarCollapsed, rightPanelCollapsed]);

  // 拖拽 mousemove 处理函数
  const handleMouseMove = useCallback((event: MouseEvent) => {
    const dragStart = dragStartRef.current;
    if (dragStart === null) return;

    const delta = event.clientX - dragStart.startX;
    if (dragStart.side === 'left') {
      const newWidth = dragStart.startWidth + delta;
      const clamped = Math.max(SIDEBAR_WIDTH_MIN, Math.min(SIDEBAR_WIDTH_MAX, newWidth));
      setSidebarWidth(clamped);
    } else {
      const newWidth = dragStart.startWidth - delta;
      const clamped = Math.max(RIGHT_PANEL_WIDTH_MIN, Math.min(RIGHT_PANEL_WIDTH_MAX, newWidth));
      setRightPanelWidth(clamped);
    }
  }, []);

  // 拖拽 mouseup 处理函数
  const handleMouseUp = useCallback(() => {
    document.body.classList.remove('resizing');
    document.removeEventListener('mousemove', handleMouseMove);
    document.removeEventListener('mouseup', handleMouseUp);
    dragStartRef.current = null;
    setDraggingSide(null);
  }, [handleMouseMove]);

  // 拖拽启动：mousedown 注册监听
  const handleMouseDown = useCallback(
    (side: ResizerSide) => (event: React.MouseEvent<HTMLHRElement>) => {
      event.preventDefault();
      const startWidth = side === 'left' ? sidebarWidth : rightPanelWidth;
      dragStartRef.current = { side, startX: event.clientX, startWidth };
      setDraggingSide(side);
      document.body.classList.add('resizing');
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
    },
    [sidebarWidth, rightPanelWidth, handleMouseMove, handleMouseUp],
  );

  // 卸载时清理监听（防御性）
  useEffect(() => {
    return () => {
      document.body.classList.remove('resizing');
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [handleMouseMove, handleMouseUp]);

  // 折叠态切换回调
  const handleToggleSidebar = useCallback(() => {
    setSidebarCollapsed((prev) => !prev);
  }, []);
  const handleToggleRightPanel = useCallback(() => {
    setRightPanelCollapsed((prev) => !prev);
  }, []);

  return (
    <div className="bg-background text-foreground app font-sans">
      {/* WCAG 2.4.1 Bypass Blocks：跳过导航链接 */}
      <a
        href="#main-content"
        className="bg-background text-foreground sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded focus:px-3 focus:py-2 focus:text-sm focus:shadow-md"
      >
        {t('common.skipToContent')}
      </a>
      <Topbar
        sidebarCollapsed={sidebarCollapsed}
        onToggleSidebar={handleToggleSidebar}
        rightPanelCollapsed={rightPanelCollapsed}
        onToggleRightPanel={handleToggleRightPanel}
        onOpenCommandPalette={openPalette}
      />
      <div
        className={cn(
          'view-chat',
          sidebarCollapsed && 'sb-collapsed',
          rightPanelCollapsed && 'crp-collapsed',
          isWelcomeMode && 'welcome-mode',
        )}
      >
        {/* 列 1：侧边栏 */}
        <Sidebar />

        {/* 列 2：左分隔线（可拖拽调整 sidebar 宽度） */}
        {!sidebarCollapsed && (
          <hr
            aria-orientation="vertical"
            aria-label={t('common.sidebarResizer')}
            aria-valuenow={sidebarWidth}
            aria-valuemin={SIDEBAR_WIDTH_MIN}
            aria-valuemax={SIDEBAR_WIDTH_MAX}
            tabIndex={0}
            className={cn('resizer resizer-left', draggingSide === 'left' && 'dragging')}
            onMouseDown={handleMouseDown('left')}
          />
        )}

        {/* 列 3：主内容区（thread 背景：多层光晕氛围 + 纸张噪点纹理） */}
        <main id="main-content" className="thread-bg paper-texture">
          {children}
        </main>

        {/* 列 4：右分隔线（可拖拽调整右面板宽度）
            欢迎页模式下不渲染（无右面板可调） */}
        {!rightPanelCollapsed && !isWelcomeMode && (
          <hr
            aria-orientation="vertical"
            aria-label={t('common.panelResizer')}
            aria-valuenow={rightPanelWidth}
            aria-valuemin={RIGHT_PANEL_WIDTH_MIN}
            aria-valuemax={RIGHT_PANEL_WIDTH_MAX}
            tabIndex={0}
            className={cn('resizer resizer-right', draggingSide === 'right' && 'dragging')}
            onMouseDown={handleMouseDown('right')}
          />
        )}

        {/* 列 5：右面板（DevPanel：Terminal + Git + Logs + Metrics + Inspector） */}
        <aside className="chat-right-panel" aria-label={t('common.rightPanel')}>
          {/* 折叠按钮：点击切换 rightPanelCollapsed */}
          <button
            type="button"
            className="crp-collapse-btn"
            onClick={handleToggleRightPanel}
            aria-label={
              rightPanelCollapsed ? t('common.expandRightPanel') : t('common.collapseRightPanel')
            }
            aria-expanded={!rightPanelCollapsed}
          >
            <ChevronRight className="size-3" strokeWidth={1.5} />
          </button>
          {!rightPanelCollapsed && (
            <DevPanel
              sessionId={devPanelSessionId}
              gitRepoPath={DEFAULT_GIT_REPO_PATH}
              className="h-full border-t-0"
            />
          )}
        </aside>
      </div>

      {/* 全局审批对话框：根级渲染，覆盖在所有内容之上 */}
      <ApprovalDialog onRespond={respondApproval} />

      {/* 文件查看器对话框：根级渲染，由 useFileViewerStore 控制 */}
      <FileViewerDialog />

      {/* 设置对话框：根级渲染，由 useUiStore 控制（Topbar / 命令面板 / 错误动作共用入口） */}
      <SettingsDialog open={settingsOpen} onOpenChange={closeSettings} />

      {/* 命令面板（⌘P）：根级渲染，受控 open 状态 */}
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
      {/* 自动更新提示（事件驱动 toast，无 DOM） */}
      <UpdateNotice />
    </div>
  );
}
