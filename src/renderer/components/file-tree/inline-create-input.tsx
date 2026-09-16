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
// - handledRef 只在**键盘事件**处置位（Enter 提交 / Esc 取消），供随后的
//   失焦「读一次即复位」——这就是 Enter 提交后紧跟的 blur 不会二次落盘的机制。
//   失焦本身不置位：失焦是焦点会话的终点事件，置位会让闩永久卡住，之后
//   用户改名重试时按键被静默吞掉（实测复现：从下拉菜单进入新建时，菜单关闭
//   会先派发一次 ref 尚未接上的 blur，闩一旦置位则 Enter 完全失效）。
// - 非交互行容器用 div 而非 disabled button（禁用按钮的后代表单控件不可交互，
//   且屏幕阅读器会先读到无意义的禁用态）
// ──────────────────────────────

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
export function InlineCreateInput({
  type,
  depth,
  onConfirm,
  onCancel,
}: InlineCreateInputProps): ReactElement {
  // 本地化文案
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  // 键盘事件是否已处置（Enter 提交 / Esc 取消）；供紧随的失焦去重
  const handledRef = useRef(false);
  // 缩进与 FileTreeNode 共用同一公式（单一真源在 ./indent）
  const indent = indentStyle(depth);

  const commit = (): void => {
    const input = inputRef.current;
    // ref 未接上（如菜单关闭瞬间的失焦）：本轮无输入可提交，直接放弃
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
    // 已处置（Esc 取消或上次 Enter 已提交）后不再响应按键：
    // 既避免连按 Enter 重复落盘，也避免「Esc 取消后按 Enter 又把文件建出来」
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
    // 键盘已处置：消费掉闩（复位而非继续置位），使后续失焦提交仍可用
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
