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
import { useApprovalsStore } from '@/stores/transient/approvals-store';
import { StructuredPreview } from './approval-preview';
import { getApprovalMeta, getField } from './approval-utils';

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

/** 已决状态徽章（approved/rejected 双态） */
function StatusBadge({ approved }: { readonly approved: boolean }): ReactElement {
  const { t } = useTranslation();
  return (
    <span
      className={cn(
        'shrink-0 rounded-full px-1.5 py-0.5 font-mono text-[9px]',
        approved ? 'bg-success/10 text-success-text' : 'bg-error/10 text-error-text',
      )}
    >
      {approved ? t('approval.approved') : t('approval.rejected')}
    </span>
  );
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
      {/* 白名单仅对支持记忆的类型显示（run_command/write_file/edit_file） */}
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
          // 彩色实底按钮前景用 primary-foreground（双主题恒白）：success/error-emphasis 底均达 AA
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

  // 类型元数据单一入口（图标/徽章类/危险标记/白名单支持）
  const meta = getApprovalMeta(item.type);
  const Icon = meta.icon;
  const isPending = item.status === 'pending';
  const isApproved = item.status === 'approved';
  const dangerous = meta.dangerous;
  // 编辑重提命令：run_command 类型从 input.command 提取（其他类型无命令语义，不显示；
  // 复用 getField 安全读取，与 approval-preview 的载荷解析风格一致）
  const resubmitCommand =
    item.type === 'run_command' ? (getField(item.input, 'command') ?? null) : null;

  return (
    <div
      className={cn(
        'mx-3 mt-2 rounded-lg border bg-card px-3 py-2 text-xs',
        isPending && 'border-l-4 border-l-warn',
        isApproved && 'border-l-4 border-l-success',
        item.status === 'rejected' && 'border-l-4 border-l-error',
        skipped && 'opacity-40',
      )}
      role="alert"
      aria-live="polite"
    >
      {/* 头部：图标 + 类型 + 状态 */}
      <div className="flex items-center gap-2">
        <Icon className={cn('size-3.5 shrink-0', dangerous && 'text-error')} strokeWidth={1.5} />
        <span
          className={cn(
            'min-w-0 flex-1 truncate font-medium',
            // 类型徽章（语义令牌类，来自 APPROVAL_META 单表）
            meta.className,
          )}
        >
          {/* 类型标签：i18n 协议键收进 approval.types 子段（与 UI 键的 camelCase 分区），
              键 = ApprovalType 字面量，零映射层 */}
          {t(`approval.types.${item.type}`)}
        </span>
        {!isPending && <StatusBadge approved={isApproved} />}
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
          <StructuredPreview type={item.type} input={item.input} />
        </div>
      )}

      {/* pending 操作按钮：拒绝 / 白名单 / 批准（对齐原型 .card.paused 三按钮） */}
      {isPending && (
        <PendingActions
          meta={meta}
          dangerous={dangerous}
          onRespond={(approved, rememberDecision) => void respond(approved, rememberDecision)}
        />
      )}
      {/* 拒绝后操作：编辑重提（run_command）+ 跳过（对齐参考项目 P2-10） */}
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
