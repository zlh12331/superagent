import { type ReactElement, useEffect, useRef, useState } from 'react';

import { useTranslation } from '@/i18n/use-translation';
import { cn } from '@/lib/utils';

/** 需要忽略的单键（仅修饰键 / 纯功能键） */
const IGNORED_KEYS = new Set(['Control', 'Alt', 'Shift', 'Meta', 'CapsLock', 'Tab']);

/**
 * 格式化按键事件为快捷键字符串
 *
 * 纯修饰键组合返回 null（还需主键才有效）。
 */
export function formatShortcut(e: React.KeyboardEvent): string | null {
  const parts: string[] = [];
  if (e.ctrlKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  if (e.metaKey) parts.push('Meta');

  const key = e.key;
  if (IGNORED_KEYS.has(key) || key === 'Escape' || key === 'Backspace' || key === 'Delete') {
    return null;
  }

  const mainKey = key === ' ' ? 'Space' : key.length === 1 ? key.toUpperCase() : key;
  parts.push(mainKey);
  return parts.join('+');
}

/** ShortcutPicker props */
export interface ShortcutPickerProps {
  /** 当前快捷键值（如 "Meta+P"；空串表示未绑定） */
  readonly value: string;
  /** 变更回调（录制完成 / 清空时触发） */
  readonly onChange: (value: string) => void;
  /** 附加类名 */
  readonly className?: string;
}

/**
 * 快捷键录键控件
 */
export function ShortcutPicker({ value, onChange, className }: ShortcutPickerProps): ReactElement {
  const { t } = useTranslation();
  const [recording, setRecording] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!recording) {
      return;
    }
    const handleKeyDown = (e: KeyboardEvent): void => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') {
        setRecording(false);
        return;
      }
      if (e.key === 'Backspace' || e.key === 'Delete') {
        onChange('');
        setRecording(false);
        return;
      }
      const next = formatShortcut(e as unknown as React.KeyboardEvent);
      if (next !== null) {
        onChange(next);
        setRecording(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [recording, onChange]);

  return (
    <button
      ref={buttonRef}
      type="button"
      aria-pressed={recording}
      onClick={() => setRecording((prev) => !prev)}
      className={cn(
        'border-border bg-background text-foreground hover:border-primary h-[30px] min-w-[92px] cursor-pointer rounded-md border px-2.5 font-mono text-xs transition-colors',
        recording && 'border-primary text-primary',
        className,
      )}
      title={recording ? t('settings.shortcutPressKeys') : value}
    >
      {recording ? '…' : value === '' ? t('settings.shortcutUnbound') : value}
    </button>
  );
}
