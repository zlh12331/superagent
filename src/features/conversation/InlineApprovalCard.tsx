/**
 * InlineApprovalCard — 内联审批卡片
 *
 * 对应 prototype.html 的 `.card.paused` + `.approval-actions` + `.modal-variant` badge。
 * 对话流中内联展示的审批请求卡片，用户可直接在消息流中批准/拒绝/加入白名单。
 *
 * 7种 variant 差异化 UI：
 * - 每种 variant 从 APPROVAL_META 读取标题 / 描述 / badge / 按钮文案 / bodyFields
 * - modal-variant badge 使用 7色配色（command灰 / patch青 / tool紫 / mcp蓝 / perm橙 / dyn橙 / attest橙）
 *
 * 状态：
 * - pending：左边框 warn 色 + 脉动圆点，显示操作按钮（拒绝/加入白名单/同意）
 * - approved：左边框 accent 色，显示"已批准"
 * - denied：左边框 error 色，显示"已拒绝"
 *
 * 参考样式：prototype.html 第 1210-1308 行（卡片结构）、第 2455-2470 行（modal-variant CSS）
 */

import { useState } from 'react'
import { toast } from 'sonner'
import { Check, Shield, ShieldAlert, Terminal, X } from 'lucide-react'
import type {
  InlineApprovalCard as InlineApprovalCardData,
  ApprovalAction,
  ApprovalCardStatus,
} from '@/lib/codex/types'
import { cn } from '@/lib/utils'
import {
  APPROVAL_META,
  MODAL_VARIANT_STYLES,
  type ApprovalVariant,
} from '@/features/demo/approval-variants'

// 注意：类型名 InlineApprovalCard 与本组件名冲突，故导入时别名
export interface InlineApprovalCardProps {
  /** 审批卡片数据 */
  approval: InlineApprovalCardData
  /** 用户操作回调（点击按钮时触发） */
  onAction?:
    | ((requestId: string, action: ApprovalAction) => void)
    | undefined
  /** P2-10: 编辑后重提回调（将命令填入 composer 重新编辑） */
  onEditResubmit?: (command: string) => void
  /** 额外的 className */
  className?: string
}

// ===== 类型映射 =====

/**
 * 将 InlineApprovalCardData['type'] 映射为 ApprovalVariant。
 *
 * types.ts 中 InlineApprovalCard.type 已统一为 7 种，
 * 与 ApprovalVariant 完全一致，直接返回即可。
 */
function toApprovalVariant(
  type: InlineApprovalCardData['type']
): ApprovalVariant {
  return type
}

/**
 * 审批变体对应的图标组件。
 * 按 variant 分组：命令类用 Terminal，权限/补丁类用 Shield/ShieldAlert。
 */
function getApprovalVariantIcon(variant: ApprovalVariant) {
  switch (variant) {
    case 'command':
    case 'tool':
    case 'dyn':
      return <Terminal className="size-3.5 text-[var(--warn)]" />
    case 'patch':
    case 'attest':
      return <ShieldAlert className="size-3.5 text-[var(--warn)]" />
    case 'mcp':
    case 'perm':
      return <Shield className="size-3.5 text-[var(--warn)]" />
    default:
      return <Shield className="size-3.5 text-[var(--warn)]" />
  }
}

// ===== 本地状态管理 =====

/**
 * I-M-015: 本地审批状态（比后端 ApprovalCardStatus 多 'whitelisted' 状态）。
 * - pending：等待用户操作
 * - approved：用户点击"同意"
 * - denied：用户点击"拒绝"
 * - whitelisted：用户点击"加入白名单"
 */
type LocalStatus = 'pending' | 'approved' | 'denied' | 'whitelisted' | 'skipped'

/**
 * 后端 ApprovalCardStatus → 本地 LocalStatus 初始映射。
 * 'rejected' 映射为 'denied'（前端用"已拒绝"语义）。
 */
const INITIAL_LOCAL_STATUS: Record<ApprovalCardStatus, LocalStatus> = {
  pending: 'pending',
  approved: 'approved',
  rejected: 'denied',
}

/**
 * 审批操作 → 本地状态映射。
 * 点击按钮后立即更新本地状态，给出即时视觉反馈。
 */
const ACTION_LOCAL_STATUS: Record<ApprovalAction, LocalStatus> = {
  approve: 'approved',
  reject: 'denied',
  whitelist: 'whitelisted',
}

// ===== 状态视觉配置 =====

/**
 * 各本地状态对应的视觉配置（左边框色 / 标签 / 标签样式 / 图标类型）。
 *
 * 覆盖全部四种本地状态，避免 TypeScript 在条件分支中因类型收窄不足
 * 导致 Record 访问报错（noUncheckedIndexedAccess 严格模式）。
 */
interface LocalStatusVisual {
  /** 左边框颜色类 */
  borderClass: string
  /** 状态标签文本（pending 为空，由独立分支渲染） */
  label: string
  /** 状态标签样式类 */
  badgeClass: string
  /** 标签图标类型：'check' | 'x' | 'shield' | null */
  icon: 'check' | 'x' | 'shield' | null
}

const LOCAL_STATUS_VISUAL: Record<LocalStatus, LocalStatusVisual> = {
  pending: {
    borderClass: 'border-l-[var(--warn)]',
    label: '',
    badgeClass: 'bg-[var(--info-amber)] text-[var(--warn)]',
    icon: null,
  },
  approved: {
    borderClass: 'border-l-[var(--accent)]',
    label: '已同意',
    badgeClass: 'bg-[var(--accent-soft)] text-[var(--accent)]',
    icon: 'check',
  },
  denied: {
    borderClass: 'border-l-[var(--error)]',
    label: '已拒绝',
    badgeClass: 'bg-[rgba(255,107,107,0.1)] text-[var(--error)]',
    icon: 'x',
  },
  whitelisted: {
    borderClass: 'border-l-[var(--accent)]',
    label: '已加入白名单',
    badgeClass: 'bg-[var(--accent-soft)] text-[var(--accent)]',
    icon: 'shield',
  },
  // P2-10: skipped 状态视觉配置（半透明 + 灰色标签）
  skipped: {
    borderClass: 'border-l-[var(--text-faint)]',
    label: '已跳过',
    badgeClass: 'bg-[var(--bg-elev-2)] text-[var(--text-faint)]',
    icon: 'x',
  },
}

/* ===== Bug 6 修复：modal-variant 样式在模块级注入一次，避免多实例重复注入 <style> 标签 =====
 * 原实现将 <style> 标签放在组件渲染输出中，每渲染一个 InlineApprovalCard 实例就会
 * 向 DOM 注入一份相同的 <style>，造成冗余。改为模块加载时注入一次（幂等检查）。 */
if (typeof document !== 'undefined' && !document.getElementById('modal-variant-styles')) {
  const styleEl = document.createElement('style')
  styleEl.id = 'modal-variant-styles'
  styleEl.textContent = MODAL_VARIANT_STYLES
  document.head.appendChild(styleEl)
}

// ===== 组件 =====

/**
 * 内联审批卡片组件。
 *
 * 数据流：
 * 1. 从 approval.type 映射到 ApprovalVariant（兼容旧 8 种类型）
 * 2. 从 APPROVAL_META[variant] 读取标题 / 描述 / badge / 按钮文案 / bodyFields
 * 3. 根据 localStatus 渲染按钮组或状态标签
 *
 * 结构：
 * - card-head：脉动圆点(pending) + 图标 + 标题 + modal-variant badge + 状态标签
 * - card-body：描述文本 + payload（mono块） + bodyFields（label-value 行）
 * - approval-actions（仅 pending）：拒绝 + 加入白名单(条件) + 同意
 */
export function InlineApprovalCard({
  approval,
  onAction,
  onEditResubmit,
  className,
}: InlineApprovalCardProps) {
  // I-M-015: 本地状态（即时视觉反馈，点击按钮后立即更新，不等后端响应）
  const [localStatus, setLocalStatus] = useState<LocalStatus>(
    INITIAL_LOCAL_STATUS[approval.status]
  )
  // Bug 5 修复：后端状态更新时同步 localStatus，避免 UI 与后端状态不一致
  // 使用"渲染期间调整 state"模式（与 ChatInput 中 prevThreadId 同步一致），
  // 避免 useEffect 内 setState 导致级联渲染（react-hooks/set-state-in-effect）
  const [prevApprovalStatus, setPrevApprovalStatus] = useState(approval.status)
  if (approval.status !== prevApprovalStatus) {
    setPrevApprovalStatus(approval.status)
    setLocalStatus(INITIAL_LOCAL_STATUS[approval.status])
  }
  const isPending = localStatus === 'pending'
  // 当前状态对应的视觉配置（左边框色 / 标签 / 标签样式 / 图标）
  const visual = LOCAL_STATUS_VISUAL[localStatus]

  // 从 type 映射到 ApprovalVariant（现已统一为 7 种，直接透传），再查 APPROVAL_META
  // 使用空值合并保证 meta 一定有值（noUncheckedIndexedAccess 安全）
  const variant = toApprovalVariant(approval.type)
  const meta = APPROVAL_META[variant] ?? APPROVAL_META.command

  // I-M-015: 触发操作回调 — 先更新本地状态（即时视觉反馈），再调用 onAction
  const handleAction = (action: ApprovalAction) => {
    setLocalStatus(ACTION_LOCAL_STATUS[action])
    onAction?.(approval.requestId, action)
  }

  // P2-10: 编辑后重提 — 将命令填入 composer 供用户编辑后重新提交
  const handleEditResubmit = () => {
    onEditResubmit?.(approval.payload)
  }

  // P2-10: 跳过此命令 — 设置 skipped 状态（卡片半透明）并 toast 提示
  const handleSkip = () => {
    setLocalStatus('skipped')
    toast.info('已跳过此命令')
  }

  return (
    <div
      className={cn(
        // P0 修复：rounded-lg(8px) → rounded-[9px]（对齐原型 .card { border-radius:9px }）
        //   补 hover transform + box-shadow（对齐原型 .card:hover）
        //   补 transition 精确属性 + 200ms
        'overflow-hidden rounded-[9px] border border-[var(--border)] bg-[var(--bg-elev)]',
        'transition-[border-color,transform,box-shadow] duration-200',
        'hover:translate-x-0.5 hover:shadow-[0_4px_16px_rgba(0,0,0,0.25)]',
        // M6: 左边框 2px 实线，颜色随状态变化（对齐原型 .card::before { width:2px } 伪元素）
        'border-l-2',
        visual.borderClass,
        // P2-10: skipped 状态降低不透明度
        localStatus === 'skipped' && 'opacity-30',
        className
      )}
    >
      {/* modal-variant 配色 CSS（7色 badge 样式）已在模块级注入，见文件顶部 Bug 6 修复 */}

      {/* card-head：脉动圆点 + 图标 + 标题 + modal-variant badge + 状态标签 */}
      {/* M-B-009: padding 改为 9px 12px 9px 14px（对齐原型 .card-head） */}
      {/* P0 修复：head 容器补 font-mono text-xs（对齐原型 .card-head { font-family:var(--mono); font-size:12px }） */}
      {/*   pending 时 border-bottom-color 改为 rgba(255,180,84,0.15)（对齐原型 .card.paused .card-head） */}
      <div
        className={cn(
          'flex items-center gap-2 border-b pl-3.5 pr-3 py-[9px] font-mono text-xs',
          isPending
            ? 'border-b-[rgba(255,180,84,0.15)] bg-[rgba(255,180,84,0.05)]'
            : 'border-b-[var(--border)] bg-[var(--bg-elev-2)]'
        )}
      >
        {/* 审批类型图标 */}
        <span className="flex size-3.5 items-center justify-center">
          {getApprovalVariantIcon(variant)}
        </span>

        {/* 标题（从 APPROVAL_META 读取） */}
        <span className="font-semibold text-[var(--text)]">
          {meta.title}
        </span>

        {/* C2: modal-variant badge — 7色配色，对齐原型 .modal-variant */}
        {/* P0 修复：ml-1(4px) → ml-2(8px)（对齐原型 .modal-variant { margin-left:8px }） */}
        <span
          className={cn(
            'modal-variant ml-2 font-mono text-[9.5px] uppercase tracking-[0.1em] font-bold px-[7px] py-[2px] rounded-[4px]',
            meta.badgeCls
          )}
        >
          {meta.badge}
        </span>

        {/* 状态标签（右侧自适应） */}
        {/* P0 修复： */}
        {/*   - rounded-full(9999px) → rounded-[10px]（对齐原型 .card-status { border-radius:10px }） */}
        {/*   - 补 tracking-[0.04em]（对齐原型 .card-status { letter-spacing:0.04em }） */}
        {/*   - pending 配色 bg-[var(--info-amber)] → bg-[rgba(255,180,84,0.1)]（对齐原型 .card.paused .card-status） */}
        {/*   - 脉动圆点移入 pending 状态标签内（对齐原型 .card.paused .card-status::before） */}
        {isPending ? (
          <span className="ml-auto flex items-center gap-[5px] rounded-[10px] bg-[rgba(255,180,84,0.1)] px-2 py-0.5 text-[10.5px] font-semibold tracking-[0.04em] text-[var(--warn)]">
            {/* P0 修复：脉动圆点 8px+accent → 5px+warn（对齐原型 .card.paused .card-status::before { width:5px; height:5px; background:var(--warn) }） */}
            <span className="inline-block size-[5px] shrink-0 animate-pulse rounded-full bg-[var(--warn)]" />
            等待审批
          </span>
        ) : (
          <span
            className={cn(
              'ml-auto flex items-center gap-1 rounded-[10px] px-2 py-0.5 text-[10.5px] font-semibold tracking-[0.04em]',
              visual.badgeClass
            )}
          >
            {/* I-M-015: 根据 localStatus 渲染对应图标 */}
            {visual.icon === 'check' && <Check className="size-3" />}
            {visual.icon === 'x' && <X className="size-3" />}
            {visual.icon === 'shield' && <Shield className="size-3" />}
            {visual.label}
          </span>
        )}
      </div>

      {/* card-body：描述 + payload + bodyFields */}
      {/* P0 修复：py-2.5(10px) → p-3(12px)（对齐原型 .card-body { padding:12px }） */}
      <div className="p-3">
        {/* 描述文本（从 APPROVAL_META 读取） */}
        <div className="mb-1.5 text-xs text-[var(--text)]">
          {meta.description}
        </div>

        {/* payload 内容（mono 字体，深色终端背景块） */}
        {/* M7: 深色终端背景 #070A0E + 左侧 2px accent-dim 装饰线 */}
        {/* P0 修复（对齐原型 .cmd-line）： */}
        {/*   - font-size 11.5px → 12.5px */}
        {/*   - color text-dim → text */}
        {/*   - rounded(4px) → rounded-[5px] */}
        {/*   - padding px-3 py-2(12px 8px) → pl-3 pr-2.5 py-2(12px 10px 8px) */}
        {approval.payload && (
          <div
            className={cn(
              'overflow-x-auto rounded-[5px] border border-[var(--border)] border-l-2 border-l-[var(--accent-dim)] bg-[#070A0E] pl-3 pr-2.5 py-2',
              'font-mono text-[12.5px] text-[var(--text)]',
              'whitespace-pre-wrap'
            )}
          >
            {variant === 'command' && (
              <span className="mr-1.5 text-[var(--accent)]">$</span>
            )}
            {approval.payload}
          </div>
        )}

        {/* C1: bodyFields — 从 APPROVAL_META 读取，按 variant 差异化展示字段 */}
        {meta.bodyFields.length > 0 && (
          <div className="mt-2 flex flex-col gap-1">
            {meta.bodyFields.map(field => (
              <div
                key={field.label}
                className="flex items-center gap-2 text-[11px]"
              >
                <span className="w-20 shrink-0 text-[var(--text-faint)]">
                  {field.label}
                </span>
                <span className="font-mono text-[var(--text-dim)]">
                  {field.value}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* I-M-015: approval-actions — pending 显示按钮，非 pending 显示状态标签 */}
      {isPending ? (
        <div className="flex gap-2 border-t border-[var(--border)] bg-[var(--bg-elev-2)] px-3 py-2.5">
          {/* 拒绝按钮（文案从 meta.denyLabel 读取） */}
          {/* P0 修复：补 font-sans + cursor-pointer + border-[rgba(255,107,107,0.3)] + hover:border + transition 精确属性 */}
          <button
            type="button"
            onClick={() => handleAction('reject')}
            className={cn(
              'flex flex-1 cursor-pointer items-center justify-center gap-[5px] rounded-md border px-3 py-[7px] font-sans',
              'border-[rgba(255,107,107,0.3)] bg-transparent text-xs font-semibold text-[var(--error)]',
              'transition-[background-color,border-color,color,box-shadow] duration-[120ms]',
              'hover:border-[var(--error)] hover:bg-[rgba(255,107,107,0.08)]'
            )}
          >
            <X className="size-3" />
            {meta.denyLabel}
          </button>

          {/* 加入白名单按钮 — 仅当 meta.hasWhitelist 为 true 时渲染 */}
          {/* M8: 边框和文字颜色改为 teal/accent */}
          {/* P0 修复：补 font-sans + cursor-pointer + hover:border + transition 精确属性 */}
          {meta.hasWhitelist && (
            <button
              type="button"
              onClick={() => handleAction('whitelist')}
              className={cn(
                'flex flex-1 cursor-pointer items-center justify-center gap-[5px] rounded-md border px-3 py-[7px] font-sans',
                'border-[var(--accent)]/30 bg-transparent text-xs font-semibold text-[var(--accent)]',
                'transition-[background-color,border-color,color,box-shadow] duration-[120ms]',
                'hover:border-[var(--accent)] hover:bg-[var(--accent-glow)]'
              )}
            >
              <Shield className="size-3" />
              加入白名单
            </button>
          )}

          {/* 同意按钮（文案从 meta.approveLabel 读取） */}
          {/* P0 修复：补 font-sans + cursor-pointer + border + hover:border + transition 精确属性 */}
          <button
            type="button"
            onClick={() => handleAction('approve')}
            className={cn(
              'flex flex-1 cursor-pointer items-center justify-center gap-[5px] rounded-md border border-[var(--accent)] px-3 py-[7px] font-sans',
              'bg-[var(--accent)] text-xs font-semibold text-[#001814]',
              'transition-[background-color,border-color,color,box-shadow] duration-[120ms]',
              'hover:border-[var(--accent-dim)] hover:bg-[var(--accent-dim)]'
            )}
          >
            <Check className="size-3" />
            {meta.approveLabel}
          </button>
        </div>
      ) : (
        // I-M-015: 非.pending 状态 — 按钮区域替换为状态标签
        <div className="flex items-center justify-center gap-1.5 border-t border-[var(--border)] bg-[var(--bg-elev-2)] px-3 py-2.5">
          {visual.icon === 'check' && <Check className="size-3 text-[var(--accent)]" />}
          {visual.icon === 'x' && <X className="size-3 text-[var(--error)]" />}
          {visual.icon === 'shield' && <Shield className="size-3 text-[var(--accent)]" />}
          <span className="text-xs font-semibold text-[var(--text-dim)]">
            {visual.label}
          </span>
          {/* P2-10: rejected(denied) 状态追加「编辑后重提」和「跳过」按钮 */}
          {localStatus === 'denied' && (
            <>
              <button
                type="button"
                onClick={handleEditResubmit}
                className="ml-2 cursor-pointer rounded-md border border-[var(--accent)]/30 px-2 py-0.5 text-[11px] font-semibold text-[var(--accent)] transition-colors hover:bg-[var(--accent-glow)]"
              >
                编辑后重提
              </button>
              <button
                type="button"
                onClick={handleSkip}
                className="cursor-pointer rounded-md border border-[var(--border)] px-2 py-0.5 text-[11px] font-semibold text-[var(--text-dim)] transition-colors hover:bg-[var(--bg-elev)]"
              >
                跳过
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}
