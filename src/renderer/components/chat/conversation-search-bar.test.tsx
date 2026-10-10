import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ConversationSearchBar } from './conversation-search-bar';

function mount(overrides?: Partial<Parameters<typeof ConversationSearchBar>[0]>) {
  const onSearch = vi.fn();
  const onNavigate = vi.fn();
  const onClose = vi.fn();
  const props = {
    visible: true,
    query: '',
    totalMatches: 0,
    currentMatch: 0,
    onSearch,
    onNavigate,
    onClose,
    ...overrides,
  };
  render(<ConversationSearchBar {...props} />);
  return { onSearch, onNavigate, onClose, props };
}

describe('ConversationSearchBar', () => {
  it('visible=false：不渲染', () => {
    const { container } = render(
      <ConversationSearchBar
        visible={false}
        query=""
        totalMatches={0}
        currentMatch={0}
        onSearch={vi.fn()}
        onNavigate={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('正向：受控 query 回显 + 匹配计数（2/5）', () => {
    mount({ query: '关键词', totalMatches: 5, currentMatch: 2 });
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('关键词');
    expect(screen.getByText('2/5')).toBeDefined();
  });

  it('边界：有查询但无匹配 → 0/0；导航按钮禁用', () => {
    mount({ query: '不存在', totalMatches: 0, currentMatch: 0 });
    expect(screen.getByText('0/0')).toBeDefined();
    const [prevBtn, nextBtn, closeBtn] = screen.getAllByRole('button') as [
      HTMLButtonElement,
      HTMLButtonElement,
      HTMLButtonElement,
    ];
    expect(prevBtn.disabled).toBe(true);
    expect(nextBtn.disabled).toBe(true);
    expect(closeBtn.disabled).toBe(false);
  });

  it('键盘：Enter=下一个，Shift+Enter=上一个，Esc=关闭', () => {
    const { onNavigate, onClose } = mount({ query: 'x', totalMatches: 3, currentMatch: 1 });
    const input = screen.getByRole('textbox');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onNavigate).toHaveBeenCalledWith(1);
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(onNavigate).toHaveBeenCalledWith(-1);
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('IME 组合态：Enter 不触发导航（选词而非跳转）', () => {
    const { onNavigate } = mount({ query: 'zhongwen', totalMatches: 3, currentMatch: 1 });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', isComposing: true });
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it('IME 组合态：Escape 不关闭搜索栏（取消候选）', () => {
    const { onClose } = mount({ query: 'zhongwen', totalMatches: 3, currentMatch: 1 });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape', isComposing: true });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('IME 组合结束后：Enter 恢复导航（组合态不是永久屏蔽）', () => {
    const { onNavigate } = mount({ query: '中文', totalMatches: 3, currentMatch: 1 });
    const input = screen.getByRole('textbox');
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: false });
    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(onNavigate).toHaveBeenCalledWith(1);
  });

  it('输入：受控转发 onSearch', () => {
    const { onSearch } = mount({ query: '' });
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '新词' } });
    expect(onSearch).toHaveBeenCalledWith('新词');
  });

  it('按钮：上/下导航与关闭点击透传', () => {
    const { onNavigate, onClose } = mount({ query: 'x', totalMatches: 3, currentMatch: 1 });
    const [prevBtn, nextBtn, closeBtn] = screen.getAllByRole('button') as [
      HTMLButtonElement,
      HTMLButtonElement,
      HTMLButtonElement,
    ];
    fireEvent.click(prevBtn);
    expect(onNavigate).toHaveBeenLastCalledWith(-1);
    fireEvent.click(nextBtn);
    expect(onNavigate).toHaveBeenLastCalledWith(1);
    fireEvent.click(closeBtn);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
