// src/renderer/components/chat/__tests__/ChatInput.test.tsx
// ChatInput 组件测试（纯受控组件：状态按钮 + 斜杠建议）
// ──────────────────────────────────────────────────────────────
// 测试要点：
// 1. 空输入：发送按钮禁用
// 2. 输入文本：发送按钮启用，点击触发 onSend
// 3. 输入 "/"：弹出斜杠建议列表
// 4. streaming 状态：显示停止按钮
// ──────────────────────────────────────────────────────────────

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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

  it('斜杠建议 9 个命令齐全（/help /new /clear /compact /models /interrupt /goal /demo /limit）', async () => {
    render(<ChatInput status="ready" onSend={onSend} onStop={onStop} />);
    const input = screen.getByRole('textbox');
    await userEvent.type(input, '/');

    const commands = screen.getAllByRole('option').map((o) => o.textContent?.trim() ?? '');
    expect(commands).toHaveLength(9);
    // textContent 为「命令+描述」拼接（如 '/interrupt中断当前生成'），按前缀断言
    const commandNames = commands.map((c) => c.split(/[^/a-z]/i)[0]);
    expect(commandNames).toEqual(
      expect.arrayContaining([
        '/help',
        '/new',
        '/clear',
        '/compact',
        '/models',
        '/interrupt',
        '/goal',
        '/demo',
        '/limit',
      ]),
    );
  });

  it('斜杠过滤：输入 "/i" → 仅显示 /interrupt（command 带 / 前缀与查询词匹配）', async () => {
    render(<ChatInput status="ready" onSend={onSend} onStop={onStop} />);
    const input = screen.getByRole('textbox');
    await userEvent.type(input, '/i');

    const commands = screen.getAllByRole('option').map((o) => o.textContent?.trim() ?? '');
    const commandNames = commands.map((c) => c.split(/[^/a-z]/i)[0]);
    expect(commandNames).toEqual(expect.arrayContaining(['/interrupt']));
    expect(commandNames).not.toContain('/goal');
  });

  it('斜杠过滤：输入 "/g" → 仅显示 /goal', async () => {
    render(<ChatInput status="ready" onSend={onSend} onStop={onStop} />);
    const input = screen.getByRole('textbox');
    await userEvent.type(input, '/g');

    const commands = screen.getAllByRole('option').map((o) => o.textContent?.trim() ?? '');
    const commandNames = commands.map((c) => c.split(/[^/a-z]/i)[0]);
    expect(commandNames).toEqual(expect.arrayContaining(['/goal']));
    expect(commandNames).not.toContain('/interrupt');
  });

  it('点击 /interrupt 建议 → onSlashCommand("interrupt") + 输入框清空', async () => {
    const onSlashCommand = vi.fn();
    render(
      <ChatInput status="ready" onSend={onSend} onStop={onStop} onSlashCommand={onSlashCommand} />,
    );
    const input = screen.getByRole('textbox');
    await userEvent.type(input, '/i');
    await userEvent.click(screen.getByText('/interrupt'));

    expect(onSlashCommand).toHaveBeenCalledWith('interrupt');
    expect(input).toHaveValue('');
  });

  it('streaming 状态：显示停止按钮且不显示发送按钮', () => {
    render(<ChatInput status="streaming" onSend={onSend} onStop={onStop} />);
    expect(screen.getByRole('button', { name: /停止/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /发送消息/ })).toBeNull();
  });

  // ── IME 组合态（2026-09 审计修复的回归锚） ─────────────────────
  //
  // 背景：中文/日文输入法候选窗内的 Enter（选用候选词）与 Esc（取消候选）都会
  // 派发 keydown，key 正是 'Enter'/'Escape' 且无修饰键。此前未判 isComposing，
  // 用户「打拼音按 Enter 上字」会直接把半截文本发送出去（本项目带 zh-CN 语言包，
  // 属主干路径）。修复用 event.nativeEvent.isComposing 拦截。

  it('IME 组合态：Enter 不发送（候选词上字不应触发发送）', () => {
    render(<ChatInput status="ready" onSend={onSend} onStop={onStop} />);
    const input = screen.getByRole('textbox');

    fireEvent.change(input, { target: { value: 'nihao' } });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });

    expect(onSend).not.toHaveBeenCalled();
  });

  it('IME 组合态：Esc 不中断生成', () => {
    render(<ChatInput status="streaming" onSend={onSend} onStop={onStop} />);
    const input = screen.getByRole('textbox');

    fireEvent.keyDown(input, { key: 'Escape', isComposing: true });

    expect(onStop).not.toHaveBeenCalled();
  });

  it('组合结束后 Enter 恢复发送（修复未误伤正常路径）', async () => {
    render(<ChatInput status="ready" onSend={onSend} onStop={onStop} />);
    const input = screen.getByRole('textbox');

    fireEvent.change(input, { target: { value: '你好' } });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: false });

    // 发送管线含异步（附件拼接/超长校验），等待其落地
    await waitFor(() => expect(onSend).toHaveBeenCalledWith('你好'));
  });
});
