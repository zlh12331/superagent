// src/renderer/components/layout/DevPanel.tsx
// 右面板（会话上下文面板）· 对齐原型 .chat-right-panel
// ──────────────────────────────────────────────────────────────
// 职责：
// - 右侧竖条面板：会话详情 / 文件变更 / 文件 / 终端 / 开发者
// - 会话详情（info）：会话目标 + 计划待办 + 会话元信息（对齐原型 crpPaneInfo）
// - 文件变更（diff）：本轮 edit_file/write_file 调用记录（对齐原型 crpPaneDiff）
// - 文件（files）：最近修改文件，点击打开 FileViewerDialog（对齐原型 crpPaneFiles）
// - 终端（terminal）：TerminalPanel（保留原能力）
// - 开发者（dev）：Git / 日志 / 指标 / 检查器（调试工具收纳，不占主位）
//
// 设计：
// - 默认展开撑满右面板（折叠由 AppShell rightPanelCollapsed 控制）
// - 内部保留折叠态：折叠为标题栏横条（可再收起内容）
// ──────────────────────────────────────────────────────────────

import {
  Activity,
  FileCode2,
  FolderOpen,
  GitBranch,
  Globe,
  LayoutGrid,
  ScrollText,
  Target,
  TerminalSquare,
  Wrench,
} from 'lucide-react';
import { lazy, memo, type ReactElement, Suspense, useState } from 'react';
import { InspectorPanel } from '@/components/dev/InspectorPanel';
import { LogsPanel } from '@/components/dev/LogsPanel';
import { MetricsPanel } from '@/components/dev/MetricsPanel';
import { GitPanel } from '@/components/git/GitPanel';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useTranslation } from '@/i18n/use-translation';
import { cn } from '@/lib/utils';
import { useUiStore } from '@/stores/transient/ui-store';
import { DiffPane, FilesPane, InfoPane } from './right-panel-panes';

// 懒加载（对齐参考项目：xterm ~200KB vendor chunk 仅在切到终端 tab 时加载，避免拖慢首屏）
const TerminalPanel = lazy(() =>
  import('@/components/terminal/TerminalPanel').then((m) => ({ default: m.TerminalPanel })),
);
const BrowserPane = lazy(() =>
  import('@/components/dev/browser-pane').then((m) => ({ default: m.BrowserPane })),
);

interface DevPanelProps {
  /**
   * 当前 Agent 会话 id
   *
   * 用于关联终端实例 + 会话详情查询（goal/task）+ 文件变更记录。
   */
  readonly sessionId: string;
  /** Git 仓库路径（绝对路径） */
  readonly gitRepoPath: string;
  /** 自定义容器类名 */
  readonly className?: string;
}

/** 顶层 Tab 类型 */
type PanelTab = 'info' | 'diff' | 'files' | 'browser' | 'terminal' | 'dev';

/** 开发者子视图类型 */
type DevSubTab = 'git' | 'logs' | 'metrics' | 'inspector';

/**
 * 右面板（会话上下文面板）
 */
export const DevPanel = memo(function DevPanel({
  sessionId,
  gitRepoPath,
  className,
}: DevPanelProps): ReactElement {
  // 本地化文案
  const { t } = useTranslation();
  // 当前激活 Tab（默认会话详情，对齐原型首位；集中到 ui-store——命令面板「打开终端」等入口可跨组件切换）
  const activeTab = useUiStore((state) => state.devPanelTab);
  const setActiveTab = useUiStore((state) => state.setDevPanelTab);
  // 开发者子视图（默认 git，对齐原 GitPanel 入口）
  const [devSubTab, setDevSubTab] = useState<DevSubTab>('git');

  return (
    <div className={cn('border-border bg-background flex flex-col border-l', className)}>
      {/* 标题栏：Tab 切换（右面板折叠由全局机制管理：断点/AppShell 按钮，此处不重复放置） */}
      <div className="border-border bg-muted/30 flex items-center gap-2 border-b px-2 py-1">
        {/* Tab 切换 */}
        <Tabs
          value={activeTab}
          onValueChange={(value) => {
            setActiveTab(value as PanelTab);
          }}
          className="min-w-0 flex-1"
        >
          {/* w-full 覆盖 TabsList 基类 w-fit：tab 行随面板收缩均分，永不溢出 */}
          <TabsList className="bg-transparent h-5 min-w-0 w-full p-0">
            <TabsTrigger value="info" className="h-5 min-w-0 flex-1 gap-1 px-1 py-0 text-2xs">
              <Target className="size-3 shrink-0" strokeWidth={1.5} />
              <span className="truncate">{t('panel.tabInfo')}</span>
            </TabsTrigger>
            <TabsTrigger value="diff" className="h-5 min-w-0 flex-1 gap-1 px-1 py-0 text-2xs">
              <FileCode2 className="size-3 shrink-0" strokeWidth={1.5} />
              <span className="truncate">{t('panel.tabDiff')}</span>
            </TabsTrigger>
            <TabsTrigger value="files" className="h-5 min-w-0 flex-1 gap-1 px-1 py-0 text-2xs">
              <FolderOpen className="size-3 shrink-0" strokeWidth={1.5} />
              <span className="truncate">{t('panel.tabFiles')}</span>
            </TabsTrigger>
            <TabsTrigger value="browser" className="h-5 min-w-0 flex-1 gap-1 px-1 py-0 text-2xs">
              <Globe className="size-3 shrink-0" strokeWidth={1.5} />
              <span className="truncate">{t('panel.tabBrowser')}</span>
            </TabsTrigger>
            <TabsTrigger value="terminal" className="h-5 min-w-0 flex-1 gap-1 px-1 py-0 text-2xs">
              <TerminalSquare className="size-3 shrink-0" strokeWidth={1.5} />
              <span className="truncate">{t('dev.tabTerminal')}</span>
            </TabsTrigger>
            <TabsTrigger value="dev" className="h-5 min-w-0 flex-1 gap-1 px-1 py-0 text-2xs">
              <LayoutGrid className="size-3 shrink-0" strokeWidth={1.5} />
              <span className="truncate">{t('panel.tabDev')}</span>
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {/* 内容区（面板折叠由全局机制管理，此处始终展开）
          面板常驻：所有 tab 始终在 DOM，用 hidden 切换（照搬参考项目 ContextPanel）——
          避免 xterm 实例、滚动位置、diff 展开态在切换 tab 时丢失 */}
      <div className="min-h-0 flex-1">
        <div className={cn('h-full', activeTab !== 'info' && 'hidden')}>
          <InfoPane sessionId={sessionId} />
        </div>
        <div className={cn('h-full', activeTab !== 'diff' && 'hidden')}>
          <DiffPane sessionId={sessionId} gitRepoPath={gitRepoPath} />
        </div>
        <div className={cn('h-full', activeTab !== 'files' && 'hidden')}>
          <FilesPane sessionId={sessionId} />
        </div>
        <div className={cn('h-full', activeTab !== 'browser' && 'hidden')}>
          <Suspense
            fallback={
              <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                加载中…
              </div>
            }
          >
            <BrowserPane />
          </Suspense>
        </div>
        <div className={cn('h-full', activeTab !== 'terminal' && 'hidden')}>
          <Suspense
            fallback={
              <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                加载中…
              </div>
            }
          >
            <TerminalPanel sessionId={sessionId} className="h-full" />
          </Suspense>
        </div>
        <div className={cn('h-full', activeTab !== 'dev' && 'hidden')}>
          <div className="flex h-full flex-col">
            {/* 开发者子视图切换（调试工具收纳） */}
            <div className="border-border bg-muted/20 flex items-center gap-0.5 border-b px-1.5 py-0.5">
              <button
                type="button"
                className={cn(
                  'flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 text-2xs transition-colors',
                  devSubTab === 'git'
                    ? 'bg-muted text-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )}
                onClick={() => setDevSubTab('git')}
              >
                <GitBranch className="size-2.5" strokeWidth={1.5} />
                Git
              </button>
              <button
                type="button"
                className={cn(
                  'flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 text-2xs transition-colors',
                  devSubTab === 'logs'
                    ? 'bg-muted text-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )}
                onClick={() => setDevSubTab('logs')}
              >
                <ScrollText className="size-2.5" strokeWidth={1.5} />
                {t('dev.tabLogs')}
              </button>
              <button
                type="button"
                className={cn(
                  'flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 text-2xs transition-colors',
                  devSubTab === 'metrics'
                    ? 'bg-muted text-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )}
                onClick={() => setDevSubTab('metrics')}
              >
                <Activity className="size-2.5" strokeWidth={1.5} />
                {t('dev.tabMetrics')}
              </button>
              <button
                type="button"
                className={cn(
                  'flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 text-2xs transition-colors',
                  devSubTab === 'inspector'
                    ? 'bg-muted text-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )}
                onClick={() => setDevSubTab('inspector')}
              >
                <Wrench className="size-2.5" strokeWidth={1.5} />
                {t('dev.tabInspector')}
              </button>
            </div>
            <div className="min-h-0 flex-1">
              <div className={cn('h-full', devSubTab !== 'git' && 'hidden')}>
                <GitPanel path={gitRepoPath} className="h-full" />
              </div>
              <div className={cn('h-full', devSubTab !== 'logs' && 'hidden')}>
                {/* enabled 跟随可见性（对齐参考项目：面板不可见时不查询） */}
                <LogsPanel
                  enabled={activeTab === 'dev' && devSubTab === 'logs'}
                  className="h-full"
                />
              </div>
              <div className={cn('h-full', devSubTab !== 'metrics' && 'hidden')}>
                {/* enabled 跟随可见性（对齐参考项目：面板不可见时不轮询） */}
                <MetricsPanel
                  enabled={activeTab === 'dev' && devSubTab === 'metrics'}
                  className="h-full"
                />
              </div>
              <div className={cn('h-full', devSubTab !== 'inspector' && 'hidden')}>
                <InspectorPanel className="h-full" />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
});
