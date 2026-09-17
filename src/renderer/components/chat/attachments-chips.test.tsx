// attachments-chips.test.tsx
// 附件 chip 列表单测：空态 / 渲染 / 移除回调 / 无障碍命名
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { AttachmentsChips } from './attachments-chips';

describe('AttachmentsChips', () => {
  it('空数组：不渲染（返回 null）', () => {
    const { container } = render(<AttachmentsChips attachments={[]} onRemove={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });

  it('正向：渲染文件名 chip（title 为完整路径）', () => {
    render(
      <AttachmentsChips
        attachments={[
          { path: '/proj/深目录/a.txt', name: 'a.txt' },
          { path: 'C:\\w\\b.md', name: 'b.md' },
        ]}
        onRemove={vi.fn()}
      />,
    );
    expect(screen.getByText('a.txt')).toBeDefined();
    expect(screen.getByText('b.md')).toBeDefined();
    expect(screen.getByTitle('/proj/深目录/a.txt')).toBeDefined();
  });

  it('移除：点击 X 触发 onRemove(对应路径)', () => {
    const onRemove = vi.fn();
    render(
      <AttachmentsChips
        attachments={[
          { path: '/a.txt', name: 'a.txt' },
          { path: '/b.txt', name: 'b.txt' },
        ]}
        onRemove={onRemove}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /a\.txt/ }));
    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(onRemove).toHaveBeenCalledWith('/a.txt');
  });

  it('异常边界：同一文件名出现在不同目录 → 移除按钮同名（以 chip title 路径区分，按索引点击各自生效）', () => {
    const onRemove = vi.fn();
    render(
      <AttachmentsChips
        attachments={[
          { path: '/x/readme.md', name: 'readme.md' },
          { path: '/y/readme.md', name: 'readme.md' },
        ]}
        onRemove={onRemove}
      />,
    );
    const buttons = screen.getAllByRole('button', { name: /readme\.md/ });
    // 同名文件的移除按钮 label 相同（现实约束）；区分依赖 chip 的 title=完整路径
    expect(buttons).toHaveLength(2);
    expect(screen.getAllByTitle('/x/readme.md')).toHaveLength(1);
    expect(screen.getAllByTitle('/y/readme.md')).toHaveLength(1);
    fireEvent.click(buttons[1] as HTMLElement);
    expect(onRemove).toHaveBeenCalledWith('/y/readme.md');
  });
});
