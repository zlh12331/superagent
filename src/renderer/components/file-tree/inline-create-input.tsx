// src/renderer/components/file-tree/inline-create-input.tsx
// 文件树 · 行内新建输入
// ──────────────────────────────
// 拆分背景：FileTreeNode 564 行，按职责提取
// ──────────────────────────────
// 职责：
// - 渲染行内新建输入框（文件 / 目录名）：Enter 提交、Esc 取消、失焦提交
// - 空名提交等同取消（不创建空名条目）
//
// 设计：
// - handledRef 防止 Enter/Esc 后 onBlur 重复提交（keydown 先标记，blur 检查后重置）
// - 非交互行容器用 div 而非 disabled button（禁用按钮的后代表单控件不可交互，
//   且屏幕阅读器会先读到无意义的禁用态）
// ──────────────────────────────

import { File, Folder } from 'lucide-react';
import { type KeyboardEvent, type ReactElement, useRef } from 'react';
import { useTranslation } from '@/i18n/use-translation';
import { indentStyle } from './indent';

interface InlineCreateInputProps {
  readonly type: 'file' | 'directory';
  readonly depth: number;
  readonly onConfirm: (name: string) => void;
  readonly onCancel: () => void;
}
export function InlineCreateInput({
  type,
  depth,
  onConfirm,
  onCancel,
}: InlineCreateInputProps): ReactElement {
  // 本地化文案
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  // 防止 Enter/Esc 触发后 onBlur 重复调用：keydown 先标记，blur 检查后重置
  const handledRef = useRef(false);
  // 缩进与 FileTreeNode 共用同一公式（单一真源在 ./indent）
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
    // 输入框持有自己的按键语义，禁止冒泡到外层 treeitem：DirNode 对
    // Enter/Space 调 toggleExpand + preventDefault——冒泡会把「提交新建」变成
    // 「折叠目录」，空格则被吞掉（文件名合法字符无法输入）。实测复现后修复。
    e.stopPropagation();
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
      {/* 非交互行容器：用 div 而非 disabled button（HTML 规范上禁用按钮的后代表单控件不可交互，且屏幕阅读器会先读到无意义禁用态） */}
      <div className="ft-row ft-creating">
        <span className="ft-chevron" aria-hidden>
          {/* 无展开箭头，对齐文件节点缩进 */}
        </span>
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
