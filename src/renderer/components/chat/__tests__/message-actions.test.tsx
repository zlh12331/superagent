// message-actions.test.tsx
// 消息操作按钮组单测：复制回调 / 重新生成透传 / disabled 拦截
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { MsgActions } from '../message-actions';

// useCopy mock：copied 状态由用例经 mockReturnValue 控制
const copySpy = vi.fn();
vi.mock('@/hooks/use-copy', () => ({
  useCopy: vi.fn(() => ({ copied: false, copy: copySpy })),
}));

import { useCopy } from '@/hooks/use-copy';

describe('MsgActions', () => {
  it('正向：渲染复制与重新生成两按钮', () => {
    render(<MsgActions text="内容" messageId="m1" onRegenerate={vi.fn()} disabled={false} />);
    expect(screen.getByRole('button', { name: /复制/ })).toBeDefined();
    expect(screen.getByRole('button', { name: /重新生成|重新/ })).toBeDefined();
  });

  it('复制：点击 → copy(text) 以完整消息文本调用', () => {
    render(
      <MsgActions text="要复制的全文" messageId="m1" onRegenerate={vi.fn()} disabled={false} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /复制/ }));
    expect(copySpy).toHaveBeenCalledWith('要复制的全文');
  });

  it('重新生成：透传 messageId', () => {
    const onRegenerate = vi.fn();
    render(<MsgActions text="x" messageId="m-42" onRegenerate={onRegenerate} disabled={false} />);
    fireEvent.click(screen.getByRole('button', { name: /重新生成|重新/ }));
    expect(onRegenerate).toHaveBeenCalledWith('m-42');
  });

  it('异常边界：disabled=true → 点击重新生成不透传（按钮禁用）', () => {
    const onRegenerate = vi.fn();
    render(<MsgActions text="x" messageId="m1" onRegenerate={onRegenerate} disabled />);
    const btn = screen.getByRole('button', { name: /重新生成|重新/ }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.click(btn);
    expect(onRegenerate).not.toHaveBeenCalled();
  });

  it('异常边界：onRegenerate 未提供 → 点击不抛错', () => {
    render(<MsgActions text="x" messageId="m1" onRegenerate={undefined} disabled={false} />);
    expect(() =>
      fireEvent.click(screen.getByRole('button', { name: /重新生成|重新/ })),
    ).not.toThrow();
  });

  it('copied 状态：文案切换为已复制（useCopy.copied 驱动）', () => {
    vi.mocked(useCopy).mockReturnValue({ copied: true, copy: copySpy });
    render(<MsgActions text="x" messageId="m1" onRegenerate={vi.fn()} disabled={false} />);
    expect(screen.getByRole('button', { name: /已复制|copied/i })).toBeDefined();
  });
});
