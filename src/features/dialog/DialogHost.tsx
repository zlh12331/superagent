/**
 * @file DialogHost — 命令式确认/输入对话框的渲染宿主
 *
 * 订阅 confirm-dialog-store 的 currentRequest 状态，
 * 当存在请求时渲染对应的 AlertDialog 弹窗（confirm 或 prompt）。
 *
 * 对齐原型 showConfirmDialog / showPromptDialog（prototype.html L9383-9472）：
 *  - 视觉风格：max-w 400px（confirm）/ 420px（prompt），modal-head + body + foot 三段式
 *  - 确认按钮：danger 时红色，否则 accent 色
 *  - 取消按钮：ghost 样式
 *  - prompt 输入框：自动 focus + select，Enter 确认，Esc 取消
 *
 * 使用方式：
 *  - 在应用根节点（MainWindow）挂载一次即可：<DialogHost />
 *  - 调用方使用 `confirm()` / `prompt()` 函数触发弹窗，无需引入任何组件
 *
 * @see src/store/confirm-dialog-store.ts — store 和公共 API
 */

import { useEffect, useState, useCallback, useRef } from 'react'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogAction,
  AlertDialogCancel,
} from '@/components/ui/alert-dialog'
import { Input } from '@/components/ui/input'
import { useConfirmDialogStore } from '@/store/confirm-dialog-store'
import { cn } from '@/lib/utils'

/**
 * DialogHost 组件 — 挂载在应用根节点，渲染命令式弹窗。
 *
 * 本组件不接收任何 props，完全由 confirm-dialog-store 驱动。
 * 当 currentRequest 为 null 时不渲染任何内容。
 */
export function DialogHost() {
  // 订阅 store 的 currentRequest — null 时无弹窗
  const currentRequest = useConfirmDialogStore(s => s.currentRequest)
  const resolveRequest = useConfirmDialogStore(s => s._resolve)

  // prompt 输入框的当前值（每次请求开始时重置为 defaultValue）
  const [inputValue, setInputValue] = useState('')
  // 输入框 ref — 用于 autoFocus + select
  const inputRef = useRef<HTMLInputElement>(null)

  // 当前请求是否为 prompt 类型
  const isPrompt = currentRequest?.kind === 'prompt'
  // 当前请求是否为 confirm 类型
  const isConfirm = currentRequest?.kind === 'confirm'

  // 弹窗是否打开 — currentRequest 存在即打开
  const open = currentRequest !== null

  // 每次请求变化时重置输入框值（仅 prompt 场景）
  useEffect(() => {
    if (currentRequest?.kind === 'prompt') {
      const defaultValue = currentRequest.promptOptions?.defaultValue ?? ''
      setInputValue(defaultValue)
      // 延迟一帧后 focus + select，确保 Input 已渲染
      requestAnimationFrame(() => {
        inputRef.current?.focus()
        inputRef.current?.select()
      })
    }
  }, [currentRequest])

  // ===== 事件处理 =====

  /**
   * 确认按钮点击：
   *  - confirm → resolve(true)
   *  - prompt → resolve(inputValue.trim())
   */
  const handleConfirm = useCallback(() => {
    if (!currentRequest) return
    if (currentRequest.kind === 'confirm') {
      resolveRequest(true)
    } else if (currentRequest.kind === 'prompt') {
      resolveRequest(inputValue.trim())
    }
  }, [currentRequest, inputValue, resolveRequest])

  /**
   * 取消按钮 / 关闭按钮 / Esc / 点击遮罩：
   *  - confirm → resolve(false)
   *  - prompt → resolve(null)
   */
  const handleCancel = useCallback(() => {
    if (!currentRequest) return
    if (currentRequest.kind === 'confirm') {
      resolveRequest(false)
    } else if (currentRequest.kind === 'prompt') {
      resolveRequest(null)
    }
  }, [currentRequest, resolveRequest])

  /**
   * AlertDialog onOpenChange：
   *  - open=true → 无操作（不应发生，弹窗由 store 控制）
   *  - open=false → 用户按 Esc 或点击遮罩，视为取消
   */
  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen) {
        handleCancel()
      }
    },
    [handleCancel]
  )

  /**
   * prompt 输入框 Enter 键确认
   */
  const handleInputKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        handleConfirm()
      }
      // Esc 由 AlertDialog 自身处理（触发 onOpenChange(false) → handleCancel）
    },
    [handleConfirm]
  )

  // 无请求时不渲染
  if (!currentRequest) return null

  // ===== 渲染参数提取 =====

  // 根据请求类型提取渲染参数
  const confirmOpts = isConfirm ? currentRequest.confirmOptions : null
  const promptOpts = isPrompt ? currentRequest.promptOptions : null

  // 标题 / 确认文案 / 取消文案 / 是否危险
  const title = confirmOpts?.title ?? promptOpts?.title ?? ''
  const confirmText = confirmOpts?.confirmText ?? promptOpts?.confirmText ?? '确认'
  const cancelText = confirmOpts?.cancelText ?? promptOpts?.cancelText ?? '取消'
  const danger = confirmOpts?.danger ?? false

  // 确认按钮样式：danger → destructive 变体；否则 accent 色
  const confirmButtonClass = danger
    ? 'bg-[var(--error)] text-white hover:bg-[var(--error)]/90'
    : 'bg-[var(--accent)] text-[#001814] hover:bg-[var(--accent-dim)]'

  return (
    <AlertDialog open={open} onOpenChange={handleOpenChange}>
      <AlertDialogContent
        // 对齐原型：confirm max-w 400px，prompt max-w 420px
        className={cn(
          'max-w-[calc(100%-2rem)] gap-0 overflow-hidden p-0',
          isPrompt ? 'w-[420px]' : 'w-[400px]'
        )}
      >
        {/* Header — 标题 */}
        <AlertDialogHeader className="flex flex-row items-center gap-2.5 border-b border-[var(--border)] px-4 py-3.5">
          <AlertDialogTitle className="text-[14px] font-semibold text-[var(--text)]">
            {title}
          </AlertDialogTitle>
        </AlertDialogHeader>

        {/* Body — 正文描述或输入框 */}
        <div className="px-4 py-3.5">
          {isConfirm && confirmOpts && (
            <AlertDialogDescription className="text-[13px] leading-[1.6] text-[var(--text-dim)]">
              {confirmOpts.message}
            </AlertDialogDescription>
          )}
          {isPrompt && promptOpts && (
            <>
              {/* 输入框标签 — 对齐原型 label 样式 */}
              <label className="mb-1.5 block font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--text-faint)]">
                {promptOpts.label}
              </label>
              <Input
                ref={inputRef}
                value={inputValue}
                onChange={e => setInputValue(e.target.value)}
                onKeyDown={handleInputKeyDown}
                placeholder={promptOpts.placeholder}
                autoComplete="off"
                spellCheck={false}
                className="border-[var(--border)] bg-[var(--bg-elev-2)] text-[13px] text-[var(--text)] placeholder:text-[var(--text-faint)]"
              />
            </>
          )}
        </div>

        {/* Footer — 取消 + 确认按钮 */}
        <AlertDialogFooter className="flex-row justify-end gap-2 border-t border-[var(--border)] bg-[var(--bg-elev-2)] px-4 py-3">
          {/* 取消按钮 — ghost 样式 */}
          <AlertDialogCancel
            className={cn(
              'border-[var(--border)] text-[var(--text-dim)]',
              'hover:bg-[var(--bg-elev)]'
            )}
            onClick={handleCancel}
          >
            {cancelText}
          </AlertDialogCancel>
          {/* 确认按钮 — danger 红色或 accent 色 */}
          <AlertDialogAction
            className={confirmButtonClass}
            onClick={handleConfirm}
          >
            {confirmText}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
