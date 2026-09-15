// file-change-card.test.tsx
// 文件变更 diff 卡片单测：正向渲染 / 边界（畸形 input）/ 折叠展开 / 双工具形态
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { i18n } from '@/i18n/config';

import { FileChangeCard } from '../file-change-card';

const t = i18n.t.bind(i18n);

describe('FileChangeCard', () => {
  it('正向 edit_file：文件名 + modified 徽章 + 增删统计', () => {
    render(
      <FileChangeCard
        toolName="edit_file"
        input={{ path: '/proj/src/a.ts', oldString: '旧内容', newString: '新内容' }}
      />,
    );
    expect(screen.getByText('a.ts')).toBeDefined();
    expect(screen.getByText(t('chat.fileChange.modified'))).toBeDefined();
    expect(screen.getByText('+1 / -1')).toBeDefined();
  });

  it('正向 write_file：created 徽章（无删除行）', () => {
    render(
      <FileChangeCard
        toolName="write_file"
        input={{ path: '/proj/new.ts', content: '全新内容' }}
      />,
    );
    expect(screen.getByText(t('chat.fileChange.created'))).toBeDefined();
    expect(screen.getByText('+1 / -0')).toBeDefined();
  });

  it('边界：折叠态不渲染 diff 行，展开后可见增删行', () => {
    render(
      <FileChangeCard
        toolName="edit_file"
        input={{ path: '/a.ts', oldString: 'old line', newString: 'new line' }}
      />,
    );
    // 折叠态：diff 内容不挂载
    expect(screen.queryByText('old line')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: t('chat.toggleToolDetails') }));
    expect(screen.getByText('old line')).toBeDefined();
    expect(screen.getByText('new line')).toBeDefined();
  });

  it('边界：input 非对象（畸形字符串）→ 不渲染（返回 null）', () => {
    const { container } = render(<FileChangeCard toolName="edit_file" input="不是对象" />);
    expect(container.firstChild).toBeNull();
  });

  it('边界：path 缺失或空串 → 不渲染', () => {
    const { container } = render(
      <FileChangeCard toolName="edit_file" input={{ oldString: 'a', newString: 'b' }} />,
    );
    expect(container.firstChild).toBeNull();
    const { container: c2 } = render(
      <FileChangeCard toolName="write_file" input={{ path: '', content: 'x' }} />,
    );
    expect(c2.firstChild).toBeNull();
  });

  it('异常：oldString/newString 非字符串（畸形 number）→ String 兜底渲染不崩', () => {
    render(
      <FileChangeCard
        toolName="edit_file"
        input={{ path: '/a.ts', oldString: 42, newString: null }}
      />,
    );
    // oldString=42 → '42'；newString=null → ''（空 diff 行）
    fireEvent.click(screen.getByRole('button', { name: t('chat.toggleToolDetails') }));
    expect(screen.getByText('42')).toBeDefined();
  });

  it('异常：跨平台路径 → basename 展示（win32 反斜杠）', () => {
    render(
      <FileChangeCard toolName="write_file" input={{ path: 'C:\\w\\deep\\n.ts', content: 'x' }} />,
    );
    expect(screen.getByText('n.ts')).toBeDefined();
  });
});
