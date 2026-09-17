// src/renderer/components/layout/__tests__/folder-label-a11y.test.tsx
// FolderLabel 结构与交互测试
// ──────────────────────────────────────────────
// 背景（结构）：folder-label 重构将"新建"按钮从折叠 `<button>` 内嵌 span 移出为
// 平级 button（`.folder-label-cell` 内两个独立可聚焦控件），消除嵌套交互。
// 本测试锁定该结构不会回退为"button 内嵌可聚焦元素"。
//
// 覆盖（交互）：折叠切换 / 组内新建 / 右键菜单三项（新建、在资源管理器中打开、
// 删除整组）——此前 3 个回调透传路径无覆盖，属"点了没反应也测不出来"的盲区。
// ──────────────────────────────────────────────

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';

import { FolderLabel } from './folder-label';

function renderFolder(overrides: Partial<Parameters<typeof FolderLabel>[0]> = {}) {
  const handlers = {
    onToggle: vi.fn(),
    onCreateInFolder: vi.fn(),
    onOpenInExplorer: vi.fn(),
    onDeleteFolder: vi.fn(),
  };
  const view = render(
    <FolderLabel folderName="测试目录" collapsed={false} {...handlers} {...overrides} />,
  );
  return { ...handlers, ...view };
}

/** 右键打开上下文菜单（Radix ContextMenu 响应 contextMenu 事件） */
function openContextMenu(): void {
  fireEvent.contextMenu(screen.getByText('测试目录'));
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

  it('折叠态：aria-expanded=false 且带 collapsed 类', () => {
    const { container } = renderFolder({ collapsed: true });
    const toggle = container.querySelector<HTMLButtonElement>('.folder-label');
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    expect(toggle?.classList.contains('collapsed')).toBe(true);
  });

  it('边界：空文件夹名（未分组）显示「未命名」占位而非空标签', () => {
    renderFolder({ folderName: '' });
    // 不渲染空文本节点，回退到本地化占位文案
    expect(screen.queryByText('测试目录')).toBeNull();
  });
});

describe('FolderLabel 交互（回调透传）', () => {
  it('点击折叠行 → onToggle', () => {
    const { onToggle, container } = renderFolder();
    const toggle = container.querySelector<HTMLButtonElement>('.folder-label');
    fireEvent.click(toggle as HTMLElement);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('点击"新建"按钮 → onCreateInFolder(folderName)', () => {
    const { onCreateInFolder, container } = renderFolder();
    fireEvent.click(container.querySelector('.fl-add-btn') as HTMLElement);
    expect(onCreateInFolder).toHaveBeenCalledWith('测试目录');
  });

  it('右键菜单「新建」→ onCreateInFolder(folderName)', async () => {
    const { onCreateInFolder } = renderFolder();
    openContextMenu();

    fireEvent.click(await screen.findByText(i18n.t('sidebar.newTaskInFolder')));
    expect(onCreateInFolder).toHaveBeenCalledWith('测试目录');
  });

  it('右键菜单「在资源管理器中打开」→ onOpenInExplorer(folderName)', async () => {
    const { onOpenInExplorer } = renderFolder();
    openContextMenu();

    fireEvent.click(await screen.findByText(i18n.t('sidebar.openInExplorer')));
    expect(onOpenInExplorer).toHaveBeenCalledWith('测试目录');
  });

  it('右键菜单「删除文件夹」→ onDeleteFolder(folderName)', async () => {
    const { onDeleteFolder } = renderFolder();
    openContextMenu();

    fireEvent.click(await screen.findByText(i18n.t('sidebar.deleteFolder')));
    expect(onDeleteFolder).toHaveBeenCalledWith('测试目录');
  });

  it('异常：点击"新建"不冒泡成折叠切换（否则新建的同时把组折上）', () => {
    const { onToggle, onCreateInFolder, container } = renderFolder();
    fireEvent.click(container.querySelector('.fl-add-btn') as HTMLElement);

    expect(onCreateInFolder).toHaveBeenCalledTimes(1);
    expect(onToggle).not.toHaveBeenCalled();
  });
});
