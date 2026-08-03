// src/renderer/components/layout/DevPanel.tsx
// 开发面板（Terminal + Git + Logs + Metrics + Inspector）· 极简文学风
// ──────────────────────────────────────────────────────────────
// 职责：
// - 提供可折叠的底部面板，集成 TerminalPanel + GitPanel + LogsPanel + MetricsPanel + InspectorPanel
// - 通过 Tabs 切换终端 / Git / 日志 / 指标 / 检查器 五种视图
// - 默认折叠为标题栏，点击展开为固定高度（200px）
//
// 设计：
// - 文学风：与 AppShell 整体风格一致（米色背景 + 衬线字体）
// - 折叠态：仅展示标题栏（含图标 + 标签切换 + 展开按钮）
// - 展开态：标题栏 + 内容区（Tabs 渲染对应面板）
// - 状态隔离：折叠/展开状态由本组件 useState 管理，不进入 store
//   （避免与全局状态耦合，符合「最小必要状态」原则）
// - Logs/Metrics 面板接收 enabled=expanded，折叠时不发起 IPC 查询，节省资源
//
// 集成位置：
// - 由 AppShell 在 main 内容区下方渲染（独立于路由内容）
// - 当用户切换会话时，DevPanel 接收新的 sessionId 自动切换终端实例
// - GitPanel 接收固定的项目根路径（后续可改为可配置）
// ──────────────────────────────────────────────────────────────

import {
  Activity,
  ChevronDown,
  ChevronRight,
  GitBranch,
  ScrollText,
  TerminalSquare,
  Wrench,
} from 'lucide-react';
import { memo, type ReactElement, useState } from 'react';

import { InspectorPanel } from '@/components/dev/InspectorPanel';
import { LogsPanel } from '@/components/dev/LogsPanel';
import { MetricsPanel } from '@/components/dev/MetricsPanel';
import { GitPanel } from '@/components/git/GitPanel';
import { TerminalPanel } from '@/components/terminal/TerminalPanel';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useTranslation } from '@/i18n/use-translation';
import { cn } from '@/lib/utils';

interface DevPanelProps {
  /**
   * 当前 Agent 会话 id
   *
   * 用于关联终端实例（同 sessionId 复用同一个 PTY）。
   * 切换会话时，DevPanel 内的 TerminalPanel 自动切换终端实例。
   */
  readonly sessionId: string;
  /** Git 仓库路径（绝对路径） */
  readonly gitRepoPath: string;
  /** 自定义容器类名 */
  readonly className?: string;
}

/** 展开态内容区高度（px） */
const EXPANDED_HEIGHT = 200;

/** DevPanel 支持的 Tab 类型 */
type DevPanelTab = 'terminal' | 'git' | 'logs' | 'metrics' | 'inspector';

/**
 * 开发面板
 *
 * 集成终端 + Git + 日志 + 指标，可折叠/展开。
 *
 * @example
 * ```tsx
 * <DevPanel sessionId={activeSessionId} gitRepoPath={repoPath} />
 * ```
 */
export const DevPanel = memo(function DevPanel({
  sessionId,
  gitRepoPath,
  className,
}: DevPanelProps): ReactElement {
  // 本地化文案
  const { t } = useTranslation();
  // 面板折叠状态（默认折叠，避免初次进入即占据主区域空间）
  const [expanded, setExpanded] = useState(false);

  // 当前激活的 Tab，默认 terminal
  const [activeTab, setActiveTab] = useState<DevPanelTab>('terminal');

  return (
    <div
      className={cn(
        'border-border bg-background flex flex-col border-t',
        expanded ? '' : 'h-7',
        className,
      )}
      style={expanded ? { height: EXPANDED_HEIGHT } : undefined}
    >
      {/* 标题栏：折叠/展开按钮 + Tab 切换 */}
      <div className="border-border bg-muted/30 flex items-center gap-2 border-b px-2 py-1">
        {/* 折叠/展开按钮 */}
        <button
          type="button"
          className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-[10px] transition-colors"
          onClick={() => {
            setExpanded((prev) => !prev);
          }}
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
            setActiveTab(value as DevPanelTab);
            // 切换 Tab 时自动展开面板（用户点击表示想查看内容）
            if (!expanded) {
              setExpanded(true);
            }
          }}
          className="flex-1"
        >
          <TabsList className="bg-transparent h-5 gap-1 p-0">
            <TabsTrigger value="terminal" className="h-5 gap-1 px-2 py-0 text-[10px]">
              <TerminalSquare className="size-3" strokeWidth={1.5} />
              {t('dev.tabTerminal')}
            </TabsTrigger>
            <TabsTrigger value="git" className="h-5 gap-1 px-2 py-0 text-[10px]">
              <GitBranch className="size-3" strokeWidth={1.5} />
              Git
            </TabsTrigger>
            <TabsTrigger value="logs" className="h-5 gap-1 px-2 py-0 text-[10px]">
              <ScrollText className="size-3" strokeWidth={1.5} />
              {t('dev.tabLogs')}
            </TabsTrigger>
            <TabsTrigger value="metrics" className="h-5 gap-1 px-2 py-0 text-[10px]">
              <Activity className="size-3" strokeWidth={1.5} />
              {t('dev.tabMetrics')}
            </TabsTrigger>
            <TabsTrigger value="inspector" className="h-5 gap-1 px-2 py-0 text-[10px]">
              <Wrench className="size-3" strokeWidth={1.5} />
              {t('dev.tabInspector')}
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {/* 内容区：仅展开时渲染（折叠时不渲染以节省性能） */}
      {expanded && (
        <div className="min-h-0 flex-1">
          {activeTab === 'terminal' && <TerminalPanel sessionId={sessionId} className="h-full" />}
          {activeTab === 'git' && <GitPanel path={gitRepoPath} className="h-full" />}
          {activeTab === 'logs' && <LogsPanel enabled={expanded} className="h-full" />}
          {activeTab === 'metrics' && <MetricsPanel enabled={expanded} className="h-full" />}
          {activeTab === 'inspector' && <InspectorPanel className="h-full" />}
        </div>
      )}
    </div>
  );
});
