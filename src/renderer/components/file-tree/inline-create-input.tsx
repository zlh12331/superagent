// inline-create-input.tsx（自 FileTreeNode 拆分）
// 文件树 · 行内新建输入
// ──────────────────────────────
// 拆分背景：FileTreeNode 564 行，按职责提取
// ──────────────────────────────

// src/renderer/components/file-tree/FileTreeNode.tsx
// 文件树节点（递归渲染）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 渲染单个目录或文件节点
// - 目录节点：展开/折叠箭头 + 文件夹图标 + 名称 + 递归渲染子节点
// - 文件节点：文件图标 + 名称（点击触发 onOpenFile 回调）
// - 通过 depth 控制缩进层级
// - hover 显示「更多操作」按钮（DropdownMenu 触发）
// - 内联重命名输入框（renamingPath === path 时替换名称为 input）
// - 内联新建临时节点（creatingEntry.parentDir === path 时在子条目顶部渲染 input）
//
// 设计：
// - 自包含：从 store 读取自身展开状态、子条目、加载状态、内联编辑状态
// - memo 优化：仅当 props（path/name/type/depth/onOpenFile）变化时重渲染
// - ft-node 作为 position: relative 承载「更多」按钮的绝对定位
// - 文学风视觉：衬线字体名称 + 等宽元信息 + 文件夹/文件图标
// ──────────────────────────────────────────────────────────────

import { File, Folder } from 'lucide-react';
import { type KeyboardEvent, type ReactElement, useRef } from 'react';
import { useTranslation } from '@/i18n/use-translation';

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
  const indentStyle = { paddingLeft: `${depth * 12 + 8}px` };

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
    <div className="ft-row-wrap" style={indentStyle}>
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
