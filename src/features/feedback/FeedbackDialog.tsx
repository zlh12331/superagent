/**
 * @file FeedbackDialog — 反馈弹窗组件
 *
 * 参照 prototype.html `openFeedback` 函数（行 14515-14559）实现：
 * - 4 种反馈类型选择（bug/feature/ux/other），按钮组切换，选中项高亮 accent 色
 * - 描述 textarea（5 行）
 * - 附件区：添加截图按钮（mock，点击 toast 提示）+ 系统信息复选框 + 日志复选框
 * - 取消按钮 + 提交反馈按钮
 * - 提交时调用 feedback/upload API（通过 window.__CODEX_API__，不存在则 mock 800ms 延迟成功）
 * - 提交中按钮 disabled + 文案改为"提交中..."
 * - 成功后显示成功消息 1.5s 后关闭
 * - 失败显示错误消息 2s 后关闭
 *
 * @see prototype.html 行 14515-14559 — openFeedback 函数
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { logger } from '@/lib/logger'

/** 反馈类型字面量联合 — 对齐原型 data-type 属性 */
// F1: praise → ux，对齐原型 data-type="ux"
type FeedbackType = 'bug' | 'feature' | 'ux' | 'other'

/** 提交结果状态：null=表单态、success=成功、error=失败 */
type FeedbackResult = 'success' | 'error' | null

/** FeedbackDialog 组件 props */
interface FeedbackDialogProps {
  /** 弹窗是否打开 */
  open: boolean
  /** 弹窗开关回调（由父组件控制） */
  onOpenChange: (open: boolean) => void
}

/** 反馈类型选项配置 — 用于渲染按钮组 */
interface FeedbackTypeOption {
  /** 类型值 */
  value: FeedbackType
  /** 显示标签 */
  label: string
  /** emoji 图标字符（对齐原型 .feedback-type-grid 的 emoji 显示） */
  emoji: string
}

/** 4 种反馈类型 — 对齐原型 .feedback-type-grid（行 14519），E1 修复：改回 emoji 图标 */
// F1: 第 3 项对齐原型 data-type="ux"（🎨 UX 改进），原 React 误用 praise/赞扬
const FEEDBACK_TYPES: FeedbackTypeOption[] = [
  { value: 'bug', label: 'Bug', emoji: '🐛' },
  { value: 'feature', label: '功能建议', emoji: '💡' },
  { value: 'ux', label: 'UX 改进', emoji: '🎨' },
  { value: 'other', label: '其他', emoji: '💬' },
]

/** 后端 CodexAPI 调用签名（若 window.__CODEX_API__ 被注入则存在） */
interface CodexApiShape {
  call: (method: string, params: Record<string, unknown>) => Promise<unknown>
}

/**
 * 上传反馈到后端。
 *
 * 优先通过 window.__CODEX_API__ 调用 feedback/upload，
 * 若全局 API 不存在则回退到 mock（800ms 延迟后成功），便于独立开发与测试。
 *
 * 后端协议（对齐原型行 14544-14550）：
 *   FeedbackUploadParams {
 *     classification: string           // 反馈类型
 *     reason?: string                  // 描述
 *     includeLogs?: boolean            // 是否附带日志
 *     extraLogFiles?: string[] | null  // 额外日志文件（系统信息）
 *   }
 *
 * @param params - 反馈提交参数
 */
async function uploadFeedback(params: {
  classification: FeedbackType
  reason: string
  includeLogs: boolean
  includeSysInfo: boolean
}): Promise<void> {
  // 安全访问可能注入的全局 API（避免直接扩展 Window 类型声明）
  const codexApi = (window as unknown as { __CODEX_API__?: CodexApiShape })
    .__CODEX_API__

  if (codexApi) {
    await codexApi.call('feedback/upload', {
      classification: params.classification,
      reason: params.reason,
      includeLogs: params.includeLogs,
      extraLogFiles: params.includeSysInfo ? ['system_info.json'] : null,
    })
    return
  }

  // Mock 回退：模拟 800ms 网络延迟后成功
  await new Promise<void>(resolve => {
    setTimeout(resolve, 800)
  })
}

/**
 * FeedbackDialog 反馈弹窗组件。
 *
 * 受控组件：由父组件通过 `open` / `onOpenChange` 控制开关。
 *
 * @example
 * ```tsx
 * const [open, setOpen] = useState(false)
 * <FeedbackDialog open={open} onOpenChange={setOpen} />
 * ```
 */
export function FeedbackDialog({ open, onOpenChange }: FeedbackDialogProps) {
  // ---- 表单状态 ----
  /** 当前选中的反馈类型（默认 bug） */
  const [selectedType, setSelectedType] = useState<FeedbackType>('bug')
  /** 描述文本 */
  const [description, setDescription] = useState('')
  /** 是否附带系统信息 */
  const [includeSysInfo, setIncludeSysInfo] = useState(false)
  /** 是否附带日志 */
  const [includeLogs, setIncludeLogs] = useState(false)

  // ---- 提交状态 ----
  /** 提交中（禁用按钮 + 文案切换） */
  const [submitting, setSubmitting] = useState(false)
  /** 提交结果：null=表单态、success=成功、error=失败 */
  const [result, setResult] = useState<FeedbackResult>(null)

  // ---- ref：在 useEffect 中安全调用最新的 onOpenChange，避免闭包陈旧值 ----
  const onOpenChangeRef = useRef(onOpenChange)
  useEffect(() => {
    onOpenChangeRef.current = onOpenChange
  })

  // ---- 弹窗打开时重置所有状态到初始值，确保每次打开都是干净表单 ----
  useEffect(() => {
    if (open) {
      setSelectedType('bug')
      setDescription('')
      setIncludeSysInfo(false)
      setIncludeLogs(false)
      setSubmitting(false)
      setResult(null)
    }
  }, [open])

  // ---- 提交结果展示后自动关闭弹窗：成功 1.5s、失败 2s ----
  // 仅依赖 result，通过 ref 读取最新的 onOpenChange，避免父组件重渲染导致计时器重置
  useEffect(() => {
    if (result === null) return
    const delay = result === 'success' ? 1500 : 2000
    const timer = setTimeout(() => {
      onOpenChangeRef.current(false)
    }, delay)
    return () => clearTimeout(timer)
  }, [result])

  // ---- 成功消息附加文本（已附带的附件列表）— 对齐原型行 14537-14540 ----
  const extras: string[] = []
  if (includeSysInfo) extras.push('系统信息')
  if (includeLogs) extras.push('日志')
  const extraText =
    extras.length > 0 ? `（已附带${extras.join('、')}）` : ''

  // ---- 事件处理 ----

  /** 点击"添加截图"（mock，仅 toast 提示） */
  const handleAddScreenshot = useCallback(() => {
    toast.info('截图功能即将上线')
  }, [])

  /** 提交反馈：调用 API，成功/失败分别设置 result 触发结果展示 */
  const handleSubmit = useCallback(async () => {
    setSubmitting(true)
    try {
      await uploadFeedback({
        classification: selectedType,
        reason: description,
        includeLogs,
        includeSysInfo,
      })
      setResult('success')
    } catch (error) {
      logger.error('feedback/upload failed', { error })
      setResult('error')
    } finally {
      setSubmitting(false)
    }
  }, [selectedType, description, includeLogs, includeSysInfo])

  /** 取消按钮：直接关闭弹窗 */
  const handleCancel = useCallback(() => {
    onOpenChange(false)
  }, [onOpenChange])

  // ---- 渲染 ----

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[480px] gap-0 overflow-hidden p-0">
        {/* Header — 标题 */}
        <DialogHeader className="flex flex-row items-center gap-2.5 border-b border-[var(--border)] px-4 py-3.5">
          <DialogTitle className="text-[14px] font-semibold text-[var(--text)]">
            提交反馈
          </DialogTitle>
        </DialogHeader>

        {/* 无障碍描述（sr-only，供屏幕阅读器） */}
        <DialogDescription className="sr-only">
          提交 Bug 报告、功能建议或改进意见
        </DialogDescription>

        {result === null ? (
          // ===== 表单态：反馈类型 + 描述 + 附件 =====
          <div className="px-4 py-3.5">
            {/*
              反馈类型按钮组 — 对齐原型 .feedback-type-grid（行 14519）
              2×2 网格布局，选中项高亮 accent 色
            */}
            <div className="grid grid-cols-2 gap-2">
              {FEEDBACK_TYPES.map(option => {
                const isSelected = selectedType === option.value
                return (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => setSelectedType(option.value)}
                    className={
                      'flex items-center justify-center gap-1.5 rounded-md border px-3 py-2 text-[13px] font-medium transition-colors ' +
                      (isSelected
                        ? 'border-[var(--accent)] bg-[var(--accent-glow)] text-[var(--accent)]'
                        : 'border-[var(--border)] text-[var(--text-dim)] hover:border-[var(--border-strong)]')
                    }
                  >
                    {/* E1 修复：使用 emoji 替代 lucide 图标，对齐原型视觉 */}
                    <span className="text-[14px]">{option.emoji}</span>
                    {option.label}
                  </button>
                )
              })}
            </div>

            {/* 描述输入区 */}
            <div className="mt-3">
              <label className="mb-1.5 block font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--text-faint)]">
                描述
              </label>
              <Textarea
                value={description}
                onChange={e => setDescription(e.target.value)}
                placeholder="请详细描述你的反馈…"
                rows={5}
                className="resize-y border-[var(--border)] bg-[var(--bg-elev-2)] text-[13px] leading-[1.5] text-[var(--text)] placeholder:text-[var(--text-faint)]"
              />
            </div>

            {/*
              附件区 — 对齐原型 .fb-attach-row（行 14519）
              添加截图按钮 + 系统信息复选框 + 日志复选框
            */}
            <div className="mt-3">
              <label className="mb-1.5 block font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--text-faint)]">
                附件（可选）
              </label>
              <div className="flex items-center gap-3">
                {/* 添加截图按钮（mock，点击 toast 提示） */}
                {/* E2 修复：添加虚线边框，对齐原型视觉 */}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleAddScreenshot}
                  className="border border-dashed border-[var(--border)] text-[var(--text-dim)]"
                >
                  添加截图
                </Button>

                {/* 系统信息复选框 */}
                <div className="flex items-center gap-1.5">
                  <Checkbox
                    id="fb-sys-info"
                    checked={includeSysInfo}
                    onCheckedChange={checked =>
                      setIncludeSysInfo(checked === true)
                    }
                  />
                  <Label
                    htmlFor="fb-sys-info"
                    className="text-[12px] text-[var(--text-dim)]"
                  >
                    系统信息
                  </Label>
                </div>

                {/* 日志复选框 */}
                <div className="flex items-center gap-1.5">
                  <Checkbox
                    id="fb-logs"
                    checked={includeLogs}
                    onCheckedChange={checked =>
                      setIncludeLogs(checked === true)
                    }
                  />
                  <Label
                    htmlFor="fb-logs"
                    className="text-[12px] text-[var(--text-dim)]"
                  >
                    日志
                  </Label>
                </div>
              </div>
            </div>
          </div>
        ) : (
          // ===== 结果态：成功/失败消息 — 对齐原型行 14551-14556 =====
          <div className="px-4 py-3.5">
            {result === 'success' ? (
              <div className="py-10 text-center text-[14px] text-[var(--accent)]">
                {`✓ 反馈已提交，感谢！${extraText}`}
              </div>
            ) : (
              <div className="py-10 text-center text-[14px] text-[var(--error)]">
                ✗ 提交失败，请稍后重试
              </div>
            )}
          </div>
        )}

        {/* Footer — 取消 + 提交按钮（仅表单态显示，结果态无 footer） */}
        {result === null && (
          <DialogFooter className="flex-row justify-end gap-2 border-t border-[var(--border)] bg-[var(--bg-elev-2)] px-4 py-3">
            <Button
              variant="outline"
              size="sm"
              onClick={handleCancel}
              disabled={submitting}
              className="border-[var(--border)] text-[var(--text-dim)]"
            >
              取消
            </Button>
            <Button
              size="sm"
              onClick={handleSubmit}
              disabled={submitting}
              className="bg-[var(--accent)] text-[#001814] hover:bg-[var(--accent-dim)]"
            >
              {submitting && <Loader2 className="size-3.5 animate-spin" />}
              {submitting ? '提交中...' : '提交反馈'}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  )
}
