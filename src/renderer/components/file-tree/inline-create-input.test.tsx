// src/renderer/components/file-tree/__tests__/inline-create-input.test.tsx
// 行内新建输入单测（正向 / 边界 / 异常）
// ──────────────────────────────────────────────────────────────
// 重点守护 handledRef 失焦去重：Enter/Esc 已处理时，随后的 blur 不得二次提交
// （此前无覆盖；若回归会导致「回车新建 + 失焦再建一次」重复落盘）。
// ──────────────────────────────────────────────────────────────

import { createEvent, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';

import { InlineCreateInput } from './inline-create-input';

function setup(type: 'file' | 'directory' = 'file', depth = 1) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  const view = render(
    <InlineCreateInput type={type} depth={depth} onConfirm={onConfirm} onCancel={onCancel} />,
  );
  const input = screen.getByRole('textbox') as HTMLInputElement;
  return { onConfirm, onCancel, input, ...view };
}

describe('InlineCreateInput', () => {
  it('文件类型：placeholder 用「新建文件」文案', () => {
    const { input } = setup('file');
    expect(input.placeholder).toBe(i18n.t('fileTree.newFile'));
  });

  it('目录类型：placeholder 用「新建目录」文案', () => {
    const { input } = setup('directory');
    expect(input.placeholder).toBe(i18n.t('fileTree.newDir'));
  });

  it('Enter 提交：onConfirm 收到去除首尾空格后的名称', () => {
    const { input, onConfirm } = setup();
    fireEvent.change(input, { target: { value: '  a.ts  ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onConfirm).toHaveBeenCalledWith('a.ts');
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('Enter 之后的失焦：不重复提交（handledRef 去重）', () => {
    const { input, onConfirm } = setup();
    fireEvent.change(input, { target: { value: 'a.ts' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.blur(input);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('Esc 取消：onCancel 调用，且随后失焦不再提交', () => {
    const { input, onCancel, onConfirm } = setup();
    fireEvent.change(input, { target: { value: 'a.ts' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
    fireEvent.blur(input);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('直接失焦提交：无 Enter 时 blur 触发 onConfirm', () => {
    const { input, onConfirm } = setup();
    fireEvent.change(input, { target: { value: 'b.ts' } });
    fireEvent.blur(input);
    expect(onConfirm).toHaveBeenCalledWith('b.ts');
  });

  it('边界：空名提交等同取消（不创建空名条目）', () => {
    const { input, onConfirm, onCancel } = setup();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('边界：纯空格名提交同样视为取消', () => {
    const { input, onConfirm, onCancel } = setup();
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.blur(input);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('异常：连按两次 Enter 只提交一次（防止重复落盘 EEXIST）', () => {
    const { input, onConfirm } = setup();
    fireEvent.change(input, { target: { value: 'a.ts' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith('a.ts');
  });

  it('异常：Esc 取消后（未失焦）再按 Enter 不提交', () => {
    const { input, onConfirm, onCancel } = setup();
    fireEvent.change(input, { target: { value: 'a.ts' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    fireEvent.keyDown(input, { key: 'Enter' });
    // 取消后不得因后续 Enter 又把条目建出来
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('异常：Esc + 失焦 + 再次 Enter 后失焦，仍只提交一次', () => {
    const { input, onConfirm, onCancel } = setup();
    fireEvent.change(input, { target: { value: 'c.ts' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    fireEvent.blur(input);
    fireEvent.change(input, { target: { value: 'd.ts' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.blur(input);
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith('d.ts');
  });

  it('缩进：与 FileTreeNode 共用同一公式（depth*12+8，单一真源 ./indent）', () => {
    const { container } = setup('file', 2);
    const rowWrap = container.querySelector('.ft-row-wrap') as HTMLElement;
    expect(rowWrap.style.paddingLeft).toBe('32px');
  });

  it('点击输入框：stopPropagation 阻止冒泡（不触发外层行/树节点行为）', () => {
    const { input } = setup();
    const clickEvent = createEvent.click(input);
    const stopSpy = vi.spyOn(clickEvent, 'stopPropagation');
    fireEvent(input, clickEvent);
    expect(stopSpy).toHaveBeenCalledTimes(1);
  });
});
