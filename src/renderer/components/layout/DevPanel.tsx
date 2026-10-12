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
import { lazy, type ReactElement, Suspense, useEffect, useRef, useState } from 'react';
import { InspectorPanel } from '@/components/dev/InspectorPanel';
import { LogsPanel } from '@/components/dev/LogsPanel';
import { MetricsPanel } from '@/components/dev/MetricsPanel';
import { GitPanel } from '@/components/git/GitPanel';
import { Button } from '@/components/ui/button';
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

const TerminalPanel = lazy(() =>
  import('@/components/terminal/TerminalPanel').then((m) => ({ default: m.TerminalPanel })),
);
const BrowserPane = lazy(() =>
  import('@/components/browser/browser-pane').then((m) => ({ default: m.BrowserPane })),
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
 * 开发者子视图切换按钮（segmented 形态）
 *
 * 独立为组件而非 map 内联：一是让「选中态 → 类名」的映射只有一处，
 * 二是类名归属（.dev-sub-tab，styles/ 领域按钮类）与 <button> 相邻，
 * 符合 ui-consistency 的 raw-button 豁免识别。
 */
function DevSubTabButton({
  icon,
  label,
  active,
  onSelect,
}: {
  readonly icon: ReactElement;
  readonly label: string;
  readonly active: boolean;
  readonly onSelect: () => void;
}): ReactElement {
  return (
    <button
      type="button"
      className={cn(
        'dev-sub-tab flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 text-2xs transition-colors',
        active ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground',
      )}
      onClick={onSelect}
    >
      {icon}
      {label}
    </button>
  );
}

/**
 * 开发者子视图定义（表驱动）
 *
 * 此前是 4 段逐字复制的 `<button>`：仅 icon / 标签 / 目标子视图不同，
 * className 三元与 onClick 完全相同（约 52 行里 4 份重复）。
 * 收敛为数据 + DevSubTabButton 单一渲染路径后，新增子视图只需加一行。
 */
const DEV_SUBTABS: ReadonlyArray<{
  id: DevSubTab;
  icon: ReactElement;
  labelKey: string;
}> = [
  { id: 'git', icon: <GitBranch className="size-2.5" strokeWidth={1.5} />, labelKey: 'dev.tabGit' },
  {
    id: 'logs',
    icon: <ScrollText className="size-2.5" strokeWidth={1.5} />,
    labelKey: 'dev.tabLogs',
  },
  {
    id: 'metrics',
    icon: <Activity className="size-2.5" strokeWidth={1.5} />,
    labelKey: 'dev.tabMetrics',
  },
  {
    id: 'inspector',
    icon: <Wrench className="size-2.5" strokeWidth={1.5} />,
    labelKey: 'dev.tabInspector',
  },
];

/**
 * 右面板（会话上下文面板）
 *
 * 组件级记忆化交给 React Compiler（props 未变时跳过重渲染，覆盖原 memo() 目标）。
 */
export function DevPanel({ sessionId, gitRepoPath, className }: DevPanelProps): ReactElement {
  const { t } = useTranslation();
  const activeTab = useUiStore((state) => state.devPanelTab);
  const setActiveTab = useUiStore((state) => state.setDevPanelTab);
  const [devSubTab, setDevSubTab] = useState<DevSubTab>('git');

  const [openTabs, setOpenTabs] = useState<PanelTab[]>(['info']);
  const tabListRef = useRef<HTMLDivElement | null>(null);
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
  useEffect(() => {
    setOpenTabs((prev) => (prev.includes(activeTab) ? prev : [...prev, activeTab]));
  }, [activeTab]);

  /**
   * 面板内容淡入：hidden ↔ 显示切换时用 tw-animate-css 重播 fade。
   * 保留"hidden 切换不卸载 DOM"的设计（XTerm/表单状态不丢），
   * display 从 none 恢复时 animation 自动重播，零 JS 开销。
   */
  const paneCls = (visible: boolean): string =>
    cn('h-full', !visible && 'hidden', visible && 'animate-in fade-in-0 duration-150');

  return (
    <div className={cn('flex flex-col bg-transparent', className)}>
      <div className="border-border flex h-[30px] items-center gap-2 border-b px-2 py-1">
        <Tabs
          value={activeTab}
          onValueChange={(value) => {
            setActiveTab(value as PanelTab);
          }}
          className="min-w-0 flex-1"
        >
          <TabsList
            ref={tabListRef}
            className="bg-transparent h-5 min-w-0 w-full justify-start overflow-x-auto overflow-y-hidden p-0 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          >
            {openTabs.map((tab) => {
              const def = TAB_DEFS.find((d) => d.id === tab);
              if (def === undefined) return null;
              return (
                <div key={tab} className="flex shrink-0 items-center">
                  <TabsTrigger
                    value={tab}
                    className="h-5 flex-none gap-1 px-1.5 py-0 text-2xs"
                    onKeyDown={(e) => {
                      if ((e.key === 'Delete' || e.key === 'Backspace') && tab !== 'info') {
                        e.preventDefault();
                        closeTab(tab);
                      }
                    }}
                  >
                    {def.icon}
                    <span className="truncate">{t(def.labelKey)}</span>
                  </TabsTrigger>
                  {tab !== 'info' && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="text-muted-foreground hover:bg-muted hover:text-foreground shrink-0 p-0.5"
                      title={t('panel.closeView')}
                      aria-hidden="true"
                      tabIndex={-1}
                      data-panel-close-view="true"
                      onClick={(event) => {
                        event.stopPropagation();
                        closeTab(tab);
                      }}
                    >
                      <X className="size-2.5" strokeWidth={2} />
                    </Button>
                  )}
                </div>
              );
            })}
          </TabsList>
        </Tabs>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="text-muted-foreground hover:bg-muted hover:text-foreground size-5"
              aria-label={t('panel.addView')}
              title={t('panel.addView')}
            >
              <Plus className="size-3" strokeWidth={2} />
            </Button>
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

      <div className="min-h-0 flex-1">
        {openTabs.includes('info') && (
          <div className={paneCls(activeTab === 'info')}>
            <InfoPane sessionId={sessionId} />
          </div>
        )}
        {openTabs.includes('diff') && (
          <div className={paneCls(activeTab === 'diff')}>
            <DiffPane sessionId={sessionId} gitRepoPath={gitRepoPath} />
          </div>
        )}
        {openTabs.includes('file') && (
          <div className={paneCls(activeTab === 'file')}>
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
          <div className={paneCls(activeTab === 'browser')}>
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
          <div className={paneCls(activeTab === 'terminal')}>
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
          <div className={paneCls(activeTab === 'dev')}>
            <div className="flex h-full flex-col">
              <div className="border-border bg-muted/20 flex items-center gap-0.5 border-b px-1.5 py-0.5">
                {DEV_SUBTABS.map((sub) => (
                  <DevSubTabButton
                    key={sub.id}
                    icon={sub.icon}
                    label={t(sub.labelKey)}
                    active={devSubTab === sub.id}
                    onSelect={() => setDevSubTab(sub.id)}
                  />
                ))}
              </div>
              <div className="min-h-0 flex-1">
                <div className={paneCls(devSubTab === 'git')}>
                  <GitPanel path={gitRepoPath} className="h-full" />
                </div>
                <div className={paneCls(devSubTab === 'logs')}>
                  <LogsPanel
                    enabled={activeTab === 'dev' && devSubTab === 'logs'}
                    className="h-full"
                  />
                </div>
                <div className={paneCls(devSubTab === 'metrics')}>
                  <MetricsPanel
                    enabled={activeTab === 'dev' && devSubTab === 'metrics'}
                    className="h-full"
                  />
                </div>
                <div className={paneCls(devSubTab === 'inspector')}>
                  <InspectorPanel className="h-full" />
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
