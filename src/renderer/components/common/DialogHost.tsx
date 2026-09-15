// src/renderer/components/common/DialogHost.tsx
// 命令式确认/输入对话框的渲染宿主（照搬自参考项目 F:\TraeProjects\Agent2\1\src\features\dialog\DialogHost.tsx）
// ──────────────────────────────────────────────────────────────
// 订阅 confirm-dialog-store 的 currentRequest 状态，存在请求时渲染 AlertDialog。
// - 视觉：confirm max-w 400px / prompt 420px，head + body + foot 三段式
// - 确认按钮：danger 红色 / 否则 accent 色；取消按钮 outline
// - prompt 输入框：自动 focus + select，Enter 确认，Esc 取消
// 在 AppShell 根节点挂载一次即可；调用方用 confirm() / prompt() 触发，零 React 依赖。
// ──────────────────────────────────────────────────────────────

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Input } from '@/components/ui/input';
import { useTranslation } from '@/i18n/use-translation';
import { cn } from '@/lib/utils';
import { useConfirmDialogStore } from '@/stores/transient/confirm-dialog-store';

/**
 * 命令式弹窗渲染宿主组件，挂载在应用根节点。
 *
 * 不接收任何 props，完全由 confirm-dialog-store 驱动；
 * currentRequest 为 null 时不渲染任何内容。
 */
export function DialogHost(): React.ReactElement | null {
  // 兜底文案走 i18n（调用方未传 confirmText/cancelText 时）
  const { t } = useTranslation();
  // 订阅 store 的 currentRequest，null 时无弹窗
  const currentRequest = useConfirmDialogStore((s) => s.currentRequest);
  const resolveRequest = useConfirmDialogStore((s) => s._resolve);

  // prompt 输入框的当前值（每次请求开始时重置为 defaultValue）
  const [inputValue, setInputValue] = useState('');
  // 输入框 ref，用于 autoFocus + select
  const inputRef = useRef<HTMLInputElement>(null);

  const isPrompt = currentRequest?.kind === 'prompt';
  const isConfirm = currentRequest?.kind === 'confirm';

  const open = currentRequest !== null;

  // 每次请求变化时重置输入框值（渲染期状态调整，替代 effect 中 setState）
  const [prevRequest, setPrevRequest] = useState(currentRequest);
  if (currentRequest !== prevRequest) {
    setPrevRequest(currentRequest);
    if (currentRequest?.kind === 'prompt') {
      setInputValue(currentRequest.promptOptions?.defaultValue ?? '');
    }
  }

  // prompt 弹窗打开时聚焦并选中输入框文本（纯 DOM 操作）
  useEffect(() => {
    if (currentRequest?.kind === 'prompt') {
      // 延迟一帧后 focus + select，确保 Input 已渲染
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    }
  }, [currentRequest]);

  // ===== 事件处理 =====

  /** 确认按钮：confirm → true；prompt → inputValue.trim() */
  const handleConfirm = useCallback(() => {
    if (currentRequest === null) return;
    if (currentRequest.kind === 'confirm') {
      resolveRequest(true);
    } else {
      resolveRequest(inputValue.trim());
    }
  }, [currentRequest, inputValue, resolveRequest]);

  /** 取消按钮/关闭/Esc/遮罩：confirm → false；prompt → null */
  const handleCancel = useCallback(() => {
    if (currentRequest === null) return;
    if (currentRequest.kind === 'confirm') {
      resolveRequest(false);
    } else {
      resolveRequest(null);
    }
  }, [currentRequest, resolveRequest]);

  /** AlertDialog onOpenChange：open=false（Esc/遮罩）视为取消 */
  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen) {
        handleCancel();
      }
    },
    [handleCancel],
  );

  /** prompt 输入框 Enter 键确认（Esc 由 AlertDialog 自身处理） */
  const handleInputKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        handleConfirm();
      }
    },
    [handleConfirm],
  );

  // 无请求时不渲染
  if (currentRequest === null) return null;

  // ===== 渲染参数提取 =====

  const confirmOpts =
    currentRequest !== null && currentRequest.kind === 'confirm'
      ? currentRequest.confirmOptions
      : null;
  const promptOpts =
    currentRequest !== null && currentRequest.kind === 'prompt'
      ? currentRequest.promptOptions
      : null;

  const title = confirmOpts?.title ?? promptOpts?.title ?? '';
  const confirmText = confirmOpts?.confirmText ?? promptOpts?.confirmText ?? t('common.confirm');
  const cancelText = confirmOpts?.cancelText ?? promptOpts?.cancelText ?? t('common.cancel');
  const danger = confirmOpts?.danger ?? false;

  // 确认按钮样式：danger → 实底强调红（--error-emphasis 双主题锁定白字 CR≥4.5）；否则 accent 色
  const confirmButtonClass = danger
    ? 'bg-error-emphasis text-destructive-foreground hover:bg-error-emphasis/90'
    : 'bg-accent text-on-accent hover:bg-accent-dim';

  return (
    <AlertDialog open={open} onOpenChange={handleOpenChange}>
      <AlertDialogContent
        // 对齐原型：confirm 400px / prompt 420px
        className={cn(
          'max-w-[calc(100%-2rem)] gap-0 overflow-hidden p-0',
          isPrompt ? 'w-[420px]' : 'w-[400px]',
        )}
      >
        {/* Header — 标题 */}
        <AlertDialogHeader className="border-border flex flex-row items-center gap-2.5 border-b px-4 py-3.5">
          <AlertDialogTitle className="text-foreground text-[14px] font-semibold">
            {title}
          </AlertDialogTitle>
        </AlertDialogHeader>

        {/* Body — 正文描述或输入框 */}
        <div className="px-4 py-3.5">
          {isConfirm && confirmOpts != null && (
            <AlertDialogDescription className="text-muted-foreground text-[13px] leading-[1.6]">
              {confirmOpts.message}
            </AlertDialogDescription>
          )}
          {isPrompt && promptOpts != null && (
            <>
              {/* 输入框标签（htmlFor 关联，辅助技术可正确读出标签内容） */}
              <label
                htmlFor="dialog-prompt-input"
                className="text-muted-foreground mb-1.5 block font-mono text-[10px] tracking-[0.08em] uppercase"
              >
                {promptOpts.label}
              </label>
              <Input
                id="dialog-prompt-input"
                ref={inputRef}
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                onKeyDown={handleInputKeyDown}
                placeholder={promptOpts.placeholder}
                autoComplete="off"
                spellCheck={false}
              />
            </>
          )}
        </div>

        {/* Footer — 取消 + 确认按钮 */}
        <AlertDialogFooter className="bg-muted/30 border-border flex-row justify-end gap-2 border-t px-4 py-3">
          <AlertDialogCancel onClick={handleCancel}>{cancelText}</AlertDialogCancel>
          <AlertDialogAction className={confirmButtonClass} onClick={handleConfirm}>
            {confirmText}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
