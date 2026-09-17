// use-composer-input.test.ts
// composer 输入状态 hook 单测：受控/非受控双模 / 草稿恢复与保存 / 会话切换 /
// 注入值（受控跳过）/ 附件去重与移除 / clear
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useDraftStore } from '@/stores/persistent/draft-store';

import { type UseComposerInputDeps, useComposerInput } from './use-composer-input';

type Deps = Omit<UseComposerInputDeps, 'onValueChange'>;

/** 全 undefined 基线（UseComposerInputDeps 各键必填、接受 undefined） */
const NONE: Deps = { chatId: undefined, controlledValue: undefined, injectedValue: undefined };

/** 挂载器：显式 deps 驱动 rerender；onValueChange 始终注入 spy */
function mountInput(deps: Deps) {
  const onValueChange = vi.fn();
  const full = (d: Deps): UseComposerInputDeps => ({ onValueChange, ...d });
  const { result, rerender } = renderHook((d: UseComposerInputDeps) => useComposerInput(d), {
    initialProps: full(deps),
  });
  const rerenderWith = (next: Deps): void => rerender(full(next));
  return { result, onValueChange, rerenderWith };
}

describe('useComposerInput', () => {
  beforeEach(() => {
    useDraftStore.setState({ drafts: {} });
  });

  it('非受控 + 无会话：初始为空串，setValue 更新内部值', () => {
    const { result } = mountInput({ ...NONE });
    expect(result.current.value).toBe('');
    act(() => {
      result.current.setValue('hello');
    });
    expect(result.current.value).toBe('hello');
  });

  it('受控模式：value 读外部值，setValue 转发 onValueChange 而不改内部', () => {
    const { result, onValueChange, rerenderWith } = mountInput({
      ...NONE,
      controlledValue: 'abc',
    });
    expect(result.current.value).toBe('abc');
    act(() => {
      result.current.setValue('x');
    });
    expect(onValueChange).toHaveBeenCalledWith('x');
    expect(result.current.value).toBe('abc');
    // 外部值变化 → 跟随
    rerenderWith({ ...NONE, controlledValue: 'abcd' });
    expect(result.current.value).toBe('abcd');
  });

  it('草稿恢复：挂载时按 chatId 恢复文本与附件', () => {
    useDraftStore.getState().setDraft('s1', { text: '草稿文本', attachments: ['/proj/附件A.txt'] });
    const { result } = mountInput({ ...NONE, chatId: 's1' });
    expect(result.current.value).toBe('草稿文本');
    expect(result.current.attachments).toEqual([{ path: '/proj/附件A.txt', name: '附件A.txt' }]);
  });

  it('草稿保存：非受控输入变化写入 draft-store', () => {
    const { result } = mountInput({ ...NONE, chatId: 's2' });
    act(() => {
      result.current.setValue('hello');
    });
    expect(useDraftStore.getState().getDraft('s2').text).toBe('hello');
  });

  it('会话切换：恢复新会话草稿（旧会话输入不交叉污染）', () => {
    useDraftStore.getState().setDraft('s1', { text: 's1 内容', attachments: [] });
    useDraftStore.getState().setDraft('s3', { text: 's3 内容', attachments: [] });
    const { result, rerenderWith } = mountInput({ ...NONE, chatId: 's1' });
    expect(result.current.value).toBe('s1 内容');
    act(() => {
      result.current.setValue('s1 修改');
    });
    rerenderWith({ ...NONE, chatId: 's3' });
    expect(result.current.value).toBe('s3 内容');
    expect(useDraftStore.getState().getDraft('s3').text).toBe('s3 内容');
  });

  it('注入值（编辑重提）：非受控模式下同步一次', () => {
    const { result, rerenderWith } = mountInput({ ...NONE, chatId: 's1', injectedValue: '/goal ' });
    expect(result.current.value).toBe('/goal ');
    rerenderWith({ ...NONE, chatId: 's1' });
    // undefined 注入不触发清空（守卫：injectedValue === undefined 直接返回）
    expect(result.current.value).toBe('/goal ');
  });

  it('注入值：受控模式下被忽略（不破坏受控语义）', () => {
    const { result, rerenderWith } = mountInput({ ...NONE, controlledValue: '外部值' });
    rerenderWith({ ...NONE, controlledValue: '外部值', injectedValue: '/cmd' });
    expect(result.current.value).toBe('外部值');
  });

  it('附件：选择去重、按路径移除', () => {
    const { result } = mountInput({ ...NONE });
    act(() => {
      result.current.pickAttachments(['/proj/a.txt', '/proj/b.txt']);
    });
    expect(result.current.attachments.map((a) => a.name)).toEqual(['a.txt', 'b.txt']);
    act(() => {
      result.current.pickAttachments(['/proj/a.txt', '/proj/c.txt']);
    });
    // a.txt 去重，仅追加 c.txt
    expect(result.current.attachments.map((a) => a.name)).toEqual(['a.txt', 'b.txt', 'c.txt']);
    act(() => {
      result.current.removeAttachment('/proj/b.txt');
    });
    expect(result.current.attachments.map((a) => a.name)).toEqual(['a.txt', 'c.txt']);
  });

  it('clear：清空输入与附件（草稿由发送方 clearDraft 负责）', () => {
    useDraftStore.getState().setDraft('s1', { text: 'x', attachments: [] });
    const { result } = mountInput({ ...NONE, chatId: 's1' });
    act(() => {
      result.current.pickAttachments(['/a.txt']);
    });
    act(() => {
      result.current.clear();
    });
    expect(result.current.value).toBe('');
    expect(result.current.attachments).toEqual([]);
  });
});
