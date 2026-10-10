import { DEFAULT_ZOOM, stepZoom } from '@code-agent/shared/renderer';
import { MotionConfig } from 'motion/react';
import { lazy, type ReactElement, type ReactNode, Suspense, useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { AskDialog } from '@/components/agent/ask-dialog';
import { DialogHost } from '@/components/common/DialogHost';
import { SectionErrorBoundary } from '@/components/common/SectionErrorBoundary';
import { UpdateNotice } from '@/components/common/UpdateNotice';
import { useAgentAskBridge } from '@/hooks/use-agent-ask-bridge';
import { useAgentBridge } from '@/hooks/use-agent-bridge';
import { useApprovalBridge } from '@/hooks/use-approval-bridge';
import { useDeepLink } from '@/hooks/use-deep-link';
import { useEditorCodeStyle } from '@/hooks/use-editor-code-style';
import { useInvalidationBridge } from '@/hooks/use-invalidation-bridge';
import { useKeyboardShortcuts } from '@/hooks/use-keyboard-shortcuts';
import { useLayoutBreakpoint } from '@/hooks/use-layout-breakpoint';
import { useProtocolCheck } from '@/hooks/use-protocol-check';
import { useResizablePanels } from '@/hooks/use-resizable-panels';
import { useSettingsBridge } from '@/hooks/use-settings-bridge';
import { useTerminalBridge } from '@/hooks/use-terminal-bridge';
import { useToolBridge } from '@/hooks/use-tool-bridge';
import { useUpdateBridge } from '@/hooks/use-update-bridge';
import { useActiveWorkingDir } from '@/hooks/use-working-dir';
import { useZoomEffect } from '@/hooks/use-zoom-effect';
import { useTranslation } from '@/i18n/use-translation';
import { DRAFT_SESSION_ID, ROUTES } from '@/lib/constants';
import { cn } from '@/lib/utils';
import { useActiveSessionStore } from '@/stores/persistent/sessions-store';
import { nextTheme, useSettingsStore } from '@/stores/persistent/settings-store';
import { useFileViewerStore } from '@/stores/transient/file-viewer-store';
import { useUiStore } from '@/stores/transient/ui-store';
import { useWelcomeStore } from '@/stores/transient/welcome-store';

import {
  RIGHT_PANEL_WIDTH_MAX,
  RIGHT_PANEL_WIDTH_MIN,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN,
} from './layout-utils';
import { Sidebar } from './Sidebar';
import { Topbar } from './Topbar';

const LazySettingsDialog = lazy(async () => {
  const mod = await import('@/components/settings/SettingsDialog');
  return { default: mod.SettingsDialog };
});
const LazyCommandPalette = lazy(async () => {
  const mod = await import('@/components/common/CommandPalette');
  return { default: mod.CommandPalette };
});
const LazyFuzzySearchDialog = lazy(async () => {
  const mod = await import('@/components/file-tree/fuzzy-search-dialog');
  return { default: mod.FuzzySearchDialog };
});
const LazyShortcutHelpDialog = lazy(async () => {
  const mod = await import('@/components/common/ShortcutHelpDialog');
  return { default: mod.ShortcutHelpDialog };
});
const LazyDevPanel = lazy(async () => {
  const mod = await import('./DevPanel');
  return { default: mod.DevPanel };
});

interface AppShellProps {
  /** 主内容区（通常由 RouterProvider 通过 <Outlet /> 传入） */
  children: ReactNode;
}

/**
 * 应用根布局：Topbar + Sidebar + 主内容区 + 底部 DevPanel，挂载全部
 * IPC 桥接 hook（审批/提问/工具流/回合结束失效）与全局对话框宿主
 */
export function AppShell({ children }: AppShellProps): ReactElement {
  const { t } = useTranslation();
  useApprovalBridge();
  useAgentAskBridge();

  useToolBridge();
  useAgentBridge();
  useInvalidationBridge();

  useTerminalBridge();

  useUpdateBridge();

  useSettingsBridge();

  useProtocolCheck();
  useDeepLink();

  const activeSessionId = useActiveSessionStore((state) => state.activeSessionId);
  const devPanelSessionId = activeSessionId ?? DRAFT_SESSION_ID;
  const workingDir = useActiveWorkingDir();

  const isWelcomeMode = useWelcomeStore((state) => state.isWelcomeMode);

  const sidebarCollapsed = useUiStore((s) => s.sidebarCollapsed);
  const rightPanelCollapsed = useUiStore((s) => s.rightPanelCollapsed);
  const sidebarManual = useUiStore((s) => s.sidebarManual);
  const rightPanelManual = useUiStore((s) => s.rightPanelManual);
  const setSidebarCollapsed = useUiStore((s) => s.setSidebarCollapsed);
  const setRightPanelCollapsed = useUiStore((s) => s.setRightPanelCollapsed);
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);
  const toggleRightPanel = useUiStore((s) => s.toggleRightPanel);

  const { isCompact, isNarrow } = useLayoutBreakpoint();

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

  const paletteOpen = useUiStore((s) => s.paletteOpen);
  const openPalette = useUiStore((s) => s.openPalette);
  const closePalette = useUiStore((s) => s.closePalette);

  const shortcutHelpOpen = useUiStore((s) => s.shortcutHelpOpen);
  const closeShortcutHelp = useUiStore((s) => s.closeShortcutHelp);
  const openShortcutHelp = useUiStore((s) => s.openShortcutHelp);
  const [fuzzyOpen, setFuzzyOpen] = useState(false);
  const openFileViewer = useFileViewerStore((s) => s.openFile);

  const navigate = useNavigate();
  const location = useLocation();
  const isChatRoute = location.pathname.startsWith('/chat/') || location.hash.startsWith('#/chat/');

  const setTheme = useSettingsStore((s) => s.setTheme);
  const theme = useSettingsStore((s) => s.theme);
  const scanlines = useSettingsStore((s) => s.experimental.scanlines);
  const enterWelcomeMode = useWelcomeStore((s) => s.enterWelcomeMode);
  const openSettings = useUiStore((s) => s.openSettings);

  const handleToggleSidebar = toggleSidebar;
  const handleToggleRightPanel = toggleRightPanel;

  useKeyboardShortcuts({
    onCommandPalette: () => openPalette(),
    onSaveFile: () => {
      useFileViewerStore.getState().requestSave();
    },
    onSearchFile: () => setFuzzyOpen(true),
    onToggleTheme: () => {
      setTheme(nextTheme(theme));
    },
    onOpenSettings: openSettings,
    onNewSession: () => {
      enterWelcomeMode(null);
      navigate(ROUTES.home);
    },
    onOpenShortcutHelp: openShortcutHelp,
    onToggleSidebar: handleToggleSidebar,
    onToggleRightPanel: handleToggleRightPanel,
    onOpenTerminal: () => {
      useUiStore.getState().setRightPanelCollapsed(false);
      useUiStore.getState().setDevPanelTab('terminal');
    },
    onBack: () => {
      if (isChatRoute) {
        navigate('/');
      }
    },
    onZoomIn: () => {
      const { appearance, updateAppearance } = useSettingsStore.getState();
      updateAppearance({ zoom: stepZoom(appearance.zoom, 1) });
    },
    onZoomOut: () => {
      const { appearance, updateAppearance } = useSettingsStore.getState();
      updateAppearance({ zoom: stepZoom(appearance.zoom, -1) });
    },
    onZoomReset: () => {
      useSettingsStore.getState().updateAppearance({ zoom: DEFAULT_ZOOM });
    },
  });

  useZoomEffect();

  useEditorCodeStyle();

  const { sidebarWidth, rightPanelWidth, draggingSide, onResizerMouseDown, onResizerKeyDown } =
    useResizablePanels(sidebarCollapsed, rightPanelCollapsed);

  return (
    <MotionConfig reducedMotion="user">
      <div className="bg-background text-foreground app font-sans">
        <a
          href="#main-content"
          className="bg-background text-foreground sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-boundary focus:rounded focus:px-3 focus:py-2 focus:text-sm focus:shadow-md"
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
          <SectionErrorBoundary name="sidebar">
            <Sidebar />
          </SectionErrorBoundary>

          {!sidebarCollapsed && (
            <hr
              aria-orientation="vertical"
              aria-label={t('common.sidebarResizer')}
              aria-valuenow={sidebarWidth}
              aria-valuemin={SIDEBAR_WIDTH_MIN}
              aria-valuemax={SIDEBAR_WIDTH_MAX}
              tabIndex={0}
              className={cn('resizer resizer-left', draggingSide === 'left' && 'dragging')}
              onMouseDown={onResizerMouseDown('left')}
              onKeyDown={onResizerKeyDown('left')}
            />
          )}

          <main id="main-content" className="thread-bg paper-texture">
            <SectionErrorBoundary name="main-content">{children}</SectionErrorBoundary>
          </main>

          {!rightPanelCollapsed && (
            <hr
              aria-orientation="vertical"
              aria-label={t('common.panelResizer')}
              aria-valuenow={rightPanelWidth}
              aria-valuemin={RIGHT_PANEL_WIDTH_MIN}
              aria-valuemax={RIGHT_PANEL_WIDTH_MAX}
              tabIndex={0}
              className={cn('resizer resizer-right', draggingSide === 'right' && 'dragging')}
              onMouseDown={onResizerMouseDown('right')}
              onKeyDown={onResizerKeyDown('right')}
            />
          )}

          <aside className="chat-right-panel" aria-label={t('common.rightPanel')}>
            {!rightPanelCollapsed && (
              <SectionErrorBoundary name="right-panel" resetKeys={[devPanelSessionId]}>
                <Suspense fallback={<div className="h-full" />}>
                  <LazyDevPanel
                    sessionId={devPanelSessionId}
                    gitRepoPath={workingDir ?? ''}
                    className="h-full border-t-0"
                  />
                </Suspense>
              </SectionErrorBoundary>
            )}
          </aside>
        </div>

        <DialogHost />
        <AskDialog />

        <Suspense fallback={null}>
          <LazySettingsDialog open={settingsOpen} onOpenChange={closeSettings} />
        </Suspense>

        <Suspense fallback={null}>
          <LazyCommandPalette open={paletteOpen} onOpenChange={closePalette} />
        </Suspense>
        <Suspense fallback={null}>
          <LazyFuzzySearchDialog
            open={fuzzyOpen}
            onClose={() => setFuzzyOpen(false)}
            onSelect={openFileViewer}
          />
        </Suspense>
        <Suspense fallback={null}>
          <LazyShortcutHelpDialog open={shortcutHelpOpen} onClose={closeShortcutHelp} />
        </Suspense>
        <UpdateNotice />
        {scanlines && <div className="scanlines-overlay" aria-hidden="true" />}
      </div>
    </MotionConfig>
  );
}
