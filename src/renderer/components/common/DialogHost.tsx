import { useEffect, useRef, useState } from 'react';

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
  const { t } = useTranslation();
  const currentRequest = useConfirmDialogStore((s) => s.currentRequest);
  const resolveRequest = useConfirmDialogStore((s) => s._resolve);

  const [inputValue, setInputValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const isPrompt = currentRequest?.kind === 'prompt';
  const open = currentRequest !== null;

  const [prevRequest, setPrevRequest] = useState(currentRequest);
  if (currentRequest !== prevRequest) {
    setPrevRequest(currentRequest);
    if (currentRequest?.kind === 'prompt') {
      setInputValue(currentRequest.promptOptions?.defaultValue ?? '');
    }
  }

  useEffect(() => {
    if (currentRequest?.kind !== 'prompt') return;
    const handle = requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => cancelAnimationFrame(handle);
  }, [currentRequest]);

  /** 确认按钮：confirm → true；prompt → inputValue.trim() */
  const handleConfirm = () => {
    if (currentRequest === null) return;
    if (currentRequest.kind === 'confirm') {
      resolveRequest(true);
    } else {
      resolveRequest(inputValue.trim());
    }
  };

  /** 取消按钮/关闭/Esc/遮罩：confirm → false；prompt → null */
  const handleCancel = () => {
    if (currentRequest === null) return;
    if (currentRequest.kind === 'confirm') {
      resolveRequest(false);
    } else {
      resolveRequest(null);
    }
  };

  /** AlertDialog onOpenChange：open=false（Esc/遮罩）视为取消 */
  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      handleCancel();
    }
  };

  /** prompt 输入框 Enter 键确认（Esc 由 AlertDialog 自身处理） */
  const handleInputKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      handleConfirm();
    }
  };

  if (currentRequest === null) return null;
  const isPromptRequest = currentRequest.kind === 'prompt';
  const isConfirmRequest = currentRequest.kind === 'confirm';

  const confirmOpts = isConfirmRequest ? currentRequest.confirmOptions : null;
  const promptOpts = isPromptRequest ? currentRequest.promptOptions : null;

  const title = confirmOpts?.title ?? promptOpts?.title ?? '';
  const confirmText = confirmOpts?.confirmText ?? promptOpts?.confirmText ?? t('common.confirm');
  const cancelText = confirmOpts?.cancelText ?? promptOpts?.cancelText ?? t('common.cancel');
  const danger = confirmOpts?.danger ?? false;

  const confirmButtonClass = danger
    ? 'bg-error-emphasis text-destructive-foreground hover:bg-error-emphasis/90'
    : 'bg-primary text-primary-foreground hover:bg-accent-dim';

  return (
    <AlertDialog open={open} onOpenChange={handleOpenChange}>
      <AlertDialogContent
        className={cn(
          'max-w-[calc(100%-2rem)] gap-0 overflow-hidden p-0',
          isPrompt ? 'w-[420px]' : 'w-[400px]',
        )}
      >
        <AlertDialogHeader className="border-border flex flex-row items-center gap-2.5 border-b px-4 py-3.5">
          <AlertDialogTitle className="text-foreground text-md font-semibold">
            {title}
          </AlertDialogTitle>
        </AlertDialogHeader>

        <div className="px-4 py-3.5">
          {confirmOpts != null && (
            <AlertDialogDescription className="text-muted-foreground text-base leading-[1.6]">
              {confirmOpts.message}
            </AlertDialogDescription>
          )}
          {promptOpts != null && (
            <>
              <label
                htmlFor="dialog-prompt-input"
                className="text-muted-foreground mb-1.5 block font-mono text-2xs tracking-[0.08em] uppercase"
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

        <AlertDialogFooter className="bg-muted/30 border-border flex-row justify-end gap-2 border-t px-4 py-3">
          <AlertDialogCancel
            onClick={(e) => {
              e.preventDefault();
              handleCancel();
            }}
          >
            {cancelText}
          </AlertDialogCancel>
          <AlertDialogAction
            className={confirmButtonClass}
            onClick={(e) => {
              e.preventDefault();
              handleConfirm();
            }}
          >
            {confirmText}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
