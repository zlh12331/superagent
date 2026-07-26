// src/renderer/components/agent/ToolPanel.tsx
// 工具调用展示面板 · 极简文学风
// ──────────────────────────────────────────────────────────────
// 职责：
// - 从 useToolStore 读取当前会话的工具调用列表
// - 展示每个工具调用的状态（pending/success/error）+ 名称 + 入参摘要
// - 支持展开查看完整入参与输出/错误详情
// - 空列表时折叠为标题栏（点击展开/收起）
//
// 设计：
// - 文学风：衬线字体 + 米色背景 + 圆角 + 细边框
// - 状态图标：Loader2(旋转) / CheckCircle / XCircle
// - 入参摘要：截取前 100 字符，超出显示省略号
// - 详情区：pre-wrap 保留换行（命令输出/diff 内容）
// ──────────────────────────────────────────────────────────────

import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Loader2,
  type LucideIcon,
  Wrench,
} from 'lucide-react';
import { type ReactElement, useMemo, useState } from 'react';
import ReactDiffViewer, { DiffMethod } from 'react-diff-viewer-continued';

import { cn } from '@/lib/utils';
import type { ToolCallItem, ToolCallStatus } from '@/stores/transient/tool-store';
import { useToolStore } from '@/stores/transient/tool-store';

// 空数组常量：避免每次渲染创建新 [] 引用导致 useSyncExternalStore 无限循环
const EMPTY_CALLS: readonly ToolCallItem[] = [];

interface ToolPanelProps {
  /** 当前会话 id（用于从 store 查询对应的工具调用列表） */
  readonly sessionId: string;
  /** 自定义容器类名 */
  readonly className?: string;
}

/**
 * 按 ToolCallStatus 获取对应图标
 *
 * - pending：Loader2（旋转动画，表示执行中）
 * - success：CheckCircle2（绿色，表示成功）
 * - error：AlertCircle（红色，表示失败）
 *
 * 使用 switch-case 而非对象字面量，避免触发 useNamingConvention。
 */
function getIconForStatus(status: ToolCallStatus): LucideIcon {
  switch (status) {
    case 'pending':
      return Loader2;
    case 'success':
      return CheckCircle2;
    case 'error':
      return AlertCircle;
  }
}

/**
 * 按 ToolCallStatus 获取对应颜色 class
 *
 * - pending：muted-foreground（灰色，中性）
 * - success：text-emerald-600（墨绿，文学风成功色）
 * - error：text-red-600（朱红，文学风错误色）
 */
function getColorForStatus(status: ToolCallStatus): string {
  switch (status) {
    case 'pending':
      return 'text-muted-foreground';
    case 'success':
      return 'text-emerald-600 dark:text-emerald-400';
    case 'error':
      return 'text-red-600 dark:text-red-400';
  }
}

/**
 * 按 ToolCallStatus 获取中文标签
 */
function getLabelForStatus(status: ToolCallStatus): string {
  switch (status) {
    case 'pending':
      return '执行中';
    case 'success':
      return '已完成';
    case 'error':
      return '失败';
  }
}

/**
 * 截取入参摘要（前 100 字符）
 *
 * 工具入参结构由工具 schema 决定，此处统一 JSON.stringify 后截取。
 * 超出 100 字符显示省略号。
 */
function summarizeInput(input: unknown): string {
  if (input === null || input === undefined) {
    return '(无入参)';
  }
  if (typeof input === 'string') {
    return input.length > 100 ? `${input.slice(0, 100)}...` : input;
  }
  try {
    const json = JSON.stringify(input, null, 2);
    return json.length > 100 ? `${json.slice(0, 100)}...` : json;
  } catch {
    return String(input);
  }
}

/**
 * 格式化工具输出（用于详情展示）
 *
 * 字符串直接返回（保留换行），其他类型 JSON.stringify。
 */
function formatOutput(output: unknown): string {
  if (output === null || output === undefined) {
    return '(无输出)';
  }
  if (typeof output === 'string') {
    return output;
  }
  try {
    return JSON.stringify(output, null, 2);
  } catch {
    return String(output);
  }
}

/**
 * 安全读取对象字段（类型守卫）
 *
 * 工具入参类型为 unknown，渲染层需安全提取字段。
 */
function getField(obj: unknown, key: string): string | undefined {
  if (typeof obj !== 'object' || obj === null) return undefined;
  const value = (obj as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

/**
 * 判断工具是否支持 diff 视图展示
 *
 * edit_file 和 write_file 的入参包含文件修改前后的内容，
 * 可用 ReactDiffViewer 展示结构化 diff。
 */
function isDiffCapableTool(toolName: string): boolean {
  return toolName === 'edit_file' || toolName === 'write_file';
}

/**
 * 渲染工具入参的 diff 视图
 *
 * - edit_file：用 oldString / newString 做词级 diff
 * - write_file：左侧显示原文件状态（新建/追加），右侧显示新内容
 */
function renderToolDiff(toolName: string, input: unknown): ReactElement {
  if (toolName === 'edit_file') {
    const oldStr = getField(input, 'oldString') ?? '';
    const newStr = getField(input, 'newString') ?? '';
    const replaceAll = (() => {
      if (typeof input === 'object' && input !== null) {
        const v = (input as Record<string, unknown>)['replaceAll'];
        return typeof v === 'boolean' ? v : false;
      }
      return false;
    })();
    return (
      <div className="approval-diff-wrapper mt-0.5 max-h-64 overflow-auto rounded border border-border">
        {replaceAll && (
          <div className="bg-amber-50 dark:bg-amber-950/20 border-b border-amber-200/60 dark:border-amber-900/40 px-2 py-0.5 text-[10px] text-amber-700 dark:text-amber-400">
            替换全部匹配项
          </div>
        )}
        <ReactDiffViewer
          oldValue={oldStr || '（空）'}
          newValue={newStr || '（空，表示删除）'}
          splitView={true}
          compareMethod={DiffMethod.WORDS}
          hideLineNumbers={false}
          showDiffOnly={false}
          leftTitle="旧内容"
          rightTitle="新内容"
          useDarkTheme={false}
        />
      </div>
    );
  }

  // write_file
  const content = getField(input, 'content') ?? '';
  const append = (() => {
    if (typeof input === 'object' && input !== null) {
      const v = (input as Record<string, unknown>)['append'];
      return typeof v === 'boolean' ? v : false;
    }
    return false;
  })();
  return (
    <div className="approval-diff-wrapper mt-0.5 max-h-64 overflow-auto rounded border border-border">
      <ReactDiffViewer
        oldValue={append ? '（追加到文件末尾）' : '（新建文件）'}
        newValue={content}
        splitView={true}
        compareMethod={DiffMethod.LINES}
        hideLineNumbers={false}
        showDiffOnly={false}
        leftTitle="原文件"
        rightTitle="新内容"
        useDarkTheme={false}
      />
    </div>
  );
}

/**
 * 工具调用展示面板
 *
 * 从 useToolStore 读取当前 sessionId 的工具调用列表，
 * 可折叠/展开。每个工具调用项可单独展开查看详情。
 *
 * @example
 * ```tsx
 * <ToolPanel sessionId={activeSessionId} />
 * ```
 */
export function ToolPanel({ sessionId, className }: ToolPanelProps): ReactElement | null {
  // 订阅当前会话的工具调用列表
  // 使用 EMPTY_CALLS 常量而非内联 []，避免新引用触发无限重渲染
  const calls = useToolStore((state) => state.callsBySession.get(sessionId) ?? EMPTY_CALLS);

  // 面板整体折叠状态（默认展开）
  const [panelExpanded, setPanelExpanded] = useState(true);

  // 派生：是否有工具调用
  const hasCalls = calls.length > 0;

  // 派生：统计成功/失败/进行中数量
  const stats = useMemo(() => {
    let pending = 0;
    let success = 0;
    let error = 0;
    for (const call of calls) {
      switch (call.status) {
        case 'pending':
          pending += 1;
          break;
        case 'success':
          success += 1;
          break;
        case 'error':
          error += 1;
          break;
      }
    }
    return { pending, success, error, total: calls.length };
  }, [calls]);

  // 无工具调用时不渲染（避免占用空间）
  if (!hasCalls) {
    return null;
  }

  return (
    <div
      className={cn(
        'border-border bg-muted/20 flex flex-col border-t',
        panelExpanded ? 'h-48' : 'h-auto',
        className,
      )}
    >
      {/* 标题栏：折叠/展开按钮 + 统计 */}
      <div className="border-border flex items-center justify-between border-b px-3 py-1.5">
        <button
          type="button"
          className="text-muted-foreground hover:text-foreground flex items-center gap-1.5 text-xs transition-colors"
          onClick={() => {
            setPanelExpanded((prev) => !prev);
          }}
          aria-expanded={panelExpanded}
        >
          {panelExpanded ? (
            <ChevronDown className="size-3.5" strokeWidth={1.5} />
          ) : (
            <ChevronRight className="size-3.5" strokeWidth={1.5} />
          )}
          <Wrench className="size-3.5" strokeWidth={1.5} />
          <span className="font-serif tracking-wide">工具调用</span>
          <span className="text-muted-foreground/70">({stats.total})</span>
        </button>

        {/* 统计指示器 */}
        <div className="flex items-center gap-3 text-[10px]">
          {stats.pending > 0 && (
            <span className="text-muted-foreground flex items-center gap-1">
              <Loader2 className="size-3 animate-spin" strokeWidth={1.5} />
              {stats.pending}
            </span>
          )}
          {stats.success > 0 && (
            <span className="text-emerald-600 dark:text-emerald-400 flex items-center gap-1">
              <CheckCircle2 className="size-3" strokeWidth={1.5} />
              {stats.success}
            </span>
          )}
          {stats.error > 0 && (
            <span className="text-red-600 dark:text-red-400 flex items-center gap-1">
              <AlertCircle className="size-3" strokeWidth={1.5} />
              {stats.error}
            </span>
          )}
        </div>
      </div>

      {/* 工具调用列表（可滚动） */}
      {panelExpanded && (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <ul className="flex flex-col gap-1 p-2">
            {calls.map((call) => (
              <li key={call.id}>
                <ToolCallItemView call={call} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// ── 子组件：单个工具调用项 ────────────────────────────────────

interface ToolCallItemViewProps {
  readonly call: ToolCallItem;
}

/**
 * 单个工具调用项
 *
 * 展示：
 * - 状态图标（旋转/成功/失败）
 * - 工具名称
 * - 入参摘要
 * - 可展开查看完整入参/输出/错误
 */
function ToolCallItemView({ call }: ToolCallItemViewProps): ReactElement {
  const [expanded, setExpanded] = useState(false);

  const Icon = getIconForStatus(call.status);
  const colorClass = getColorForStatus(call.status);
  const statusLabel = getLabelForStatus(call.status);
  const inputSummary = summarizeInput(call.input);

  return (
    <div className="hover:bg-accent/50 rounded-md border border-transparent px-2 py-1.5 transition-colors">
      {/* 第一行：状态图标 + 工具名 + 展开按钮 */}
      <button
        type="button"
        className="flex w-full items-center gap-2 text-left"
        onClick={() => {
          setExpanded((prev) => !prev);
        }}
        aria-expanded={expanded}
      >
        <Icon
          className={cn(
            'size-3.5 shrink-0',
            colorClass,
            call.status === 'pending' && 'animate-spin',
          )}
          strokeWidth={1.5}
        />
        <span className="text-foreground font-serif text-xs tracking-wide">{call.toolName}</span>
        <span className={cn('text-[10px]', colorClass)}>{statusLabel}</span>
        <span className="text-muted-foreground ml-auto truncate text-[10px]">{inputSummary}</span>
        {expanded ? (
          <ChevronDown className="text-muted-foreground size-3 shrink-0" strokeWidth={1.5} />
        ) : (
          <ChevronRight className="text-muted-foreground size-3 shrink-0" strokeWidth={1.5} />
        )}
      </button>

      {/* 展开详情：完整入参 + 输出/错误 */}
      {expanded && (
        <div className="mt-2 space-y-2 pl-5">
          {/* diff 视图（edit_file / write_file 专用） */}
          {isDiffCapableTool(call.toolName) ? (
            <div>
              <div className="text-muted-foreground text-[10px] font-medium">变更预览</div>
              {renderToolDiff(call.toolName, call.input)}
            </div>
          ) : (
            /* 其他工具：完整入参（pre 展示） */
            <div>
              <div className="text-muted-foreground text-[10px] font-medium">入参</div>
              <pre className="bg-muted/50 text-foreground/80 mt-0.5 overflow-x-auto rounded p-2 text-[10px] leading-relaxed whitespace-pre-wrap">
                {formatOutput(call.input)}
              </pre>
            </div>
          )}

          {/* 输出（status='success' 时展示） */}
          {call.status === 'success' && (
            <div>
              <div className="text-muted-foreground text-[10px] font-medium">输出</div>
              <pre className="bg-muted/50 text-foreground/80 mt-0.5 overflow-x-auto rounded p-2 text-[10px] leading-relaxed whitespace-pre-wrap">
                {formatOutput(call.output)}
              </pre>
            </div>
          )}

          {/* 错误（status='error' 时展示） */}
          {call.status === 'error' && call.error !== null && (
            <div>
              <div className="text-red-600 dark:text-red-400 text-[10px] font-medium">错误</div>
              <pre className="bg-red-50 dark:bg-red-950/20 text-red-700 dark:text-red-300 mt-0.5 overflow-x-auto rounded p-2 text-[10px] leading-relaxed whitespace-pre-wrap">
                {`[${call.error.code}] ${call.error.message}`}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── 兼容导出（供测试或其他组件使用） ─────────────────────────

/** 工具面板默认导出（便于 lazy 加载，虽然当前未使用） */
export default ToolPanel;
