// src/renderer/lib/shortcut-conflicts.test.ts
// 快捷键冲突检测纯函数测试（36 号 C：归一化 + 冲突矩阵 + 固定键清单锚定）

import { describe, expect, it } from 'vitest';

import { FIXED_SHORTCUT_CONFLICTS } from '@/hooks/use-keyboard-shortcuts';
import {
  CUSTOM_SHORTCUT_KEYS,
  findShortcutConflict,
  normalizeShortcutForCompare,
} from './shortcut-conflicts';

describe('normalizeShortcutForCompare', () => {
  it('Meta ≡ Ctrl 跨平台等价（V3）', () => {
    expect(normalizeShortcutForCompare('Meta+P')).toBe('ctrl+p');
    expect(normalizeShortcutForCompare('Ctrl+P')).toBe('ctrl+p');
    expect(normalizeShortcutForCompare('Cmd+P')).toBe('ctrl+p');
  });

  it('修饰符排序归一（alt < ctrl < shift）', () => {
    expect(normalizeShortcutForCompare('Shift+Ctrl+T')).toBe('ctrl+shift+t');
    expect(normalizeShortcutForCompare('Ctrl+Shift+T')).toBe('ctrl+shift+t');
    expect(normalizeShortcutForCompare('Alt+Ctrl+K')).toBe('alt+ctrl+k');
  });

  it('主键小写归一', () => {
    expect(normalizeShortcutForCompare('Ctrl+F')).toBe('ctrl+f');
    expect(normalizeShortcutForCompare('Ctrl+ArrowLeft')).toBe('ctrl+arrowleft');
  });

  it('空串（解绑）/ 纯修饰键 → null（永不冲突，V4）', () => {
    expect(normalizeShortcutForCompare('')).toBeNull();
    expect(normalizeShortcutForCompare('   ')).toBeNull();
    expect(normalizeShortcutForCompare('Ctrl')).toBeNull();
    expect(normalizeShortcutForCompare('Ctrl+Shift')).toBeNull();
  });
});

describe('findShortcutConflict', () => {
  /** 当前自定义键值（默认形态，与 settings-store 默认一致的样本） */
  const shortcuts = {
    commandPalette: 'Ctrl+P',
    saveFile: 'Ctrl+S',
    searchFile: 'Ctrl+F',
    toggleTheme: 'Ctrl+Shift+T',
    openSettings: 'Ctrl+,',
    newSession: 'Ctrl+N',
  };

  it('与其他自定义键冲突 → kind=custom 且带键名（V1）', () => {
    const conflict = findShortcutConflict('Ctrl+S', 'commandPalette', shortcuts);
    expect(conflict).toEqual({ kind: 'custom', key: 'saveFile' });
  });

  it('Meta 录入与 Ctrl 已有键冲突（跨平台等价，V3）', () => {
    const conflict = findShortcutConflict('Meta+S', 'commandPalette', shortcuts);
    expect(conflict).toEqual({ kind: 'custom', key: 'saveFile' });
  });

  it('与固定键冲突 → kind=fixed 且带动作名（V2：Ctrl+B 侧栏）', () => {
    const conflict = findShortcutConflict('Ctrl+B', 'newSession', shortcuts);
    expect(conflict).toEqual({ kind: 'fixed', labelKey: 'shortcutHelp.item.toggleSidebar' });
  });

  it('与固定键 Meta 形态冲突（mac 录 Meta+B 命中 ctrl+b 绑定，V3）', () => {
    const conflict = findShortcutConflict('Meta+K', 'newSession', shortcuts);
    expect(conflict).toEqual({ kind: 'fixed', labelKey: 'shortcutHelp.item.openCommandPalette' });
  });

  it('缩放固定键冲突（ctrl+= / ctrl+shift+= / ctrl+-，V2）', () => {
    expect(findShortcutConflict('Ctrl+=', 'newSession', shortcuts)).toMatchObject({
      kind: 'fixed',
    });
    expect(findShortcutConflict('Ctrl+Shift+=', 'newSession', shortcuts)).toMatchObject({
      kind: 'fixed',
    });
    expect(findShortcutConflict('Ctrl+-', 'newSession', shortcuts)).toMatchObject({
      kind: 'fixed',
    });
  });

  it('空串（解绑）永不冲突（V4）', () => {
    expect(findShortcutConflict('', 'newSession', shortcuts)).toBeNull();
  });

  it('与自身当前值相同 → 放行（V5：excludeKey 排除自身）', () => {
    expect(findShortcutConflict('Ctrl+P', 'commandPalette', shortcuts)).toBeNull();
  });

  it('无冲突 → null', () => {
    // Ctrl+E 不与任何自定义键/固定键冲突
    expect(findShortcutConflict('Ctrl+E', 'newSession', shortcuts)).toBeNull();
  });
});

describe('FIXED_SHORTCUT_CONFLICTS 清单锚定（漂移防护，V8）', () => {
  it('条目数与归一化形态合法（全部能被 normalize 复现）', () => {
    expect(FIXED_SHORTCUT_CONFLICTS.length).toBe(13);
    for (const fixed of FIXED_SHORTCUT_CONFLICTS) {
      expect(normalizeShortcutForCompare(fixed.match)).toBe(fixed.match);
      expect(fixed.labelKey).toMatch(/^shortcutHelp\.item\./);
    }
  });

  it('可自定义键名清单与 KeyboardShortcuts 六键一致', () => {
    expect(CUSTOM_SHORTCUT_KEYS).toEqual([
      'commandPalette',
      'saveFile',
      'searchFile',
      'toggleTheme',
      'openSettings',
      'newSession',
    ]);
  });
});
