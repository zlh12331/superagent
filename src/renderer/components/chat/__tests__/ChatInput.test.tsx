// src/renderer/components/chat/__tests__/ChatInput.test.tsx
// ChatInput 组件测试（纯受控组件：状态按钮 + 斜杠建议）
// ──────────────────────────────────────────────────────────────
// 测试要点：
// 1. 空输入：发送按钮禁用
// 2. 输入文本：发送按钮启用，点击触发 onSend
// 3. 输入 "/"：弹出斜杠建议列表
// 4. streaming 状态：显示停止按钮
// ──────────────────────────────────────────────────────────────

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ChatInput } from '../ChatInput';

describe('ChatInput', () => {
  const onSend = vi.fn();
  const onStop = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('空输入：发送按钮禁用', () => {
    render(<ChatInput status="ready" onSend={onSend} onStop={onStop} />);
    expect(screen.getByRole('button', { name: /发送消息/ })).toBeDisabled();
  });

  it('输入文本：发送按钮启用，点击触发 onSend', async () => {
    render(<ChatInput status="ready" onSend={onSend} onStop={onStop} />);
    const input = screen.getByRole('textbox');
    await userEvent.type(input, '你好');
    const sendButton = screen.getByRole('button', { name: /发送消息/ });
    expect(sendButton).toBeEnabled();
    await userEvent.click(sendButton);
    expect(onSend).toHaveBeenCalledWith('你好');
  });

  it('输入 "/"：弹出斜杠建议列表', async () => {
    render(<ChatInput status="ready" onSend={onSend} onStop={onStop} />);
    const input = screen.getByRole('textbox');
    await userEvent.type(input, '/');
    // listbox 弹出且至少包含一个建议项
    expect(screen.getByRole('listbox')).toBeTruthy();
    expect(screen.getAllByRole('option').length).toBeGreaterThan(0);
  });

  it('streaming 状态：显示停止按钮且不显示发送按钮', () => {
    render(<ChatInput status="streaming" onSend={onSend} onStop={onStop} />);
    expect(screen.getByRole('button', { name: /停止/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /发送消息/ })).toBeNull();
  });
});
