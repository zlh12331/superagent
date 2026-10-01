// tool-call-view.test.tsx — P4 签名时刻：错误默认展开 / settled·error 钩子
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/stores/persistent/sessions-store', () => ({
  useActiveSessionStore: () => 'sess-1',
}));
vi.mock('@/stores/transient/tool-store', () => ({
  useToolStore: (
    sel: (s: { callsBySession: Map<string, { id: string; title: string }[]> }) => unknown,
  ) =>
    sel({
      callsBySession: new Map([['sess-1', [{ id: 'call-1', title: 'run shell' }]]]),
    }),
}));

import { ToolCallView } from './tool-call-view';

describe('ToolCallView · 签名状态钩子', () => {
  it('output-error：默认展开错误块且带 is-error', () => {
    const { container } = render(
      <ToolCallView
        type="tool-exec_command"
        toolCallId="call-1"
        state="output-error"
        input={undefined}
        output={undefined}
        errorText="boom"
      />,
    );
    expect(container.querySelector('.tool-card')?.className).toContain('is-error');
    expect(container.querySelector('.tool-card')?.className).toContain('open');
    expect(screen.getByText('boom')).toBeInTheDocument();
  });

  it('output-available：带 is-settled 且默认折叠', () => {
    const { container } = render(
      <ToolCallView
        type="tool-exec_command"
        toolCallId="call-1"
        state="output-available"
        input={{ a: 1 }}
        output="ok"
        errorText={undefined}
      />,
    );
    expect(container.querySelector('.tool-card')?.className).toContain('is-settled');
    expect(container.querySelector('.tool-card')?.className).not.toContain('open');
  });

  it('input-available（running）：无 settled/error 钩子', () => {
    const { container } = render(
      <ToolCallView
        type="tool-exec_command"
        toolCallId="call-1"
        state="input-available"
        input={undefined}
        output={undefined}
        errorText={undefined}
      />,
    );
    const cls = container.querySelector('.tool-card')?.className ?? '';
    expect(cls).not.toContain('is-settled');
    expect(cls).not.toContain('is-error');
  });
});
