// src/renderer/components/chapter/AgentStreamPanel.tsx
// Agent 流式生成结果展示面板
// 设计文档 §5.1 场景 5（Agent 章节生成）+ §5.5 流式响应中断设计
//
// 职责：
// - 接收 ackId，订阅 Agent 流式事件（chunk/end/error）
// - 实时展示流式生成的文本（按任务类型显示标题）
// - 流式完成后监听 statusByAckId[ackId] === 'completed' 自动失效缓存
// - 提供关闭按钮（清理 store 中该 ackId 的所有状态）
//
// 注意：
// - 本面板是一个固定高度的右侧抽屉式面板，浮在编辑器上方
// - 流式状态用不同颜色 + 文案区分：streaming（黄圈+流式中）/ completed（绿勾+已完成）/ error（红叉+失败）
// - useAgentStreamSubscription + useAgentCompletionEffect 在本组件调用，
//   保证面板挂载时才订阅，卸载时自动 cleanup
// - 父组件通过 ackId === null 控制面板显隐

import { AlertCircle, CheckCircle2, Loader2, X } from 'lucide-react';
import type { ReactElement } from 'react';

import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useAgentCompletionEffect, useAgentStreamSubscription } from '@/hooks/use-agent';
import { cn } from '@/lib/utils';
import type { AgentStreamStatus, AgentTaskKind } from '@/stores/agent-stream.store';
import { useAgentStreamStore } from '@/stores/agent-stream.store';

interface AgentStreamPanelProps {
  /** 当前活跃的 Agent 流 ID（null 时不渲染面板） */
  ackId: string | null;
  /** 关闭面板回调（父组件清空 ackId） */
  onClose: () => void;
}

/** 任务类型 → 中文标题 */
const KIND_LABELS: Record<AgentTaskKind, string> = {
  generate: 'AI 续写',
  rewrite: 'AI 改写',
  expand: 'AI 扩写大纲',
};

/** 任务类型标题兜底值 */
const KIND_LABEL_FALLBACK = 'AI 写作';

/** 流式状态 → 图标 + 文案 + 颜色 */
const STATUS_META: Record<
  AgentStreamStatus,
  { icon: ReactElement; label: string; dotClass: string }
> = {
  streaming: {
    icon: <Loader2 className="size-3.5 animate-spin" />,
    label: '生成中...',
    dotClass: 'bg-amber-500',
  },
  completed: {
    icon: <CheckCircle2 className="size-3.5 text-emerald-500" />,
    label: '已完成',
    dotClass: 'bg-emerald-500',
  },
  error: {
    icon: <AlertCircle className="size-3.5 text-destructive" />,
    label: '失败',
    dotClass: 'bg-destructive',
  },
};

/**
 * Agent 流式生成结果展示面板
 *
 * @example
 * {activeAckId && (
 *   <AgentStreamPanel ackId={activeAckId} onClose={() => setActiveAckId(null)} />
 * )}
 */
export function AgentStreamPanel({ ackId, onClose }: AgentStreamPanelProps): ReactElement | null {
  // 订阅当前 ackId 的流式事件（chunk/end/error → store）
  useAgentStreamSubscription(ackId);
  // 监听流式完成 → 自动失效缓存（generate:章节列表 / rewrite:章节详情）
  useAgentCompletionEffect(ackId);

  // selector 订阅当前 ackId 的状态与文本
  // noUncheckedIndexedAccess 下 Record 索引返回 T | undefined，需兜底
  const kind = useAgentStreamStore((s) => (ackId ? s.kindByAckId[ackId] : null));
  const text = useAgentStreamStore((s) => (ackId ? (s.chunksByAckId[ackId] ?? '') : ''));
  const status = useAgentStreamStore((s) =>
    ackId
      ? (s.statusByAckId[ackId] ?? ('streaming' as AgentStreamStatus))
      : ('streaming' as AgentStreamStatus),
  );
  const error = useAgentStreamStore((s) => (ackId ? (s.errorByAckId[ackId] ?? '') : ''));
  const clearStream = useAgentStreamStore((s) => s.clearStream);

  // 面板未激活：不渲染（父组件控制显隐）
  if (ackId === null) {
    return null;
  }

  const kindLabel = kind ? (KIND_LABELS[kind] ?? KIND_LABEL_FALLBACK) : KIND_LABEL_FALLBACK;
  const statusMeta = STATUS_META[status];

  /** 关闭面板：清理 store + 通知父组件 */
  const handleClose = (): void => {
    clearStream(ackId);
    onClose();
  };

  return (
    <aside
      className="bg-card flex w-96 shrink-0 flex-col border-l shadow-lg"
      aria-label="AI 生成结果面板"
    >
      {/* 顶部：任务标题 + 状态指示器 + 关闭按钮 */}
      <header className="flex h-12 shrink-0 items-center justify-between border-b px-4">
        <div className="flex items-center gap-2">
          <span className={cn('size-2 rounded-full', statusMeta.dotClass)} aria-hidden />
          <span className="text-sm font-medium">{kindLabel}</span>
          <span className="text-muted-foreground flex items-center gap-1 text-xs">
            {statusMeta.icon}
            {statusMeta.label}
          </span>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          onClick={handleClose}
          aria-label="关闭 AI 面板"
        >
          <X className="size-4" />
        </Button>
      </header>

      {/* 中间：流式文本展示区（可滚动） */}
      <ScrollArea className="flex-1">
        <div className="p-4">
          {status === 'error' ? (
            // 错误状态：显示错误消息
            <p className="text-destructive text-sm whitespace-pre-wrap">
              {error.length > 0 ? error : '生成失败，请重试'}
            </p>
          ) : text.length > 0 ? (
            // 有文本：展示纯文本（流式临时展示，未做富文本格式化）
            <pre className="text-foreground text-sm whitespace-pre-wrap font-sans leading-relaxed">
              {text}
            </pre>
          ) : (
            // 无文本：等待第一个 chunk
            <p className="text-muted-foreground text-sm">等待 AI 输出...</p>
          )}
        </div>
      </ScrollArea>

      {/* 底部：完成后的提示 */}
      {status === 'completed' && (
        <footer className="border-t p-3 text-xs text-muted-foreground">
          {kind === 'rewrite'
            ? '已自动更新到当前章节'
            : kind === 'generate'
              ? '已创建为新章节（草稿）'
              : '已生成大纲内容（未持久化，请手动复制）'}
        </footer>
      )}
    </aside>
  );
}
