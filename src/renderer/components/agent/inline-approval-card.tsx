// src/renderer/components/agent/inline-approval-card.tsx
// 内联审批卡片（对齐参考项目 superagent InlineApprovalCard + 原型 .card.paused）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 在消息流中内联展示审批请求（对齐参考项目：审批不弹窗打断，就地呈现）
// - 三态：pending（左 warn 边条 + 批准/拒绝按钮）/ approved / rejected（状态徽章）
// - 数据源：approvals-store（单一真源，与 ApprovalDialog 弹窗共存）
// ──────────────────────────────────────────────────────────────

import { Check, Pencil, ShieldCheck, X } from 'lucide-react';
import { type ReactElement, useState } from 'react';
import { toast } from 'sonner';
import { useTranslation } from '@/i18n/use-translation';
import { cn } from '@/lib/utils';
import { useTheme } from '@/providers/ThemeProvider';
import { useApprovalsStore } from '@/stores/transient/approvals-store';
import { renderStructuredPreview } from './approval-preview';
import { getIconForType, getLabelKeyForType, isDangerousType } from './approval-utils';

/** 内联审批卡 props */
export interface InlineApprovalCardProps {
  /** 会话 id（只展示当前会话的审批） */
  readonly sessionId: string;
  /**
   * 编辑后重提回调（拒绝后显示；run_command 类型提取命令填入 composer）。
   * 对齐参考项目 P2-10：命令编辑后重新提交。
   */
  readonly onEditResubmit?: (command: string) => void;
}

/**
 * 内联审批卡片
 *
 * 由 ChatPanel 在消息列表上方渲染；pending 时显示操作按钮，
 * 响应后（approve/reject）由 store 移动至 resolved，卡片显示状态。
 */
export function InlineApprovalCard({
  sessionId,
  onEditResubmit,
}: InlineApprovalCardProps): ReactElement | null {
  const { t } = useTranslation();
  // 深色主题（结构化预览的 ReactDiffViewer 双栏适配）
  const { resolvedTheme } = useTheme();
  const isDarkTheme = resolvedTheme === 'dark';

  // 当前会话的审批项（pending 优先展示最新；已决的回显最近一条）
  const item = useApprovalsStore((state) => {
    const pending = [...state.pending].reverse().find((p) => p.sessionId === sessionId);
    if (pending !== undefined) return pending;
    const resolved = [...state.resolved].reverse().find((r) => r.sessionId === sessionId);
    return resolved;
  });

  const approve = useApprovalsStore((state) => state.approve);
  const reject = useApprovalsStore((state) => state.reject);
  // 本地跳过（对齐参考项目 P2-10：卡片半透明 + toast 提示）——hooks 必须在 early return 之前
  const [skipped, setSkipped] = useState(false);
  // 审批项变化时重置跳过态（渲染期调整 state：新审批卡不继承上一张的 skipped）
  const [prevItemId, setPrevItemId] = useState<string | undefined>(undefined);
  if (item?.id !== prevItemId) {
    setPrevItemId(item?.id);
    setSkipped(false);
  }

  if (item === undefined) return null;

  /**
   * 响应审批：更新本地 store + 回传主进程（PermissionService 继续/中止工具）
   *
   * 此前仅更新 store（UI 假审批），主进程审批永久挂起——工具永远不执行。
   * 对齐原型 .card.paused 三按钮（拒绝 / 白名单 / 批准）：
   * - reject     → approved: false
   * - whitelist  → approved: true + rememberDecision: true（后续同工具自动放行）
   * - approve    → approved: true
   */
  const respond = async (approved: boolean, rememberDecision: boolean): Promise<void> => {
    if (approved) {
      approve(item.id);
    } else {
      reject(item.id);
    }
    // 浏览器模式守卫：无 window.api 时仅更新本地状态（预览不崩溃）
    if (typeof window === 'undefined' || window.api === undefined) {
      return;
    }
    await window.api.agent.approvalResponse({
      approvalId: item.id,
      approved,
      rememberDecision,
    });
  };

  const Icon = getIconForType(item.type);
  const isPending = item.status === 'pending';
  const isApproved = item.status === 'approved';
  const dangerous = isDangerousType(item.type);
  // 编辑重提命令：run_command 类型从 input.command 提取（其他类型无命令语义，不显示）
  const resubmitCommand = ((): string | null => {
    if (item.type !== 'run_command') return null;
    const input = item.input;
    if (typeof input === 'object' && input !== null) {
      const c = (input as Record<string, unknown>)['command'];
      return typeof c === 'string' ? c : null;
    }
    return null;
  })();

  return (
    <div
      className={cn(
        'mx-3 mt-2 rounded-lg border bg-card px-3 py-2 text-xs',
        isPending && 'border-l-4 border-l-amber-500',
        isApproved && 'border-l-4 border-l-emerald-500',
        item.status === 'rejected' && 'border-l-4 border-l-red-500',
        skipped && 'opacity-40',
      )}
      role="alert"
      aria-live="polite"
    >
      {/* 头部：图标 + 类型 + 状态 */}
      <div className="flex items-center gap-2">
        <Icon className={cn('size-3.5 shrink-0', dangerous && 'text-red-500')} strokeWidth={1.5} />
        <span className="text-foreground min-w-0 flex-1 truncate font-medium">
          {/* 类型标签（i18n key 带 approval. 前缀：t('approval.runCommand') 等） */}
          {t(`approval.${getLabelKeyForType(item.type)}`)}
        </span>
        {!isPending && (
          <span
            className={cn(
              'shrink-0 rounded-full px-1.5 py-0.5 font-mono text-[9px]',
              isApproved
                ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                : 'bg-red-500/10 text-red-600 dark:text-red-400',
            )}
          >
            {isApproved ? t('approval.approved') : t('approval.rejected')}
          </span>
        )}
      </div>

      {/* 描述 + 结构化预览 */}
      {item.description !== '' && (
        <p className="text-muted-foreground mt-1 leading-relaxed whitespace-pre-wrap">
          {item.description}
        </p>
      )}
      {item.input !== undefined && (
        <div className="mt-1.5">
          {renderStructuredPreview(item.type, item.input, t, isDarkTheme)}
        </div>
      )}

      {/* pending 操作按钮：拒绝 / 白名单 / 批准（对齐原型 .card.paused 三按钮） */}
      {isPending && (
        <div className="mt-2 flex items-center gap-2">
          <button
            type="button"
            onClick={() => void respond(false, false)}
            className="text-muted-foreground hover:bg-muted hover:text-foreground flex cursor-pointer items-center gap-1 rounded border px-2 py-1 text-xs transition-colors"
          >
            <X className="size-3" />
            {t('approval.reject')}
          </button>
          <button
            type="button"
            onClick={() => void respond(true, true)}
            className="hover:bg-muted text-foreground flex cursor-pointer items-center gap-1 rounded border px-2 py-1 text-xs transition-colors"
            title={t('approval.whitelistHint')}
          >
            <ShieldCheck className="size-3" />
            {t('approval.whitelist')}
          </button>
          <button
            type="button"
            onClick={() => void respond(true, false)}
            className={cn(
              'ml-auto flex cursor-pointer items-center gap-1 rounded px-2 py-1 text-xs text-white transition-colors',
              dangerous ? 'bg-red-500 hover:bg-red-600' : 'bg-emerald-600 hover:bg-emerald-700',
            )}
          >
            <Check className="size-3" />
            {t('approval.approve')}
          </button>
        </div>
      )}
      {/* 拒绝后操作：编辑重提（run_command）+ 跳过（对齐参考项目 P2-10） */}
      {item.status === 'rejected' && !skipped && (
        <div className="mt-2 flex items-center gap-2">
          {resubmitCommand !== null && onEditResubmit !== undefined && (
            <button
              type="button"
              onClick={() => onEditResubmit(resubmitCommand)}
              className="hover:bg-muted text-foreground flex cursor-pointer items-center gap-1 rounded border px-2 py-1 text-xs transition-colors"
            >
              <Pencil className="size-3" />
              {t('approval.editResubmit')}
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              setSkipped(true);
              toast.info(t('approval.skipped'));
            }}
            className="text-muted-foreground hover:bg-muted hover:text-foreground flex cursor-pointer items-center gap-1 rounded border px-2 py-1 text-xs transition-colors"
          >
            {t('approval.skip')}
          </button>
        </div>
      )}
    </div>
  );
}
