// use-vim-mode.test.ts
// vim hook 单测：消费判定（edit/move/noop+normal 消费、insert 透传）与光标回调
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { useVimMode } from '../use-vim-mode';

function mount() {
  const setValue = vi.fn();
  const { result } = renderHook(() => useVimMode({ setValue }));
  return { result, setValue };
}

describe('useVimMode', () => {
  it('初始态：normal 空缓冲、无待应用光标', () => {
    const { result } = mount();
    expect(result.current.vimState).toMatchObject({ mode: 'normal', pending: '' });
    expect(result.current.pendingCursor).toBeNull();
  });

  it('normal 态任意按键均消费（返回 true，含未绑定键）', () => {
    const { result } = mount();
    expect(result.current.processKey({ key: 'q', selectionStart: 0 }, '')).toBe(true);
  });

  it('edit 消费：dd 删行 → setValue 回写 + 待应用光标', () => {
    const { result, setValue } = mount();
    const text = ['第一行', '第二行'].join('\n');
    act(() => {
      result.current.processKey({ key: 'd', selectionStart: 0 }, text);
    });
    expect(result.current.vimState).toMatchObject({ mode: 'normal', pending: 'd' });
    act(() => {
      result.current.processKey({ key: 'd', selectionStart: 0 }, text);
    });
    expect(setValue).toHaveBeenCalledTimes(1);
    expect(result.current.pendingCursor).not.toBeNull();
  });

  it('move 消费：h/l 移动光标（仅 pendingCursor，不回写值）', () => {
    const { result, setValue } = mount();
    act(() => {
      result.current.processKey({ key: 'l', selectionStart: 2 }, 'abcdef');
    });
    expect(setValue).not.toHaveBeenCalled();
    expect(result.current.pendingCursor).toBe(3);
    act(() => {
      result.current.processKey({ key: 'h', selectionStart: 3 }, 'abcdef');
    });
    expect(result.current.pendingCursor).toBe(2);
  });

  it('insert 切换后按键透传（不消费，交回输入框默认行为）', () => {
    const { result, setValue } = mount();
    act(() => {
      result.current.processKey({ key: 'i', selectionStart: 0 }, 'abc');
    });
    expect(result.current.vimState).toMatchObject({ mode: 'insert' });
    act(() => {
      result.current.processKey({ key: 'x', selectionStart: 1 }, 'abc');
    });
    expect(result.current.processKey({ key: 'x', selectionStart: 1 }, 'abc')).toBe(false);
    expect(setValue).not.toHaveBeenCalled();
  });

  it('Esc：insert → normal（消费）；clearPendingCursor 复位待应用光标', () => {
    const { result } = mount();
    act(() => {
      result.current.processKey({ key: 'i', selectionStart: 0 }, 'abc');
    });
    act(() => {
      result.current.processKey({ key: 'Escape', selectionStart: 1 }, 'abc');
    });
    expect(result.current.vimState).toMatchObject({ mode: 'normal' });
    act(() => {
      result.current.processKey({ key: 'l', selectionStart: 1 }, 'abc');
    });
    expect(result.current.pendingCursor).not.toBeNull();
    act(() => {
      result.current.clearPendingCursor();
    });
    expect(result.current.pendingCursor).toBeNull();
  });

  it('异常边界：selectionStart 为 null（受控输入未同步）→ 以文本末尾兜底', () => {
    const { result } = mount();
    expect(() =>
      result.current.processKey({ key: 'l', selectionStart: null }, 'abc'),
    ).not.toThrow();
  });
});
