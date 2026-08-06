// inline-rename-input.tsx（自 FileTreeNode 拆分）
// 文件树 · 行内重命名输入
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

import { type KeyboardEvent, type ReactElement, useRef } from 'react';

interface InlineRenameInputProps {
  readonly initialName: string;
  readonly onConfirm: (newName: string) => void;
  readonly onCancel: () => void;
}
export function InlineRenameInput({
  initialName,
  onConfirm,
  onCancel,
}: InlineRenameInputProps): ReactElement {
  const inputRef = useRef<HTMLInputElement>(null);
  // 防止 Enter/Esc 触发后 onBlur 重复调用：keydown 先标记，blur 检查后重置
  const handledRef = useRef(false);

  // 选中文件名（不含扩展名）：'foo.ts' → 选中 'foo'，'README' → 全选
  const selectName = (): void => {
    const input = inputRef.current;
    if (input === null) return;
    const dotIdx = initialName.lastIndexOf('.');
    // 仅当 dot 在第 1 个字符之后（避免选中 '.gitignore' 的隐藏文件名）
    if (dotIdx > 0) {
      input.setSelectionRange(0, dotIdx);
    } else {
      input.select();
    }
  };

  const commit = (): void => {
    const input = inputRef.current;
    if (input === null) return;
    const value = input.value.trim();
    if (value === '' || value === initialName) {
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
    // keydown 已处理过则跳过，避免双触发
    if (handledRef.current) {
      handledRef.current = false;
      return;
    }
    commit();
  };

  return (
    <input
      ref={inputRef}
      type="text"
      className="ft-rename-input"
      defaultValue={initialName}
      // biome-ignore lint/a11y/noAutofocus: 内联重命名必须立即聚焦以提供 VSCode 风格体验
      autoFocus
      // onFocus 在 autoFocus 后触发，确保选中文件名
      onFocus={selectName}
      onKeyDown={handleKeyDown}
      onBlur={handleBlur}
      // 阻止 click 冒泡到 row button，避免触发展开/打开文件
      onClick={(e) => e.stopPropagation()}
    />
  );
}

// ── 子组件：内联新建输入框 ──────────────────────────────────

/**
 * 内联新建临时节点
 *
 * 在目录子条目列表顶部渲染一个可编辑节点：
 * - 显示与 type 对应的图标 + input
 * - Enter 确认 / Esc 取消 / 失焦取消
 * - 空名称视为取消
 */
