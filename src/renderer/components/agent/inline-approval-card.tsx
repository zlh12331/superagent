import { APPROVAL_TIMEOUT_MINUTES, REMEMBER_TTL_MINUTES } from '@code-agent/shared/renderer';
import { Check, Pencil, ShieldCheck, X } from 'lucide-react';
import { type ReactElement, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useShallow } from 'zustand/react/shallow';
import { Button } from '@/components/ui/button';
import { i18n } from '@/i18n';
import { useTranslation } from '@/i18n/use-translation';
import { sendApprovalResponse } from '@/lib/agent/agent-actions';
import { hasIpcBridge } from '@/lib/ipc';
import { cn } from '@/lib/utils';
import { type ApprovalItem, useApprovalsStore } from '@/stores/transient/approvals-store';
import { StructuredPreview } from './approval-preview';
import { getApprovalMeta, getNonEmptyField } from './approval-utils';

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

/** 稳定空数组引用（selector 返回空时避免每渲染新建，触发无谓重渲染） */
const NO_ITEMS: readonly ApprovalItem[] = [];

/**
 * 发送审批响应（模块级包装：保持组件内调用签名稳定）
 *
 * @returns 是否成功（失败由调用方 toast，主进程侧 5 分钟超时兜底仍生效）
 */
async function respondApproval(
  approvalId: string,
  approved: boolean,
  rememberDecision: boolean,
): Promise<boolean> {
  return sendApprovalResponse({ approvalId, approved, rememberDecision });
}

/** 已决状态徽章（approved/rejected 双态） */
function StatusBadge({ approved }: { readonly approved: boolean }): ReactElement {
  const { t } = useTranslation();
  return (
    <span
      className={cn(
        'shrink-0 rounded-full px-1.5 py-0.5 font-mono text-2xs',
        approved ? 'bg-success/10 text-success-text' : 'bg-error/10 text-error-text',
      )}
    >
      {approved ? t('approval.approved') : t('approval.rejected')}
    </span>
  );
}

/**
 * 审批超时倒计时（38 号 spec 阶段 2：主进程 5 分钟超时兜底对用户可见化）
 *
 * 以审批项 createdAt 为基准计算剩余分钟（与 store 入队时间戳同源）；
 * 仅剩最后 1 分钟时切换警示态。挂载期一次性算出剩余整分钟即可——
 * 逐秒刷新对「分钟粒度」的提示无增益，徒增重渲染。
 */
function useTimeoutHint(
  createdAt: number,
  active: boolean,
): {
  readonly minutesLeft: number;
  readonly expiring: boolean;
} {
  const [secondsLeft, setSecondsLeft] = useState(
    () => Math.max(0, createdAt + APPROVAL_TIMEOUT_MINUTES * 60_000 - Date.now()) / 1000,
  );
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      setSecondsLeft(
        Math.max(0, createdAt + APPROVAL_TIMEOUT_MINUTES * 60_000 - Date.now()) / 1000,
      );
    }, 15_000);
    return () => {
      clearInterval(timer);
    };
  }, [createdAt, active]);
  const minutesLeft = Math.ceil(secondsLeft / 60);
  return { minutesLeft, expiring: active && minutesLeft <= 1 };
}

/** pending 操作按钮行：拒绝 / 白名单 / 批准（对齐原型 .card.paused 三按钮） */
function PendingActions({
  meta,
  dangerous,
  onRespond,
}: {
  readonly meta: ReturnType<typeof getApprovalMeta>;
  readonly dangerous: boolean;
  readonly onRespond: (approved: boolean, rememberDecision: boolean) => void;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <div className="mt-2 flex items-center gap-2">
      <Button
        variant="ghost"
        size="sm"
        className="gap-1 border px-2 py-1 text-muted-foreground hover:bg-muted hover:text-foreground"
        onClick={() => onRespond(false, false)}
      >
        <X className="size-3" />
        {t('approval.reject')}
      </Button>
      {meta.canRemember && (
        <Button
          variant="outline"
          size="sm"
          className="gap-1 px-2 py-1"
          title={t('approval.whitelistHint')}
          onClick={() => onRespond(true, true)}
        >
          <ShieldCheck className="size-3" />
          {t('approval.whitelist', { minutes: REMEMBER_TTL_MINUTES })}
        </Button>
      )}
      <Button
        size="sm"
        className={cn(
          'ml-auto gap-1 px-2 py-1',
          dangerous
            ? 'bg-error-emphasis hover:bg-error-emphasis/90'
            : 'bg-success-emphasis hover:bg-success-emphasis/90',
        )}
        onClick={() => onRespond(true, false)}
      >
        <Check className="size-3" />
        {t('approval.approve')}
      </Button>
    </div>
  );
}

/** 拒绝后操作行：编辑重提（run_command）+ 跳过（对齐参考项目 P2-10） */
function RejectedActions({
  resubmitCommand,
  onEditResubmit,
  onSkip,
}: {
  readonly resubmitCommand: string | null;
  readonly onEditResubmit: ((command: string) => void) | undefined;
  readonly onSkip: () => void;
}): ReactElement {
  const { t } = useTranslation();
  return (
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
        onClick={onSkip}
      >
        {t('approval.skip')}
      </Button>
    </div>
  );
}

/** 超时提示行（pending 态；主进程超时即拒绝，让用户知道时限存在） */
function TimeoutHint({
  minutesLeft,
  expiring,
}: {
  readonly minutesLeft: number;
  readonly expiring: boolean;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <p
      className={cn(
        'mt-1.5 font-mono text-2xs',
        expiring ? 'text-warn-text' : 'text-muted-foreground',
      )}
    >
      {expiring && <span className="mr-1">{t('approval.expiresSoon')}·</span>}
      {t('approval.timeoutHint', {
        minutes: expiring ? minutesLeft : APPROVAL_TIMEOUT_MINUTES,
      })}
    </p>
  );
}

/** 响应审批副作用（模块级：store 更新 + IPC 回传；失败 toast 兜底） */
async function respondToApproval(args: {
  readonly item: { readonly id: string };
  readonly approved: boolean;
  readonly rememberDecision: boolean;
  readonly approve: (id: string) => void;
  readonly reject: (id: string) => void;
}): Promise<void> {
  const { item, approved, rememberDecision, approve, reject } = args;
  if (approved) {
    approve(item.id);
  } else {
    reject(item.id);
  }
  if (!hasIpcBridge()) {
    return;
  }
  const ok = await respondApproval(item.id, approved, rememberDecision);
  if (!ok) {
    toast.error(i18n.t('approval.responseFailed'));
  }
}

/** 卡片头部：图标 + 类型标签 + 状态徽章/关闭按钮 */
function CardHeader({
  meta,
  dangerous,
  typeLabel,
  isPending,
  isApproved,
  isExpired,
  expiredReason,
  onClose,
}: {
  readonly meta: ReturnType<typeof getApprovalMeta>;
  readonly dangerous: boolean;
  readonly typeLabel: string;
  readonly isPending: boolean;
  readonly isApproved: boolean;
  /** 主进程判定超时/中断（非用户操作）——终态徽章走中性灰而非拒绝红 */
  readonly isExpired: boolean;
  /** 过期原因（超时/中断两种文案） */
  readonly expiredReason: 'timed-out' | 'aborted' | undefined;
  readonly onClose: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const Icon = meta.icon;
  return (
    <div className="flex items-center gap-2">
      <Icon className={cn('size-3.5 shrink-0', dangerous && 'text-error')} strokeWidth={1.5} />
      <span className={cn('min-w-0 flex-1 truncate font-medium', meta.className)}>{typeLabel}</span>
      {isExpired ? (
        <span className="bg-muted text-muted-foreground shrink-0 rounded-full px-1.5 py-0.5 font-mono text-2xs">
          {expiredReason === 'aborted' ? t('approval.aborted') : t('approval.timedOut')}
        </span>
      ) : (
        !isPending && <StatusBadge approved={isApproved} />
      )}
      {!isPending && (
        <Button
          variant="ghost"
          size="icon"
          className="text-muted-foreground hover:bg-muted hover:text-foreground ml-auto size-5"
          aria-label={t('common.close')}
          title={t('common.close')}
          onClick={onClose}
        >
          <X className="size-3" strokeWidth={1.5} />
        </Button>
      )}
    </div>
  );
}

/**
 * 内联审批卡片（队列呈现）
 *
 * 由 ChatPanel 在消息列表上方渲染。**一次渲染本会话的全部待审批**——
 * 2026-10-08 前用 `reverse().find()` 只取最新一条，导致同会话并行审批时
 * 先到的那个从头到尾没有 UI（用户批准后卡片还会"跳变"成另一个未处理项），
 * 且那一条既看不到又无超时兜底（主进程机器同样只记第一个）。
 * 现在改为队列：按 createdAt 升序（先入先审）逐条渲染，各自独立可操作。
 *
 * 无 pending 时回落展示最近一条已决（保持原有"操作后回显状态"的反馈语义）。
 */
export function InlineApprovalCard({
  sessionId,
  onEditResubmit,
}: InlineApprovalCardProps): ReactElement | null {
  const items = useApprovalsStore(
    useShallow((state) => {
      const pending = state.pending.filter((p) => p.sessionId === sessionId);
      if (pending.length > 0) return pending;
      const latest = state.resolved.find((r) => r.sessionId === sessionId);
      return latest !== undefined ? [latest] : NO_ITEMS;
    }),
  );

  if (items.length === 0) {
    return null;
  }
  return (
    <div className="flex flex-col">
      {items.map((item) => (
        <ApprovalCard
          key={item.id}
          item={item}
          {...(onEditResubmit !== undefined ? { onEditResubmit } : {})}
        />
      ))}
    </div>
  );
}

/**
 * 单张审批卡（队列中的一项）
 *
 * 每张卡独立持有自己的倒计时与跳过态——由 `key={item.id}` 保证条目切换时
 * 状态重置（此前单卡时代靠 prevItemId 手动重置，队列化后不再需要）。
 */
function ApprovalCard({
  item,
  onEditResubmit,
}: {
  readonly item: ApprovalItem;
  readonly onEditResubmit?: (command: string) => void;
}): ReactElement {
  const { t } = useTranslation();
  const approve = useApprovalsStore((state) => state.approve);
  const reject = useApprovalsStore((state) => state.reject);
  const dismiss = useApprovalsStore((state) => state.dismiss);
  const [skipped, setSkipped] = useState(false);
  const timeout = useTimeoutHint(item.createdAt, item.status === 'pending');

  const respond = (approved: boolean, rememberDecision: boolean): void => {
    void respondToApproval({
      item,
      approved,
      rememberDecision,
      approve,
      reject,
    });
  };

  const meta = getApprovalMeta(item.type);
  const isPending = item.status === 'pending';
  const isApproved = item.status === 'approved';
  const isExpired = item.status === 'expired';
  const dangerous = meta.dangerous;
  const resubmitCommand =
    item.type === 'run_command' ? (getNonEmptyField(item.input, 'command') ?? null) : null;

  return (
    <div
      className={cn(
        'mx-3 mt-2 rounded-lg border bg-card px-3 py-2 text-xs',
        isPending && 'border-l-4 border-l-warn',
        isApproved && 'border-l-4 border-l-success',
        item.status === 'rejected' && 'border-l-4 border-l-error',
        isExpired && 'border-l-4 border-l-muted-foreground/50',
        skipped && 'opacity-40',
      )}
      role="alert"
      aria-atomic="false"
    >
      <CardHeader
        meta={meta}
        dangerous={dangerous}
        typeLabel={t(`approval.types.${item.type}`)}
        isPending={isPending}
        isApproved={isApproved}
        isExpired={isExpired}
        expiredReason={item.externalDecision}
        onClose={() => dismiss(item.id)}
      />

      {item.description !== '' && (
        <p className="text-muted-foreground mt-1 leading-relaxed whitespace-pre-wrap">
          {item.description}
        </p>
      )}
      {item.input !== undefined && (
        <div className="mt-1.5">
          <StructuredPreview type={item.type} input={item.input} />
        </div>
      )}

      {isPending && <TimeoutHint minutesLeft={timeout.minutesLeft} expiring={timeout.expiring} />}

      {isPending && (
        <PendingActions
          meta={meta}
          dangerous={dangerous}
          onRespond={(approved, rememberDecision) => void respond(approved, rememberDecision)}
        />
      )}
      {item.status === 'rejected' && !skipped && (
        <RejectedActions
          resubmitCommand={resubmitCommand}
          onEditResubmit={onEditResubmit}
          onSkip={() => {
            setSkipped(true);
            toast.info(t('approval.skipped'));
          }}
        />
      )}
    </div>
  );
}
