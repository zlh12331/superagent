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
  ChevronDown,
  ChevronRight,
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
import { memo, type ReactElement, useState } from 'react';

import { BrowserPane } from '@/components/dev/browser-pane';
import { InspectorPanel } from '@/components/dev/InspectorPanel';
import { LogsPanel } from '@/components/dev/LogsPanel';
import { MetricsPanel } from '@/components/dev/MetricsPanel';
import { GitPanel } from '@/components/git/GitPanel';
import { TerminalPanel } from '@/components/terminal/TerminalPanel';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useTranslation } from '@/i18n/use-translation';
import { cn } from '@/lib/utils';
import { DiffPane, FilesPane, InfoPane } from './right-panel-panes';

interface DevPanelProps {
  /**
   * 当前 Agent 会话 id
   *
   * 用于关联终端实例 + 会话详情查询（goal/task）+ 文件变更记录。
   */
  readonly sessionId: string;
  /** Git 仓库路径（绝对路径） */
  readonly gitRepoPath: string;
  /** 当前工作目录（会话详情展示；未知时省略） */
  readonly workingDir?: string;
  /** 默认模型 id（会话详情展示） */
  readonly defaultModel?: string;
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
  workingDir,
  defaultModel,
  className,
}: DevPanelProps): ReactElement {
  // 本地化文案
  const { t } = useTranslation();
  // 内容折叠状态（默认展开；折叠为标题栏横条）
  const [expanded, setExpanded] = useState(true);
  // 当前激活 Tab（默认会话详情，对齐原型首位）
  const [activeTab, setActiveTab] = useState<PanelTab>('info');
  // 开发者子视图（默认 git，对齐原 GitPanel 入口）
  const [devSubTab, setDevSubTab] = useState<DevSubTab>('git');

  return (
    <div
      className={cn(
        'border-border bg-background flex flex-col border-l',
        expanded ? '' : 'h-7',
        className,
      )}
      style={expanded ? { height: '100%' } : undefined}
    >
      {/* 标题栏：折叠/展开按钮 + Tab 切换 */}
      <div className="border-border bg-muted/30 flex items-center gap-2 border-b px-2 py-1">
        {/* 折叠/展开按钮 */}
        <button
          type="button"
          className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-[10px] transition-colors"
          onClick={() => setExpanded((prev) => !prev)}
          aria-expanded={expanded}
          aria-label={expanded ? t('dev.collapsePanel') : t('dev.expandPanel')}
        >
          {expanded ? (
            <ChevronDown className="size-3" strokeWidth={1.5} />
          ) : (
            <ChevronRight className="size-3" strokeWidth={1.5} />
          )}
        </button>

        {/* Tab 切换（折叠态也可见，点击切换 + 自动展开） */}
        <Tabs
          value={activeTab}
          onValueChange={(value) => {
            setActiveTab(value as PanelTab);
            if (!expanded) {
              setExpanded(true);
            }
          }}
          className="min-w-0 flex-1"
        >
          {/* w-full 覆盖 TabsList 基类 w-fit：tab 行随面板收缩均分，永不溢出 */}
          <TabsList className="bg-transparent h-5 min-w-0 w-full p-0">
            <TabsTrigger value="info" className="h-5 min-w-0 flex-1 gap-1 px-1 py-0 text-[10px]">
              <Target className="size-3 shrink-0" strokeWidth={1.5} />
              <span className="truncate">{t('panel.tabInfo')}</span>
            </TabsTrigger>
            <TabsTrigger value="diff" className="h-5 min-w-0 flex-1 gap-1 px-1 py-0 text-[10px]">
              <FileCode2 className="size-3 shrink-0" strokeWidth={1.5} />
              <span className="truncate">{t('panel.tabDiff')}</span>
            </TabsTrigger>
            <TabsTrigger value="files" className="h-5 min-w-0 flex-1 gap-1 px-1 py-0 text-[10px]">
              <FolderOpen className="size-3 shrink-0" strokeWidth={1.5} />
              <span className="truncate">{t('panel.tabFiles')}</span>
            </TabsTrigger>
            <TabsTrigger value="browser" className="h-5 min-w-0 flex-1 gap-1 px-1 py-0 text-[10px]">
              <Globe className="size-3 shrink-0" strokeWidth={1.5} />
              <span className="truncate">{t('panel.tabBrowser')}</span>
            </TabsTrigger>
            <TabsTrigger
              value="terminal"
              className="h-5 min-w-0 flex-1 gap-1 px-1 py-0 text-[10px]"
            >
              <TerminalSquare className="size-3 shrink-0" strokeWidth={1.5} />
              <span className="truncate">{t('dev.tabTerminal')}</span>
            </TabsTrigger>
            <TabsTrigger value="dev" className="h-5 min-w-0 flex-1 gap-1 px-1 py-0 text-[10px]">
              <LayoutGrid className="size-3 shrink-0" strokeWidth={1.5} />
              <span className="truncate">{t('panel.tabDev')}</span>
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {/* 内容区：仅展开时渲染 */}
      {expanded && (
        <div className="min-h-0 flex-1">
          {activeTab === 'info' && (
            <InfoPane
              sessionId={sessionId}
              {...(workingDir !== undefined ? { workingDir } : {})}
              {...(defaultModel !== undefined ? { defaultModel } : {})}
            />
          )}
          {activeTab === 'diff' && <DiffPane sessionId={sessionId} gitRepoPath={gitRepoPath} />}
          {activeTab === 'files' && <FilesPane sessionId={sessionId} />}
          {activeTab === 'browser' && <BrowserPane />}
          {activeTab === 'terminal' && <TerminalPanel sessionId={sessionId} className="h-full" />}
          {activeTab === 'dev' && (
            <div className="flex h-full flex-col">
              {/* 开发者子视图切换（调试工具收纳） */}
              <div className="border-border bg-muted/20 flex items-center gap-0.5 border-b px-1.5 py-0.5">
                <button
                  type="button"
                  className={cn(
                    'flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 text-[10px] transition-colors',
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
                    'flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 text-[10px] transition-colors',
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
                    'flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 text-[10px] transition-colors',
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
                    'flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 text-[10px] transition-colors',
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
                {devSubTab === 'git' && <GitPanel path={gitRepoPath} className="h-full" />}
                {devSubTab === 'logs' && <LogsPanel enabled={expanded} className="h-full" />}
                {devSubTab === 'metrics' && <MetricsPanel enabled={expanded} className="h-full" />}
                {devSubTab === 'inspector' && <InspectorPanel className="h-full" />}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
});
