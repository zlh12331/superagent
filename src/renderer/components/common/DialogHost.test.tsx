import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { i18n } from '@/i18n';
import { confirm, prompt, useConfirmDialogStore } from '@/stores/transient/confirm-dialog-store';

import { DialogHost } from './DialogHost';

const t = i18n.t.bind(i18n);

/**
 * 重置 store 至无请求态
 *
 * 注意：不可用 document.body.innerHTML = '' 清场——那会破坏 React 的卸载
 * 流程（NotFoundError: node to be removed is not a child）+ 令 hooks 失去宿主
 * （Invalid hook call）。正确做法是清 store 状态，由 testing-library 自行清理 DOM。
 */
beforeEach(() => {
  useConfirmDialogStore.setState({ currentRequest: null });
});

/** 在弹窗范围内按按钮文案点击（避免与页面其他同名文案冲突） */
function clickInDialog(name: string): void {
  const dialog = screen.getByRole('alertdialog');
  fireEvent.click(within(dialog).getByRole('button', { name }));
}

/** 等待并返回当前弹窗容器（Radix AlertDialog） */
async function findDialog(): Promise<HTMLElement> {
  return screen.findByRole('alertdialog');
}

describe('DialogHost', () => {
  it('无请求：渲染 null', () => {
    const { container } = render(<DialogHost />);
    expect(container.firstChild).toBeNull();
  });

  it('confirm 正向：渲染标题/正文，确认 → resolve(true)', async () => {
    render(<DialogHost />);
    const result = confirm({ title: '删除确认', message: '确定要删除吗？', danger: true });

    const dialog = await findDialog();
    expect(within(dialog).getByText('删除确认')).toBeDefined();
    expect(within(dialog).getByText('确定要删除吗？')).toBeDefined();
    clickInDialog(t('common.confirm'));
    await expect(result).resolves.toBe(true);
  });

  it('confirm 取消：点击取消按钮 → resolve(false)', async () => {
    render(<DialogHost />);
    const result = confirm({ title: '确认标题', message: '正文' });
    await findDialog();
    clickInDialog(t('common.cancel'));
    await expect(result).resolves.toBe(false);
  });

  it('confirm 自定义按钮文案：覆盖默认 i18n 文案', async () => {
    render(<DialogHost />);
    void confirm({ title: '标题', message: '正文', confirmText: '删除', cancelText: '保留' });
    const dialog = await findDialog();
    expect(within(dialog).getByRole('button', { name: '删除' })).toBeDefined();
    expect(within(dialog).getByRole('button', { name: '保留' })).toBeDefined();
  });

  it('prompt 正向：defaultValue 回填 + 输入后确认 → resolve(trim 值)', async () => {
    render(<DialogHost />);
    const result = prompt({ title: '重命名', label: '名称', defaultValue: '旧名' });
    const dialog = await findDialog();

    const input = within(dialog).getByRole('textbox') as HTMLInputElement;
    expect(input.value).toBe('旧名');
    fireEvent.change(input, { target: { value: '  新名  ' } });
    clickInDialog(t('common.confirm'));
    await expect(result).resolves.toBe('新名');
  });

  it('prompt 边界：Enter 键确认（等价点击确认按钮）', async () => {
    render(<DialogHost />);
    const result = prompt({ title: '输入标题', label: '值', defaultValue: '' });
    const dialog = await findDialog();
    const input = within(dialog).getByRole('textbox');
    fireEvent.change(input, { target: { value: 'abc' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await expect(result).resolves.toBe('abc');
  });

  it('prompt 取消：点击取消 → resolve(null)', async () => {
    render(<DialogHost />);
    const result = prompt({ title: '输入标题', label: '值' });
    await findDialog();
    clickInDialog(t('common.cancel'));
    await expect(result).resolves.toBeNull();
  });

  it('prompt 边界：确认空输入 → resolve 空串（非 null，与取消可区分）', async () => {
    render(<DialogHost />);
    const result = prompt({ title: '输入标题', label: '值', defaultValue: '先填着' });
    const dialog = await findDialog();
    const input = within(dialog).getByRole('textbox');
    fireEvent.change(input, { target: { value: '   ' } });
    clickInDialog(t('common.confirm'));
    await expect(result).resolves.toBe('');
  });

  it('异常路径：宿主未挂载时 confirm 不抛错（promise 悬空）', () => {
    expect(() => {
      void confirm({ title: 'x', message: 'y' });
    }).not.toThrow();
  });

  it('连续两次请求：第二次的 defaultValue 覆盖首次残留', async () => {
    render(<DialogHost />);
    const first = prompt({ title: '第一次标题', label: '值', defaultValue: 'A' });
    await findDialog();
    clickInDialog(t('common.cancel'));
    await expect(first).resolves.toBeNull();

    void prompt({ title: '第二次标题', label: '值', defaultValue: 'B' });
    const dialog2 = await findDialog();
    await waitFor(() => {
      expect((within(dialog2).getByRole('textbox') as HTMLInputElement).value).toBe('B');
    });
  });

  /** 判断 promise 在 50ms 内是否已解决（用于断言「保持待决」） */
  async function settledWithin50ms(p: Promise<unknown>): Promise<'settled' | 'pending'> {
    return Promise.race([
      p.then(() => 'settled' as const),
      new Promise<'pending'>((r) => setTimeout(() => r('pending'), 50)),
    ]);
  }

  it('排队：确认第一个后，第二个应保持待决而非被自动取消', async () => {
    render(<DialogHost />);
    const first = confirm({ title: '第一个', message: 'm1' });
    const second = confirm({ title: '第二个', message: 'm2' });

    await findDialog();
    clickInDialog(t('common.confirm'));
    await expect(first).resolves.toBe(true);

    expect(await settledWithin50ms(second)).toBe('pending');

    const dialog2 = await findDialog();
    expect(within(dialog2).getByText('第二个')).toBeDefined();
    clickInDialog(t('common.confirm'));
    await expect(second).resolves.toBe(true);
  });

  it('排队：取消第一个后，第二个同样保持待决且可交互', async () => {
    render(<DialogHost />);
    const first = confirm({ title: '第一个', message: 'm1' });
    const second = confirm({ title: '第二个', message: 'm2' });

    await findDialog();
    clickInDialog(t('common.cancel'));
    await expect(first).resolves.toBe(false);

    expect(await settledWithin50ms(second)).toBe('pending');

    const dialog2 = await findDialog();
    expect(within(dialog2).getByText('第二个')).toBeDefined();
    clickInDialog(t('common.cancel'));
    await expect(second).resolves.toBe(false);
  });
});
