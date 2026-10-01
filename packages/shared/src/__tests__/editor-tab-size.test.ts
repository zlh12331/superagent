// packages/shared/src/__tests__/editor-tab-size.test.ts
// 编辑器 Tab 宽度档位纯函数测试（37 号 A）

import { describe, expect, it } from 'vitest';

import { clampEditorTabSize, DEFAULT_EDITOR_TAB_SIZE, EDITOR_TAB_SIZES } from '../constants/editor';

describe('clampEditorTabSize', () => {
  it('非有限数（NaN/Infinity/非数值）→ 默认 8（缺失语义，非钳到最小档）', () => {
    expect(clampEditorTabSize(Number.NaN)).toBe(DEFAULT_EDITOR_TAB_SIZE);
    expect(clampEditorTabSize(Number.POSITIVE_INFINITY)).toBe(DEFAULT_EDITOR_TAB_SIZE);
  });

  it('档位内原样返回', () => {
    for (const size of EDITOR_TAB_SIZES) {
      expect(clampEditorTabSize(size)).toBe(size);
    }
  });

  it('档位外归最近档（等距取首遇小档，clampZoom 同语义）', () => {
    // 6 距 4 与 8 均为 2 → 取先遇的 4（与 clampZoom 的 dist < best 首遇语义一致）
    expect(clampEditorTabSize(6)).toBe(4);
    expect(clampEditorTabSize(1)).toBe(2);
    expect(clampEditorTabSize(16)).toBe(8);
  });
});
