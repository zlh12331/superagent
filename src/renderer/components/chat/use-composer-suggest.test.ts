// use-composer-suggest.test.ts
// 建议面板状态机单测：触发检测 / 候选过滤 / 键盘导航 / 应用与 Esc 清段 / 播报文案
import { act, renderHook } from '@testing-library/react';
import type { KeyboardEvent } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { type UseComposerSuggestDeps, useComposerSuggest } from './use-composer-suggest';

// 播报文案断言需要确定性 t：mock 为键名直返（真实 i18n 在测试环境返回中文文案）
vi.mock('@/i18n/use-translation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

/** 手造键盘事件（handleSuggestKeyDown 只读 key / currentTarget.selectionStart / preventDefault） */
function keyEvent(key: string, selectionStart: number | null = null) {
  return {
    key,
    currentTarget: { selectionStart },
    preventDefault: vi.fn(),
  } as unknown as KeyboardEvent<HTMLTextAreaElement>;
}

/** 以受控 value 驱动的 hook 挂载器 */
function mountSuggest(initial: Partial<UseComposerSuggestDeps> & { value: string }) {
  const setValue = vi.fn();
  const onAfterChange = vi.fn();
  const onSlashCommand = vi.fn();
  const textareaRef = { current: null };
  const deps = {
    setValue,
    workingDir: undefined,
    onSlashCommand,
    textareaRef,
    onAfterChange,
    ...initial,
  };
  const { result, rerender } = renderHook((d: UseComposerSuggestDeps) => useComposerSuggest(d), {
    initialProps: deps,
  });
  const rerenderWith = (next: Partial<UseComposerSuggestDeps>): void => {
    rerender({ ...deps, ...next });
  };
  return { result, setValue, onAfterChange, onSlashCommand, textareaRef, rerenderWith };
}

describe('useComposerSuggest', () => {
  it('无触发词：activeTrigger=null、面板关闭', () => {
    const { result } = mountSuggest({ value: '普通文本' });
    expect(result.current.activeTrigger).toBeNull();
    expect(result.current.suggestOpen).toBe(false);
    expect(result.current.filteredSuggestions).toEqual([]);
    expect(result.current.mentionFiles).toEqual([]);
  });

  it('slash 触发：/c 匹配 /clear /compact（2 条），面板打开', () => {
    const { result } = mountSuggest({ value: '/c' });
    expect(result.current.activeTrigger).toBe('slash');
    expect(result.current.suggestOpen).toBe(true);
    expect(result.current.filteredSuggestions.map((s) => s.command)).toEqual([
      '/clear',
      '/compact',
    ]);
    expect(result.current.suggestionTotal).toBe(2);
  });

  it('slash 触发但无匹配候选：面板关闭', () => {
    const { result } = mountSuggest({ value: '/zzz' });
    expect(result.current.activeTrigger).toBe('slash');
    expect(result.current.suggestOpen).toBe(false);
  });

  it('高亮重置：value 变化后 suggestIndex 归零', () => {
    const { result, rerenderWith } = mountSuggest({ value: '/c' });
    act(() => {
      result.current.handleSuggestKeyDown(keyEvent('ArrowDown'));
    });
    expect(result.current.suggestIndex).toBe(1);
    rerenderWith({ value: '/cl' });
    expect(result.current.suggestIndex).toBe(0);
  });

  it('ArrowDown/ArrowUp 循环选择（不越界）', () => {
    const { result } = mountSuggest({ value: '/c' });
    act(() => {
      result.current.handleSuggestKeyDown(keyEvent('ArrowDown'));
    });
    expect(result.current.suggestIndex).toBe(1);
    act(() => {
      result.current.handleSuggestKeyDown(keyEvent('ArrowDown'));
    });
    // 2 条候选：index 1 → 循环回 0
    expect(result.current.suggestIndex).toBe(0);
    act(() => {
      result.current.handleSuggestKeyDown(keyEvent('ArrowUp'));
    });
    expect(result.current.suggestIndex).toBe(1);
  });

  it('Tab/Enter 应用带 action 的命令：清空输入 + 执行动作（不填充文本）', () => {
    const { result, setValue, onSlashCommand, onAfterChange } = mountSuggest({ value: '/c' });
    act(() => {
      result.current.handleSuggestKeyDown(keyEvent('Enter'));
    });
    // 高亮第 0 条 = /clear（带 action）
    expect(setValue).toHaveBeenCalledWith('');
    expect(onSlashCommand).toHaveBeenCalledWith('clear');
    expect(onAfterChange).toHaveBeenCalled();
  });

  it('applySuggestion 无 action 的命令走填充路径（不存在命令 → 原样填入）', () => {
    const { result, setValue } = mountSuggest({ value: '/c' });
    act(() => {
      result.current.applySuggestion('/no-such-cmd');
    });
    expect(setValue).toHaveBeenCalledWith('/no-such-cmd');
  });

  it('applyMention：替换 @查询 为 @完整路径', () => {
    const { result, setValue } = mountSuggest({ value: '看看 @src' });
    act(() => {
      result.current.applyMention('/proj/a.ts');
    });
    expect(setValue).toHaveBeenCalledWith('看看 @/proj/a.ts ');
  });

  it('Esc 只清除触发段：保留触发词之前的输入（run /cl → run ）', () => {
    // 触发契约：查询段不含空格 → Esc 场景必然是「触发段到文本末尾」；
    // 斜杠前的前缀文本（'run '）必须保留
    const { result, setValue } = mountSuggest({ value: 'run /cl' });
    act(() => {
      // 光标在末尾（selectionStart=7）
      result.current.handleSuggestKeyDown(keyEvent('Escape', 7));
    });
    expect(setValue).toHaveBeenCalledWith('run ');
  });

  it('Esc 清除裸触发段：/cl → 空串', () => {
    const { result, setValue } = mountSuggest({ value: '/cl' });
    act(() => {
      result.current.handleSuggestKeyDown(keyEvent('Escape', 3));
    });
    expect(setValue).toHaveBeenCalledWith('');
  });

  it('未打开面板时键盘不消费（返回 false 透传 vim/发送逻辑）', () => {
    const { result } = mountSuggest({ value: 'plain' });
    expect(result.current.handleSuggestKeyDown(keyEvent('ArrowDown'))).toBe(false);
    expect(result.current.handleSuggestKeyDown(keyEvent('Enter'))).toBe(false);
  });

  it('播报文案：命令 = 命令名 + 本地化说明（t 直返键名的 mock 下）', () => {
    const { result } = mountSuggest({ value: '/c' });
    expect(result.current.activeSuggestionLabel).toBe('/clear chat.slashSuggest.clear');
    expect(result.current.suggestionTotal).toBe(2);
  });
});
