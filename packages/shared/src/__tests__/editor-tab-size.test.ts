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
    expect(clampEditorTabSize(6)).toBe(4);
    expect(clampEditorTabSize(1)).toBe(2);
    expect(clampEditorTabSize(16)).toBe(8);
  });
});
