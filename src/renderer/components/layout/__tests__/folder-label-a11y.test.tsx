// src/renderer/components/layout/__tests__/folder-label-a11y.test.tsx
// FolderLabel 嵌套交互回归测试（axe nested-interactive）
// ──────────────────────────────────────────────
// 背景：folder-label 重构将"新建"按钮从折叠 `<button>` 内嵌 span 移出为
// 平级 button（`.folder-label-cell` 内两个独立可聚焦控件），消除嵌套交互。
// 本测试锁定该结构不会回退为"button 内嵌可聚焦元素"。
// ──────────────────────────────────────────────

import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { FolderLabel } from '../folder-label';

function renderFolder() {
  return render(
    <FolderLabel
      folderName="测试目录"
      collapsed={false}
      onToggle={() => {}}
      onCreateInFolder={() => {}}
      onOpenInExplorer={() => {}}
      onDeleteFolder={() => {}}
    />,
  );
}

describe('FolderLabel 嵌套交互回归', () => {
  it('折叠按钮与"新建"按钮同框呈现，且为平级、非嵌套（nested-interactive 不回退）', () => {
    const { container } = renderFolder();
    const toggle = container.querySelector<HTMLButtonElement>('.folder-label');
    const add = container.querySelector<HTMLButtonElement>('.fl-add-btn');

    expect(toggle).not.toBeNull();
    expect(add).not.toBeNull();

    // 关键：新建按钮不能是折叠按钮的可聚焦后代 → 二者挂同一平级容器
    expect(toggle?.contains(add ?? null)).toBe(false);
    expect(add?.closest('.folder-label')).toBeNull();
    expect(add?.parentElement?.classList.contains('folder-label-cell')).toBe(true);
  });

  it('折叠开关仍是可聚焦 button 并带 aria-expanded', () => {
    const { container } = renderFolder();
    const toggle = container.querySelector<HTMLButtonElement>('.folder-label');
    expect(toggle?.tagName).toBe('BUTTON');
    expect(toggle).toHaveAttribute('aria-expanded');
    // 新建按钮也必须是真正 button 且可聚焦（而非能捕获内部的 span）
    const add = container.querySelector<HTMLButtonElement>('.fl-add-btn');
    expect(add?.tagName).toBe('BUTTON');
  });
});
