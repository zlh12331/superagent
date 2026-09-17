// src/renderer/components/chat/streaming-footer.test.tsx
// StreamingFooter 单测：status 播报 + typing-indicator 三点占位
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { i18n } from '@/i18n/config';

import { StreamingFooter } from './streaming-footer';

const t = i18n.t.bind(i18n);

describe('StreamingFooter', () => {
  it('正向：角色行 + typing-indicator（role=status + aria-label 播报）', () => {
    render(<StreamingFooter />);
    expect(screen.getByText(t('chat.assistant'), { exact: false })).toBeDefined();
    const indicator = screen.getByRole('status');
    expect(indicator.getAttribute('aria-label')).toBe(t('chat.assistantTyping'));
    // 三点弹跳占位
    expect(indicator.querySelectorAll('.ti-dot')).toHaveLength(3);
  });

  it('边界：重复渲染互不串扰（各自独立 status 节点）', () => {
    render(
      <>
        <StreamingFooter />
        <StreamingFooter />
      </>,
    );
    expect(screen.getAllByRole('status')).toHaveLength(2);
  });
});
