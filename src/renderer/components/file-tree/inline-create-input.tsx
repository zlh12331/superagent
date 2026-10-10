import { File, Folder } from 'lucide-react';
import { type KeyboardEvent, type ReactElement, useRef } from 'react';
import { useTranslation } from '@/i18n/use-translation';
import type { CreateEntryType } from '@/stores/transient/file-tree-store';
import { indentStyle } from './indent';

interface InlineCreateInputProps {
  readonly type: CreateEntryType;
  readonly depth: number;
  /** 确认新建（已 trim 的非空名称） */
  readonly onConfirm: (name: string) => void;
  /** 取消新建（空名 / Esc / 放弃） */
  readonly onCancel: () => void;
}
/** 树内联新建输入框（文件/目录）：Enter 提交 / Esc 取消 / 失焦收尾 */
export function InlineCreateInput({
  type,
  depth,
  onConfirm,
  onCancel,
}: InlineCreateInputProps): ReactElement {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  const handledRef = useRef(false);
  const indent = indentStyle(depth);

  const commit = (): void => {
    const input = inputRef.current;
    if (input === null) return;
    const value = input.value.trim();
    if (value === '') {
      onCancel();
    } else {
      onConfirm(value);
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    e.stopPropagation();
    if (handledRef.current) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      handledRef.current = true;
      commit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      handledRef.current = true;
      onCancel();
    }
  };

  const handleBlur = (): void => {
    if (handledRef.current) {
      handledRef.current = false;
      return;
    }
    commit();
  };

  return (
    <div className="ft-row-wrap" style={indent}>
      <div className="ft-row ft-creating">
        <span className="ft-chevron" aria-hidden></span>
        <span className="ft-icon">
          {type === 'directory' ? (
            <Folder size={13} strokeWidth={1.75} />
          ) : (
            <File size={13} strokeWidth={1.5} />
          )}
        </span>
        <input
          ref={inputRef}
          type="text"
          className="ft-rename-input"
          placeholder={type === 'directory' ? t('fileTree.newDir') : t('fileTree.newFile')}
          // biome-ignore lint/a11y/noAutofocus: 内联新建必须立即聚焦以提供 VSCode 风格体验
          autoFocus
          onKeyDown={handleKeyDown}
          onBlur={handleBlur}
          onClick={(e) => e.stopPropagation()}
        />
      </div>
    </div>
  );
}
