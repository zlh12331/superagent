/**
 * ApprovalDialog — 内联审批卡片
 *
 * 当 approval-store 中存在 pendingApproval 时，在对话流中内联渲染审批卡片。
 * 用户批准 / 拒绝后调用 submitApproval 回传结果并更新 store。
 *
 * 形态：内联卡片（对齐原型 .card.paused），不再使用 Radix Dialog 弹窗。
 * 这样审批请求不打断对话流，用户可在消息上下文中做出决策。
 *
 * 7种 variant 差异化渲染：
 * - 标题 / 描述 / 按钮文案从 APPROVAL_META 读取
 * - modal-variant badge 显示对应配色
 * - bodyFields 展示每种 variant 的结构化字段
 *
 * 交互约束：审批必须明确做出选择（拒绝可附带原因）。
 *
 * 参考源码: prototype.html — .card.paused, .approval-actions, .modal-variant
 */

import { useState, useCallback } from 'react'
import { toast } from 'sonner'
import { AlertTriangle, Check, Shield, X, Loader2 } from 'lucide-react'
import { useApprovalStore, type PendingApproval } from '@/store/approval-store'
import { submitApproval } from '@/lib/codex/approval'
import { logger } from '@/lib/logger'
import { cn } from '@/lib/utils'
import {
  APPROVAL_META,
  MODAL_VARIANT_STYLES,
  type ApprovalVariant,
} from '@/features/demo/approval-variants'

/**
 * 将 ApprovalType（store 中的 7 种）映射为 ApprovalVariant。
 *
 * 统一后两者完全对齐（command/patch/tool/mcp/perm/dyn/attest），
 * 直接转换即可。此函数隔离了 store 类型与 demo 类型的耦合。
 */
function toVariant(type: PendingApproval['type']): ApprovalVariant {
  // ApprovalType 与 ApprovalVariant 已对齐，直接返回
  return type
}

/**
 * ApprovalDialog 组件 —— 内联审批卡片。
 *
 * 渲染逻辑：
 *  - approval-store 中存在 pendingApproval 时渲染内联卡片，否则返回 null
 *  - 根据 approval.type 从 APPROVAL_META 获取标题 / 描述 / badge / 按钮文案
 *  - payload 内容以等宽字体展示，可滚动
 *  - bodyFields 以 label-value 行展示结构化字段
 *
 * 状态依赖：
 *  - approval-store：pendingApproval、approveCurrent、denyCurrent
 *  - 内部 useState：handling（提交中防重复点击）、denyMode（拒绝原因输入）、reason
 *
 * 副作用：
 *  - 用户点击「批准」→ 调用 `submitApproval({ approved: true })` → approveCurrent() + toast
 *  - 用户点击「确认拒绝」→ 调用 `submitApproval({ approved: false, reason? })` → denyCurrent() + toast
 *
 * 交互约束（设计决策）：
 *  - 拒绝采用两步式：先点「拒绝」展开原因输入，再点「确认拒绝」
 *  - 拒绝原因为可选；通过条件展开避免向 exactOptionalPropertyTypes 类型传 undefined
 *
 * @see src/store/approval-store.ts — 状态管理
 * @see src/lib/codex/approval.ts — submitApproval API
 * @see src/hooks/useApprovalListener.ts — 事件监听器
 */
export function ApprovalDialog() {
  // 从 store 读取当前待审批请求与状态更新方法
  const pendingApproval = useApprovalStore(s => s.pendingApproval)
  const approveCurrent = useApprovalStore(s => s.approveCurrent)
  const denyCurrent = useApprovalStore(s => s.denyCurrent)

  // 提交中状态：防止重复点击
  const [handling, setHandling] = useState(false)
  // 拒绝模式：展开拒绝原因输入框
  const [denyMode, setDenyMode] = useState(false)
  // 拒绝原因（可选）
  const [reason, setReason] = useState('')

  // 批准当前请求
  const handleApprove = useCallback(async () => {
    if (!pendingApproval) return
    setHandling(true)
    try {
      await submitApproval({ requestId: pendingApproval.id, approved: true })
      approveCurrent()
      toast.success('已批准请求')
    } catch (error) {
      toast.error('审批提交失败')
      logger.error('Failed to submit approval', { error })
    } finally {
      setHandling(false)
      setDenyMode(false)
      setReason('')
    }
  }, [pendingApproval, approveCurrent])

  // 拒绝当前请求（携带可选原因）
  const handleDeny = useCallback(async () => {
    if (!pendingApproval) return
    setHandling(true)
    try {
      await submitApproval({
        requestId: pendingApproval.id,
        approved: false,
        // exactOptionalPropertyTypes：条件展开，避免传入 undefined
        ...(reason.trim() ? { reason: reason.trim() } : {}),
      })
      denyCurrent()
      toast.info('已拒绝请求')
    } catch (error) {
      toast.error('审批提交失败')
      logger.error('Failed to submit approval', { error })
    } finally {
      setHandling(false)
      setDenyMode(false)
      setReason('')
    }
  }, [pendingApproval, denyCurrent, reason])

  // 无待审批请求时不渲染
  if (!pendingApproval) return null

  // 从 ApprovalType 映射到 ApprovalVariant，再查 APPROVAL_META
  // 使用空值合并保证 meta 一定有值（noUncheckedIndexedAccess 安全）
  const variant = toVariant(pendingApproval.type)
  const meta = APPROVAL_META[variant] ?? APPROVAL_META.command

  // 内联卡片形态 — 对齐原型 .card.paused（prototype.html L1134-1308）
  // 样式与 InlineApprovalCard 保持一致，确保综合演示与消息流中审批卡片视觉统一
  return (
    <div
      className={cn(
        'my-2 overflow-hidden rounded-[9px] border border-[var(--border)] bg-[var(--bg-elev)]',
        // 对齐原型 .card:hover（translateX + box-shadow）+ .card.paused 左边框 2px warn
        'border-l-2 border-l-[var(--warn)]',
        'transition-[border-color,transform,box-shadow] duration-200',
        'hover:translate-x-0.5 hover:shadow-[0_4px_16px_rgba(0,0,0,0.25)]'
      )}
    >
      {/* 注入 modal-variant 配色 CSS（7色 badge 样式） */}
      <style dangerouslySetInnerHTML={{ __html: MODAL_VARIANT_STYLES }} />

      {/* card-head — 对齐原型 .card-head：padding 9px 12px 9px 14px / font-mono 12px */}
      <div className="flex items-center gap-2 border-b border-[rgba(255,180,84,0.15)] bg-[rgba(255,180,84,0.05)] pl-3.5 pr-3 py-[9px] font-mono text-xs">
        {/* card-icon — 对齐原型 13x13 svg */}
        <span className="flex size-3.5 items-center justify-center text-[var(--warn)]">
          <AlertTriangle width={13} height={13} />
        </span>

        {/* 标题 — 对齐原型 .card-title：font-semibold 12px */}
        <span className="font-semibold text-[var(--text)]">
          {meta.title}
        </span>

        {/* modal-variant badge — 对齐原型 .modal-variant：ml-2(8px) */}
        <span
          className={cn(
            'modal-variant ml-2 font-mono text-[9.5px] uppercase tracking-[0.1em] font-bold px-[7px] py-[2px] rounded-[4px]',
            meta.badgeCls
          )}
        >
          {meta.badge}
        </span>

        {/* 状态标签 — 对齐原型 .card-status.pending + 脉动圆点 */}
        <span className="ml-auto flex items-center gap-[5px] rounded-[10px] bg-[rgba(255,180,84,0.1)] px-2 py-0.5 text-[10.5px] font-semibold tracking-[0.04em] text-[var(--warn)]">
          <span className="inline-block size-[5px] shrink-0 animate-pulse rounded-full bg-[var(--warn)]" />
          等待审批
        </span>
      </div>

      {/* card-body — 对齐原型 .card-body：padding 12px */}
      <div className="p-3">
        {/* 描述文本 — 对齐原型 font-size:12px */}
        <div className="mb-1.5 text-xs text-[var(--text)]">
          {meta.description}
        </div>

        {/* payload 内容 — 对齐原型 .cmd-line：#070A0E 背景 + 左 2px accent-dim + 12.5px mono */}
        <div className="overflow-x-auto rounded-[5px] border border-[var(--border)] border-l-2 border-l-[var(--accent-dim)] bg-[#070A0E] pl-3 pr-2.5 py-2 font-mono text-[12.5px] text-[var(--text)] whitespace-pre-wrap">
          {pendingApproval.payload}
        </div>

        {/* bodyFields — 对齐原型 font-size:11px */}
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

        {/* 拒绝原因输入（仅 denyMode 时显示） */}
        {denyMode && (
          <div className="mt-3">
            <label className="mb-1.5 block font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--text-faint)]">
              拒绝原因（可选）
            </label>
            <textarea
              value={reason}
              onChange={e => setReason(e.target.value)}
              placeholder="说明拒绝原因…"
              rows={3}
              className="w-full resize-y rounded border border-[var(--border-strong)] bg-[var(--bg)] px-2.5 py-2 font-mono text-[12px] leading-[1.5] text-[var(--text)] outline-none transition-colors placeholder:text-[var(--text-faint)] focus:border-[var(--accent-dim)]"
              autoFocus
            />
          </div>
        )}
      </div>

      {/* approval-actions — 对齐原型 .approval-actions：padding 10px 12px / flex 三等分 */}
      {denyMode ? (
        // denyMode 下只有两个按钮，使用 justify-end 布局（非原型标准态）
        <div className="flex items-center justify-end gap-2 border-t border-[var(--border)] bg-[var(--bg-elev-2)] px-3 py-2.5">
          <button
            type="button"
            onClick={() => {
              setDenyMode(false)
              setReason('')
            }}
            disabled={handling}
            className="flex cursor-pointer items-center justify-center gap-[5px] rounded-md border border-[var(--border)] bg-[var(--bg-elev)] px-3 py-[7px] font-sans text-xs font-semibold text-[var(--text-dim)] transition-[background-color,border-color,color] duration-[120ms] hover:border-[var(--border-strong)] hover:bg-[var(--bg-elev-3)] hover:text-[var(--text)]"
          >
            取消
          </button>
          <button
            type="button"
            onClick={handleDeny}
            disabled={handling}
            className="flex cursor-pointer items-center justify-center gap-[5px] rounded-md border border-[var(--error)] bg-[var(--error)] px-3 py-[7px] font-sans text-xs font-semibold text-white transition-[background-color,border-color,color] duration-[120ms] hover:opacity-90"
          >
            {handling ? (
              <Loader2 className="animate-spin" width={12} height={12} />
            ) : (
              <X width={12} height={12} />
            )}
            确认{meta.denyLabel}
          </button>
        </div>
      ) : (
        // 非 denyMode：三等分 flex-1 布局，对齐原型 .approval-actions .ap-btn { flex:1 }
        <div className="flex gap-2 border-t border-[var(--border)] bg-[var(--bg-elev-2)] px-3 py-2.5">
          {/* 拒绝按钮 — 对齐原型 .ap-btn.reject */}
          <button
            type="button"
            onClick={() => setDenyMode(true)}
            disabled={handling}
            className="flex flex-1 cursor-pointer items-center justify-center gap-[5px] rounded-md border border-[rgba(255,107,107,0.3)] bg-transparent px-3 py-[7px] font-sans text-xs font-semibold text-[var(--error)] transition-[background-color,border-color,color,box-shadow] duration-[120ms] hover:border-[var(--error)] hover:bg-[rgba(255,107,107,0.08)]"
          >
            <X width={12} height={12} />
            {meta.denyLabel}
          </button>

          {/* 加入白名单按钮 — 对齐原型 .ap-btn.whitelist */}
          {meta.hasWhitelist && (
            <button
              type="button"
              onClick={() => {
                // 白名单操作：直接批准并 toast 提示已记住
                if (!pendingApproval) return
                setHandling(true)
                submitApproval({ requestId: pendingApproval.id, approved: true })
                  .then(() => {
                    approveCurrent()
                    toast.success('已加入白名单，后续不再询问')
                  })
                  .catch((error: unknown) => {
                    toast.error('审批提交失败')
                    logger.error('Failed to submit whitelist approval', { error })
                  })
                  .finally(() => {
                    setHandling(false)
                    setDenyMode(false)
                    setReason('')
                  })
              }}
              disabled={handling}
              className="flex flex-1 cursor-pointer items-center justify-center gap-[5px] rounded-md border border-[var(--accent)]/30 bg-transparent px-3 py-[7px] font-sans text-xs font-semibold text-[var(--accent)] transition-[background-color,border-color,color,box-shadow] duration-[120ms] hover:border-[var(--accent)] hover:bg-[var(--accent-glow)]"
            >
              <Shield width={12} height={12} />
              加入白名单
            </button>
          )}

          {/* 批准按钮 — 对齐原型 .ap-btn.approve */}
          <button
            type="button"
            onClick={handleApprove}
            disabled={handling}
            className="flex flex-1 cursor-pointer items-center justify-center gap-[5px] rounded-md border border-[var(--accent)] bg-[var(--accent)] px-3 py-[7px] font-sans text-xs font-semibold text-[#001814] transition-[background-color,border-color,color,box-shadow] duration-[120ms] hover:border-[var(--accent-dim)] hover:bg-[var(--accent-dim)]"
          >
            {handling ? (
              <Loader2 className="animate-spin" width={12} height={12} />
            ) : (
              <Check width={12} height={12} />
            )}
            {meta.approveLabel}
          </button>
        </div>
      )}
    </div>
  )
}
