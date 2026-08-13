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
// - 集成 useApprovalBridge（审批推送订阅）+ useToolBridge + useTerminalBridge：订阅工具/终端 IPC 事件
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
import { useLocation, useNavigate } from 'react-router';

import { AskDialog } from '@/components/agent/ask-dialog';
import { CommandPalette } from '@/components/common/CommandPalette';
import { DialogHost } from '@/components/common/DialogHost';
import { SectionErrorBoundary } from '@/components/common/SectionErrorBoundary';
import { ShortcutHelpDialog } from '@/components/common/ShortcutHelpDialog';
import { UpdateNotice } from '@/components/common/UpdateNotice';
import { FuzzySearchDialog } from '@/components/file-tree/fuzzy-search-dialog';
import { SettingsDialog } from '@/components/settings/SettingsDialog';
import { useAgentAskBridge } from '@/hooks/use-agent-ask-bridge';
import { useAgentBridge } from '@/hooks/use-agent-bridge';
import { useApprovalBridge } from '@/hooks/use-approval-bridge';
import { useKeyboardShortcuts } from '@/hooks/use-keyboard-shortcuts';
import { useLayoutBreakpoint } from '@/hooks/use-layout-breakpoint';
import { useProtocolCheck } from '@/hooks/use-protocol-check';
import { useTerminalBridge } from '@/hooks/use-terminal-bridge';
import { useToolBridge } from '@/hooks/use-tool-bridge';
import { useTranslation } from '@/i18n/use-translation';
import { DRAFT_SESSION_ID, ROUTES } from '@/lib/constants';
import { cn } from '@/lib/utils';
import { useActiveSessionStore } from '@/stores/persistent/sessions-store';
import { nextTheme, useSettingsStore } from '@/stores/persistent/settings-store';
import { useFileTreeStore } from '@/stores/transient/file-tree-store';
import { useFileViewerStore } from '@/stores/transient/file-viewer-store';
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
  // 审批桥接：订阅 IPC 推送（就地内联展示在 ChatPanel，弹窗已移除）
  useApprovalBridge();
  // Agent 提问桥接：订阅 ask 事件 → agent-ask-store（AskDialog 渲染）
  useAgentAskBridge();

  // 工具调用桥接：订阅 agent:tool:call / agent:tool:result IPC 事件
  useToolBridge();
  // Agent 生命周期桥接：回合结束 → invalidate 缓存 + 清理 L2 缓冲 + usage 累积
  useAgentBridge();

  // 终端桥接：订阅 terminal:event:output / terminal:event:exit IPC 事件
  useTerminalBridge();

  // IPC 协议版本校验：主进程/渲染层版本错配时提示重启（P0 契约加固）
  useProtocolCheck();

  // L2 Zustand：激活会话 id（用于关联 DevPanel 中的终端实例）
  const activeSessionId = useActiveSessionStore((state) => state.activeSessionId);
  const devPanelSessionId = activeSessionId ?? DRAFT_SESSION_ID;
  // P3 修复：Git 面板仓库路径绑定激活会话 workingDir（file-tree rootPath），
  // 无激活会话时传空串 → GitPanel 禁用查询（此前硬编码 f:\TraeProjects\1）
  const workingDir = useFileTreeStore((state) => state.rootPath);

  // L2 Zustand：欢迎页模式（控制 .view-chat.welcome-mode class）
  // 欢迎页模式下隐藏右面板 + 右分隔线，主区域改为居中 flex 容器
  const isWelcomeMode = useWelcomeStore((state) => state.isWelcomeMode);

  // 拖拽分隔线状态 — 初始值对齐原型 clamp() 行为，按视口宽度计算
  const [sidebarWidth, setSidebarWidth] = useState(computeInitialSidebarWidth);
  const [rightPanelWidth, setRightPanelWidth] = useState(computeInitialRightPanelWidth);

  // 折叠态（统一状态源：ui-store——快捷键 / 命令面板 / Topbar / 断点联动共用）
  const sidebarCollapsed = useUiStore((s) => s.sidebarCollapsed);
  const rightPanelCollapsed = useUiStore((s) => s.rightPanelCollapsed);
  const sidebarManual = useUiStore((s) => s.sidebarManual);
  const rightPanelManual = useUiStore((s) => s.rightPanelManual);
  const setSidebarCollapsed = useUiStore((s) => s.setSidebarCollapsed);
  const setRightPanelCollapsed = useUiStore((s) => s.setRightPanelCollapsed);
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);
  const toggleRightPanel = useUiStore((s) => s.toggleRightPanel);

  // 响应式断点联动：窄屏自动折叠面板（对齐原型 @media 行为）
  // <1200px：右面板自动隐藏；<900px：侧栏自动隐藏；宽屏自动恢复
  // 仅当用户未手动覆盖时才跟随断点（手动展开不被 resize 强制折叠）
  const { isCompact, isNarrow } = useLayoutBreakpoint();

  // 全局设置对话框开关（useUiStore）
  const settingsOpen = useUiStore((s) => s.settingsOpen);
  const closeSettings = useUiStore((s) => s.closeSettings);
  useEffect(() => {
    if (!rightPanelManual) {
      setRightPanelCollapsed(isCompact);
    }
  }, [isCompact, rightPanelManual, setRightPanelCollapsed]);
  useEffect(() => {
    if (!sidebarManual) {
      setSidebarCollapsed(isNarrow);
    }
  }, [isNarrow, sidebarManual, setSidebarCollapsed]);

  const [draggingSide, setDraggingSide] = useState<ResizerSide | null>(null);

  // 命令面板 open 状态（多入口：⌘P/Ctrl+K 快捷键 / Topbar / 错误动作；集中到 ui-store）
  const paletteOpen = useUiStore((s) => s.paletteOpen);
  const openPalette = useUiStore((s) => s.openPalette);
  const closePalette = useUiStore((s) => s.closePalette);

  // 快捷键帮助对话框（'?' 键触发）
  const [shortcutHelpOpen, setShortcutHelpOpen] = useState(false);
  // 文件模糊搜索对话框（⌘F 触发，对齐参考项目 FuzzySearchDialog）
  const [fuzzyOpen, setFuzzyOpen] = useState(false);
  // 文件查看器入口（FuzzySearchDialog 选中文件时打开）
  const openFileViewer = useFileViewerStore((s) => s.openFile);

  // 路由：聊天页显示返回按钮（对齐原型 back-btn）
  // hash 路由（生产 file:// 兼容）下 pathname 恒为 '/，需同时检查 hash
  const navigate = useNavigate();
  const location = useLocation();
  const isChatRoute = location.pathname.startsWith('/chat/') || location.hash.startsWith('#/chat/');

  const setTheme = useSettingsStore((s) => s.setTheme);
  const theme = useSettingsStore((s) => s.theme);
  // 实验功能：扫描线视觉叠加（settings.experimental.scanlines → .scanlines-overlay）
  const scanlines = useSettingsStore((s) => s.experimental.scanlines);
  const enterWelcomeMode = useWelcomeStore((s) => s.enterWelcomeMode);
  // 全局 UI store：设置对话框入口（快捷键 / 错误动作 / Topbar / 命令面板共享）
  const openSettings = useUiStore((s) => s.openSettings);

  // 折叠态切换：统一走 ui-store 的 toggle（置位 manual，断点自动折叠不再覆盖手动意图）
  // 供快捷键（Ctrl+B/1、Ctrl+J/2）、Topbar、命令面板共用
  const handleToggleSidebar = toggleSidebar;
  const handleToggleRightPanel = toggleRightPanel;

  useKeyboardShortcuts({
    onCommandPalette: () => openPalette(),
    // 全局保存：转发给文件查看器实例（编辑态打开时已注册 handleSave 到 store）；
    // 无查看器 / 非编辑态时 no-op——修复此前空绑定死代码（真实保存被困在查看器本地 keydown）
    onSaveFile: () => {
      useFileViewerStore.getState().requestSave();
    },
    // ⌘F 文件模糊搜索（对齐参考项目：Ctrl/Cmd + F 触发 FuzzySearchDialog）
    onSearchFile: () => setFuzzyOpen(true),
    onToggleTheme: () => {
      setTheme(nextTheme(theme));
    },
    onOpenSettings: openSettings,
    // 与 Sidebar handleNewChat 保持一致：欢迎页（内部清激活会话）+ 跳转首页
    //（此前仅 enterWelcomeMode，URL 停留当前路由）
    onNewSession: () => {
      enterWelcomeMode(null);
      navigate(ROUTES.home);
    },
    onOpenShortcutHelp: () => setShortcutHelpOpen(true),
    // 面板切换（Ctrl+B/1、Ctrl+J/2；对齐参考项目 toggle-left/right-sidebar 快捷键）
    onToggleSidebar: handleToggleSidebar,
    onToggleRightPanel: handleToggleRightPanel,
    // 打开终端（Ctrl+`；对齐参考项目 codex.openTerminal：展开右面板 + 切终端 tab）
    onOpenTerminal: () => {
      useUiStore.getState().setRightPanelCollapsed(false);
      useUiStore.getState().setDevPanelTab('terminal');
    },
    // 返回上一视图（Alt+←；对齐参考项目 backBtn：聊天页回首页，与 Topbar 返回按钮一致）
    onBack: () => {
      if (isChatRoute) {
        navigate('/');
      }
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
        {/* 列 1：侧边栏（组件级错误边界：单组件报错局部降级，不拖垮整个 App） */}
        <SectionErrorBoundary name="sidebar">
          <Sidebar />
        </SectionErrorBoundary>

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

        {/* 列 3：主内容区（thread 背景：多层光晕氛围 + 纸张噪点纹理）
            组件级错误边界：聊天区单组件报错局部降级，不整页崩溃 */}
        <main id="main-content" className="thread-bg paper-texture">
          <SectionErrorBoundary name="main-content">{children}</SectionErrorBoundary>
        </main>

        {/* 列 4：右分隔线（可拖拽调整右面板宽度；欢迎页也保留——右面板常驻） */}
        {!rightPanelCollapsed && (
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
            <SectionErrorBoundary name="right-panel" resetKeys={[devPanelSessionId]}>
              <DevPanel
                sessionId={devPanelSessionId}
                gitRepoPath={workingDir ?? ''}
                className="h-full border-t-0"
              />
            </SectionErrorBoundary>
          )}
        </aside>
      </div>

      {/* 命令式确认/输入对话框（confirm()/prompt()，照搬参考项目） */}
      <DialogHost />
      {/* 审批：就地内联展示（inline-approval-card 在 ChatPanel）——
          移除全局 ApprovalDialog 弹窗：对齐原型 .card.paused 就地审批，
          避免与内联卡双 UI 重复（同一审批两处呈现） */}
      <AskDialog />

      {/* 文件查看器已改为右面板"文件"tab（FileViewerPanel——侧边栏树点击文件显示内容） */}

      {/* 设置对话框：根级渲染，由 useUiStore 控制（Topbar / 命令面板 / 错误动作共用入口） */}
      <SettingsDialog open={settingsOpen} onOpenChange={closeSettings} />

      {/* 命令面板（⌘P）：根级渲染，受控 open 状态 */}
      <CommandPalette open={paletteOpen} onOpenChange={closePalette} />
      {/* 文件模糊搜索（⌘F）：文件 + 会话统一搜索（对齐参考项目 FuzzySearchDialog） */}
      <FuzzySearchDialog
        open={fuzzyOpen}
        onClose={() => setFuzzyOpen(false)}
        onSelect={openFileViewer}
      />
      {/* 快捷键帮助对话框（'?' 触发） */}
      <ShortcutHelpDialog open={shortcutHelpOpen} onClose={() => setShortcutHelpOpen(false)} />
      {/* 自动更新提示（事件驱动 toast，无 DOM） */}
      <UpdateNotice />
      {/* 扫描线视觉叠加（实验功能开关）：纯视觉层，不拦截任何交互 */}
      {scanlines && <div className="scanlines-overlay" aria-hidden="true" />}
    </div>
  );
}
