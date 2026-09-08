// src/renderer/components/agent/inline-approval-card.tsx
// 内联审批卡片（对齐参考项目 superagent InlineApprovalCard + 原型 .card.paused）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 在消息流中内联展示审批请求（对齐参考项目：审批不弹窗打断，就地呈现）
// - 三态：pending（左 warn 边条 + 批准/拒绝按钮）/ approved / rejected（状态徽章）
// - 数据源：approvals-store（单一真源；全局弹窗 ApprovalDialog 已移除，卡片是唯一审批 UI）
// ──────────────────────────────────────────────────────────────

import { REMEMBER_TTL_MINUTES } from '@code-agent/shared/renderer';
import { Check, Pencil, ShieldCheck, X } from 'lucide-react';
import { type ReactElement, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { useTranslation } from '@/i18n/use-translation';
import { unwrap } from '@/lib/ipc';
import { cn } from '@/lib/utils';
import { useTheme } from '@/providers/ThemeProvider';
import { useApprovalsStore } from '@/stores/transient/approvals-store';
import { renderStructuredPreview } from './approval-preview';
import {
  canRememberDecision,
  getIconForType,
  getLabelKeyForType,
  getVariantForType,
  isDangerousType,
} from './approval-utils';

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
 * 发送审批响应（模块级：从组件提取以保持函数体精简）
 *
 * @returns 是否成功（失败由调用方 toast，主进程侧 5 分钟超时兜底仍生效）
 */
async function sendApprovalResponse(
  approvalId: string,
  approved: boolean,
  rememberDecision: boolean,
): Promise<boolean> {
  try {
    unwrap(await window.api.agent.approvalResponse({ approvalId, approved, rememberDecision }));
    return true;
  } catch {
    return false;
  }
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
  const dismiss = useApprovalsStore((state) => state.dismiss);
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
    const ok = await sendApprovalResponse(item.id, approved, rememberDecision);
    if (!ok) {
      toast.error(t('approval.responseFailed'));
    }
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
        isPending && 'border-l-4 border-l-[var(--warn)]',
        isApproved && 'border-l-4 border-l-[var(--success)]',
        item.status === 'rejected' && 'border-l-4 border-l-[var(--error)]',
        skipped && 'opacity-40',
      )}
      role="alert"
      aria-live="polite"
    >
      {/* 头部：图标 + 类型 + 状态 */}
      <div className="flex items-center gap-2">
        <Icon
          className={cn('size-3.5 shrink-0', dangerous && 'text-[var(--error)]')}
          strokeWidth={1.5}
        />
        <span
          className={cn(
            'min-w-0 flex-1 truncate font-medium',
            // 类型徽章 7 色（对齐原型 modal-variant，语义令牌）
            getVariantForType(item.type).className,
          )}
        >
          {/* 类型标签（i18n key 带 approval. 前缀：t('approval.runCommand') 等） */}
          {t(`approval.${getLabelKeyForType(item.type)}`)}
        </span>
        {!isPending && (
          <span
            className={cn(
              'shrink-0 rounded-full px-1.5 py-0.5 font-mono text-[9px]',
              isApproved ? 'bg-success/10 text-success-text' : 'bg-error/10 text-error-text',
            )}
          >
            {isApproved ? t('approval.approved') : t('approval.rejected')}
          </span>
        )}
        {/* 已决回显的关闭按钮：从 resolved 列表移除（此前 dismiss 无任何 UI 调用方） */}
        {!isPending && (
          <Button
            variant="ghost"
            size="icon"
            className="text-muted-foreground hover:bg-muted hover:text-foreground ml-auto size-5"
            aria-label={t('common.close')}
            title={t('common.close')}
            onClick={() => dismiss(item.id)}
          >
            <X className="size-3" strokeWidth={1.5} />
          </Button>
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
          <Button
            variant="ghost"
            size="sm"
            className="gap-1 border px-2 py-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={() => void respond(false, false)}
          >
            <X className="size-3" />
            {t('approval.reject')}
          </Button>
          {/* 白名单仅对支持记忆的类型显示（run_command/write_file/edit_file；
              此前无条件渲染，canRememberDecision 为死代码） */}
          {canRememberDecision(item.type) && (
            <Button
              variant="outline"
              size="sm"
              className="gap-1 px-2 py-1"
              title={t('approval.whitelistHint')}
              onClick={() => void respond(true, true)}
            >
              <ShieldCheck className="size-3" />
              {t('approval.whitelist', { minutes: REMEMBER_TTL_MINUTES })}
            </Button>
          )}
          <Button
            size="sm"
            className={cn(
              // 彩色实底按钮前景用 primary-foreground（双主题恒白）：success/error-emphasis 底均达 AA
              'ml-auto gap-1 px-2 py-1',
              dangerous
                ? 'bg-error-emphasis hover:bg-error-emphasis/90'
                : 'bg-success-emphasis hover:bg-success-emphasis/90',
            )}
            onClick={() => void respond(true, false)}
          >
            <Check className="size-3" />
            {t('approval.approve')}
          </Button>
        </div>
      )}
      {/* 拒绝后操作：编辑重提（run_command）+ 跳过（对齐参考项目 P2-10） */}
      {item.status === 'rejected' && !skipped && (
        <div className="mt-2 flex items-center gap-2">
          {resubmitCommand !== null && onEditResubmit !== undefined && (
            <Button
              variant="outline"
              size="sm"
              className="gap-1 px-2 py-1"
              onClick={() => onEditResubmit(resubmitCommand)}
            >
              <Pencil className="size-3" />
              {t('approval.editResubmit')}
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={() => {
              setSkipped(true);
              toast.info(t('approval.skipped'));
            }}
          >
            {t('approval.skip')}
          </Button>
        </div>
      )}
    </div>
  );
}
