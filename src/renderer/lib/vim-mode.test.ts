// src/renderer/lib/vim-mode.test.ts
// vim 模式纯逻辑单测：移动 / 编辑 / 插入切换 / 命令缓冲

import { describe, expect, it } from 'vitest';

import { INITIAL_VIM_STATE, vimHandleKey } from './vim-mode';

describe('vim-mode 纯逻辑', () => {
  it('Esc：insert → normal；normal 下清缓冲', () => {
    const insert = { mode: 'insert' as const, pending: '' };
    const r1 = vimHandleKey(insert, 'Escape', 'abc', 1);
    expect(r1.type).toBe('state');
    expect(r1.state.mode).toBe('normal');
    const pending = { mode: 'normal' as const, pending: 'd' };
    const r2 = vimHandleKey(pending, 'Escape', 'abc', 1);
    expect(r2.state).toEqual({ mode: 'normal', pending: '' });
  });

  it('h/l 左右移动并钳制边界', () => {
    expect(vimHandleKey(INITIAL_VIM_STATE, 'h', 'abc', 0).cursor).toBe(0);
    expect(vimHandleKey(INITIAL_VIM_STATE, 'l', 'abc', 2).cursor).toBe(3);
    expect(vimHandleKey(INITIAL_VIM_STATE, 'l', 'abc', 1).cursor).toBe(2);
  });

  it('j/k 上下行保持列偏移；首尾行钳制', () => {
    // 'ab\ncde'：光标 a（列0）j → c；k → 回 a
    const j = vimHandleKey(INITIAL_VIM_STATE, 'j', 'ab\ncde', 0);
    expect(j.cursor).toBe(3);
    const k = vimHandleKey(INITIAL_VIM_STATE, 'k', 'ab\ncde', 4);
    expect(k.cursor).toBe(1);
    // 最后一行 j 不动；第一行 k 不动
    expect(vimHandleKey(INITIAL_VIM_STATE, 'j', 'ab\ncde', 4).cursor).toBe(4);
    expect(vimHandleKey(INITIAL_VIM_STATE, 'k', 'ab\ncde', 0).cursor).toBe(0);
  });

  it('w/b 词首移动', () => {
    // 'foo bar baz'：词首 f(0) b(4) b(8)
    expect(vimHandleKey(INITIAL_VIM_STATE, 'w', 'foo bar baz', 0).cursor).toBe(4);
    expect(vimHandleKey(INITIAL_VIM_STATE, 'w', 'foo bar baz', 4).cursor).toBe(8);
    expect(vimHandleKey(INITIAL_VIM_STATE, 'b', 'foo bar baz', 8).cursor).toBe(4);
    expect(vimHandleKey(INITIAL_VIM_STATE, 'b', 'foo bar baz', 4).cursor).toBe(0);
  });

  it('0/$ 行首尾', () => {
    expect(vimHandleKey(INITIAL_VIM_STATE, '0', 'ab\ncde', 4).cursor).toBe(3);
    expect(vimHandleKey(INITIAL_VIM_STATE, '$', 'ab\ncde', 0).cursor).toBe(2);
  });

  it('x 删除光标处字符', () => {
    const r = vimHandleKey(INITIAL_VIM_STATE, 'x', 'abc', 1);
    expect(r.type).toBe('edit');
    expect(r.value).toBe('ac');
    expect(r.cursor).toBe(1);
  });

  it('dd 删除整行（含换行）；末行只删内容', () => {
    const mid = vimHandleKey({ mode: 'normal', pending: 'd' }, 'd', 'ab\ncde', 0);
    expect(mid.type).toBe('edit');
    expect(mid.value).toBe('cde');
    expect(mid.cursor).toBe(0);
    const last = vimHandleKey({ mode: 'normal', pending: 'd' }, 'd', 'ab\ncde', 4);
    expect(last.value).toBe('ab\n');
    expect(last.cursor).toBe(3);
  });

  it('d 后接非 d：清缓冲并照常处理该键', () => {
    const r = vimHandleKey({ mode: 'normal', pending: 'd' }, 'l', 'abc', 0);
    expect(r.state.pending).toBe('');
    expect(r.type).toBe('move');
    expect(r.cursor).toBe(1);
  });

  it('i/a/I/A 进入插入态', () => {
    expect(vimHandleKey(INITIAL_VIM_STATE, 'i', 'abc', 1)).toMatchObject({
      type: 'move',
      cursor: 1,
      state: { mode: 'insert', pending: '' },
    });
    expect(vimHandleKey(INITIAL_VIM_STATE, 'a', 'abc', 1).cursor).toBe(2);
    expect(vimHandleKey(INITIAL_VIM_STATE, 'I', 'ab\ncde', 4).cursor).toBe(3);
    expect(vimHandleKey(INITIAL_VIM_STATE, 'A', 'ab\ncde', 0).cursor).toBe(2);
  });

  it('插入态普通按键 noop（调用方放行）', () => {
    const insert = { mode: 'insert' as const, pending: '' };
    expect(vimHandleKey(insert, 'x', 'abc', 0).type).toBe('noop');
    expect(vimHandleKey(insert, 'Enter', 'abc', 0).type).toBe('noop');
  });
});
