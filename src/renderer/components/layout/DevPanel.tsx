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
  FileText,
  GitBranch,
  Globe,
  LayoutGrid,
  Plus,
  ScrollText,
  Target,
  TerminalSquare,
  Wrench,
  X,
} from 'lucide-react';
import { lazy, memo, type ReactElement, Suspense, useEffect, useRef, useState } from 'react';
import { InspectorPanel } from '@/components/dev/InspectorPanel';
import { LogsPanel } from '@/components/dev/LogsPanel';
import { MetricsPanel } from '@/components/dev/MetricsPanel';
import { GitPanel } from '@/components/git/GitPanel';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useTranslation } from '@/i18n/use-translation';
import { cn } from '@/lib/utils';
import { useUiStore } from '@/stores/transient/ui-store';
import { DiffPane, InfoPane } from './right-panel-panes';

// 懒加载（对齐参考项目：xterm ~200KB vendor chunk 仅在切到终端 tab 时加载，避免拖慢首屏）
const TerminalPanel = lazy(() =>
  import('@/components/terminal/TerminalPanel').then((m) => ({ default: m.TerminalPanel })),
);
const BrowserPane = lazy(() =>
  import('@/components/dev/browser-pane').then((m) => ({ default: m.BrowserPane })),
);
const FileViewerPanel = lazy(() =>
  import('@/components/file-tree/FileViewerPanel').then((m) => ({ default: m.FileViewerPanel })),
);

/** 右面板可添加视图定义（默认任务摘要常驻；其余通过"+"按钮按需加入） */
const TAB_DEFS: ReadonlyArray<{ id: PanelTab; icon: ReactElement; labelKey: string }> = [
  {
    id: 'info',
    icon: <Target className="size-3 shrink-0" strokeWidth={1.5} />,
    labelKey: 'panel.tabInfo',
  },
  {
    id: 'diff',
    icon: <FileCode2 className="size-3 shrink-0" strokeWidth={1.5} />,
    labelKey: 'panel.tabDiff',
  },
  {
    id: 'file',
    icon: <FileText className="size-3 shrink-0" strokeWidth={1.5} />,
    labelKey: 'panel.tabFile',
  },
  {
    id: 'browser',
    icon: <Globe className="size-3 shrink-0" strokeWidth={1.5} />,
    labelKey: 'panel.tabBrowser',
  },
  {
    id: 'terminal',
    icon: <TerminalSquare className="size-3 shrink-0" strokeWidth={1.5} />,
    labelKey: 'dev.tabTerminal',
  },
  {
    id: 'dev',
    icon: <LayoutGrid className="size-3 shrink-0" strokeWidth={1.5} />,
    labelKey: 'panel.tabDev',
  },
];

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
type PanelTab = 'info' | 'diff' | 'file' | 'browser' | 'terminal' | 'dev';

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

  // 动态 tab 集合：默认任务摘要（info）常驻；其余通过"+"按钮按需加入（用户需求）
  const [openTabs, setOpenTabs] = useState<PanelTab[]>(['info']);
  // tab 行横向滚动容器：tab 多时横向滚动而非挤压文字（此前均分导致标签被压到 0 宽，实测 bug）
  const tabListRef = useRef<HTMLDivElement | null>(null);
  // 新增视图后滚动到末尾（关闭视图不触发，保留用户当前视区）
  const prevTabCountRef = useRef(openTabs.length);
  useEffect(() => {
    const el = tabListRef.current;
    if (el !== null && openTabs.length > prevTabCountRef.current) {
      el.scrollLeft = el.scrollWidth;
    }
    prevTabCountRef.current = openTabs.length;
  }, [openTabs]);
  const closeTab = (tab: PanelTab): void => {
    setOpenTabs((prev) => prev.filter((t) => t !== tab));
    if (activeTab === tab) {
      const remaining = openTabs.filter((t) => t !== tab);
      setActiveTab(remaining[0] ?? 'info');
    }
  };
  // 外部切换（命令面板"打开终端"等）时自动加入未打开的视图
  useEffect(() => {
    setOpenTabs((prev) => (prev.includes(activeTab) ? prev : [...prev, activeTab]));
  }, [activeTab]);

  // 用户要求：右面板与对话区间隔不可见——根容器不加左边线（像素实测 border-l 产生 --border 色亮线）
  return (
    <div className={cn('bg-background flex flex-col', className)}>
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
          {/* tab 行可横向滚动：标签保持自然宽度不被挤压（对齐 TerminalTabs 滚动模式） */}
          <TabsList
            ref={tabListRef}
            className="bg-transparent h-5 min-w-0 w-full justify-start overflow-x-auto overflow-y-hidden p-0 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          >
            {openTabs.map((tab) => {
              const def = TAB_DEFS.find((d) => d.id === tab);
              if (def === undefined) return null;
              return (
                <div key={tab} className="flex shrink-0 items-center">
                  <TabsTrigger value={tab} className="h-5 flex-none gap-1 px-1.5 py-0 text-2xs">
                    {def.icon}
                    <span className="truncate">{t(def.labelKey)}</span>
                  </TabsTrigger>
                  {tab !== 'info' && (
                    <button
                      type="button"
                      className="text-muted-foreground hover:bg-muted hover:text-foreground flex shrink-0 cursor-pointer items-center rounded p-0.5 transition-colors"
                      aria-label={t('panel.closeView')}
                      title={t('panel.closeView')}
                      onClick={(event) => {
                        event.stopPropagation();
                        closeTab(tab);
                      }}
                    >
                      <X className="size-2.5" strokeWidth={2} />
                    </button>
                  )}
                </div>
              );
            })}
          </TabsList>
        </Tabs>
        {/* 添加视图按钮（用户需求：默认任务摘要 + 添加按钮，按需加入其他视图） */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="text-muted-foreground hover:bg-muted hover:text-foreground flex size-5 shrink-0 cursor-pointer items-center justify-center rounded transition-colors"
              aria-label={t('panel.addView')}
              title={t('panel.addView')}
            >
              <Plus className="size-3" strokeWidth={2} />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-36">
            {TAB_DEFS.filter((d) => d.id !== 'info' && !openTabs.includes(d.id)).map((def) => (
              <DropdownMenuItem
                key={def.id}
                onSelect={() => {
                  setOpenTabs((prev) => [...prev, def.id]);
                  setActiveTab(def.id);
                }}
              >
                {def.icon}
                <span>{t(def.labelKey)}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* 内容区（面板折叠由全局机制管理，此处始终展开）
          按 openTabs 条件渲染（未添加的视图不挂载；已添加的用 hidden 切换避免状态丢失） */}
      <div className="min-h-0 flex-1">
        {openTabs.includes('info') && (
          <div className={cn('h-full', activeTab !== 'info' && 'hidden')}>
            <InfoPane sessionId={sessionId} />
          </div>
        )}
        {openTabs.includes('diff') && (
          <div className={cn('h-full', activeTab !== 'diff' && 'hidden')}>
            <DiffPane sessionId={sessionId} gitRepoPath={gitRepoPath} />
          </div>
        )}
        {openTabs.includes('file') && (
          <div className={cn('h-full', activeTab !== 'file' && 'hidden')}>
            <Suspense
              fallback={
                <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                  {t('common.loading')}
                </div>
              }
            >
              <FileViewerPanel />
            </Suspense>
          </div>
        )}
        {openTabs.includes('browser') && (
          <div className={cn('h-full', activeTab !== 'browser' && 'hidden')}>
            <Suspense
              fallback={
                <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                  {t('common.loading')}
                </div>
              }
            >
              <BrowserPane />
            </Suspense>
          </div>
        )}
        {openTabs.includes('terminal') && (
          <div className={cn('h-full', activeTab !== 'terminal' && 'hidden')}>
            <Suspense
              fallback={
                <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                  {t('common.loading')}
                </div>
              }
            >
              <TerminalPanel sessionId={sessionId} className="h-full" />
            </Suspense>
          </div>
        )}
        {openTabs.includes('dev') && (
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
        )}
      </div>
    </div>
  );
});
