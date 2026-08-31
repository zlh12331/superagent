// src/renderer/components/settings/shortcut-picker.test.ts
// formatShortcut 纯函数测试（快捷键字符串格式化：修饰键 + 主键）
import { describe, expect, it } from 'vitest';

import { formatShortcut } from './shortcut-picker';

/** 构造最小 KeyboardEvent-like（React 合成事件所需字段） */
function keyEvent(partial: {
  key: string;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  metaKey?: boolean;
}): React.KeyboardEvent {
  return {
    key: partial.key,
    ctrlKey: partial.ctrlKey ?? false,
    altKey: partial.altKey ?? false,
    shiftKey: partial.shiftKey ?? false,
    metaKey: partial.metaKey ?? false,
  } as unknown as React.KeyboardEvent;
}

describe('formatShortcut', () => {
  it('单字母无修饰 → 大写主键', () => {
    expect(formatShortcut(keyEvent({ key: 'p' }))).toBe('P');
  });

  it('Ctrl + 字母 → Ctrl+P', () => {
    expect(formatShortcut(keyEvent({ key: 'p', ctrlKey: true }))).toBe('Ctrl+P');
  });

  it('Meta + Shift + 单字符 → 按 Ctrl/Alt/Shift/Meta 顺序', () => {
    expect(formatShortcut(keyEvent({ key: 'f', metaKey: true, shiftKey: true }))).toBe(
      'Shift+Meta+F',
    );
  });

  it('Ctrl + Alt + S → Ctrl+Alt+S', () => {
    expect(formatShortcut(keyEvent({ key: 's', ctrlKey: true, altKey: true }))).toBe('Ctrl+Alt+S');
  });

  it('空格主键 → Space', () => {
    expect(formatShortcut(keyEvent({ key: ' ', ctrlKey: true }))).toBe('Ctrl+Space');
  });

  it('功能键（如 F1）原样保留大写', () => {
    expect(formatShortcut(keyEvent({ key: 'F1' }))).toBe('F1');
  });

  it('纯修饰键（Control）→ null（还需主键）', () => {
    expect(formatShortcut(keyEvent({ key: 'Control', ctrlKey: true }))).toBeNull();
  });

  it('Escape → null（取消录制语义）', () => {
    expect(formatShortcut(keyEvent({ key: 'Escape' }))).toBeNull();
  });

  it('Backspace / Delete → null（清空语义）', () => {
    expect(formatShortcut(keyEvent({ key: 'Backspace' }))).toBeNull();
    expect(formatShortcut(keyEvent({ key: 'Delete' }))).toBeNull();
  });
});
