// src/renderer/components/chat/streaming-cursor.test.tsx
// StreamingCursor 单测：aria-hidden 装饰性光标（不进入读屏树）
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { StreamingCursor } from './streaming-cursor';

describe('StreamingCursor', () => {
  it('渲染装饰性光标（aria-hidden，不进入读屏树）', () => {
    const { container } = render(<StreamingCursor />);
    const el = container.querySelector('span[aria-hidden="true"]');
    expect(el).not.toBeNull();
  });
});
