// src/renderer/components/$1/ChatInput.test.tsx
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

import { useDraftStore } from '@/stores/persistent/draft-store';
import { ChatInput } from './ChatInput';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

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

// ── 组件交互深覆盖（原 chat-gaps.test 的 ChatInput 段并入） ──────
// 草稿恢复/保存/清除、斜杠建议应用、@提及、附件、受控/注入、超长拦截、拖拽手柄
describe('ChatInput 组件交互', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useDraftStore.setState({ drafts: {} });
  });

  function renderInput(props: Partial<Parameters<typeof ChatInput>[0]> = {}) {
    return render(
      <ChatInput
        status="ready"
        onSend={vi.fn()}
        onStop={vi.fn()}
        placeholder="输入消息..."
        {...props}
      />,
    );
  }

  it('ready 状态：显示发送按钮；输入文本后可用', async () => {
    const user = userEvent.setup();
    renderInput();
    const sendBtn = screen.getByLabelText('发送消息');
    expect(sendBtn).toBeDisabled();
    await user.type(screen.getByRole('textbox'), '你好');
    expect(sendBtn).toBeEnabled();
  });

  it('streaming/submitted 状态：显示停止按钮', () => {
    renderInput({ status: 'streaming' });
    expect(screen.getByLabelText('停止生成')).toBeDefined();
    expect(screen.queryByLabelText('发送')).toBeNull();
  });

  it('Enter 发送：onSend 回调 + 清空输入', async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    renderInput({ onSend });
    const input = screen.getByRole('textbox');
    await user.type(input, 'hello');
    await user.keyboard('{Enter}');
    expect(onSend).toHaveBeenCalledWith('hello');
    expect((input as HTMLTextAreaElement).value).toBe('');
  });

  it('Shift+Enter：换行不发送', async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    renderInput({ onSend });
    const input = screen.getByRole('textbox');
    await user.type(input, 'hello');
    await user.keyboard('{Shift>}{Enter}{/Shift}');
    expect(onSend).not.toHaveBeenCalled();
  });

  it('流式状态 Esc：触发 onStop（window 级监听）', () => {
    const onStop = vi.fn();
    renderInput({ status: 'streaming', onStop });
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onStop).toHaveBeenCalled();
  });

  it('流式状态 textarea 内 Esc：触发 onStop', async () => {
    const user = userEvent.setup();
    const onStop = vi.fn();
    renderInput({ status: 'streaming', onStop });
    await user.type(screen.getByRole('textbox'), '{Escape}');
    expect(onStop).toHaveBeenCalled();
  });

  it('disabled：输入框与发送按钮均禁用', () => {
    renderInput({ disabled: true });
    expect(screen.getByRole('textbox')).toBeDisabled();
    expect(screen.getByLabelText('发送消息')).toBeDisabled();
  });

  it('草稿恢复：chatId + 预置草稿 → 初始值', () => {
    useDraftStore.getState().setDraft('chat-a', { text: '草稿内容', attachments: [] });
    renderInput({ chatId: 'chat-a' });
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('草稿内容');
  });

  it('草稿保存：输入后写入 draft-store', () => {
    renderInput({ chatId: 'chat-b' });
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '保存我' } });
    expect(useDraftStore.getState().getDraft('chat-b').text).toBe('保存我');
  });

  it('发送后清除草稿', async () => {
    useDraftStore.getState().setDraft('chat-c', { text: '旧草稿', attachments: [] });
    renderInput({ chatId: 'chat-c' });
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '新内容' } });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    await waitFor(() => {
      expect(useDraftStore.getState().getDraft('chat-c')).toEqual({ text: '', attachments: [] });
    });
  });

  it('斜杠建议：输入 / 显示面板，点击带 action 命令触发 onSlashCommand 并清空', () => {
    const onSlashCommand = vi.fn();
    renderInput({ onSlashCommand });
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '/new' } });
    expect(screen.getByRole('listbox')).toBeDefined();
    fireEvent.click(screen.getByRole('option', { name: /new/i }));
    expect(onSlashCommand).toHaveBeenCalledWith('new');
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('');
  });

  it('斜杠建议 Tab 应用：首个建议执行 action（内置命令全带 action）', () => {
    const onSlashCommand = vi.fn();
    renderInput({ onSlashCommand });
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '/h' } });
    expect(screen.getByRole('listbox')).toBeDefined();
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Tab' });
    expect(onSlashCommand).toHaveBeenCalledWith('help');
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('');
  });

  it('@提及：输入 @ 触发 glob 防抖查询，点击建议应用路径', async () => {
    (window.api as unknown as Record<string, unknown>)['search'] = {
      glob: vi.fn(async () => ({ data: { files: ['/proj/src/main.ts'], truncated: false } })),
    };
    renderInput({ workingDir: '/proj' });
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '@ma' } });
    const option = await screen.findByRole('option', { name: /main\.ts/ });
    fireEvent.click(option);
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toContain(
      '@/proj/src/main.ts',
    );
  });

  it('附件：pickFiles 后显示 chip，移除后消失', async () => {
    (window.api as unknown as Record<string, unknown>)['dialog'] = {
      pickFiles: vi.fn(async () => ({
        data: { canceled: false, paths: ['/proj/a.txt'] },
      })),
    };
    renderInput({ chatId: 'chat-att' });
    fireEvent.click(screen.getByLabelText('附加文件'));
    expect(await screen.findByText('a.txt')).toBeDefined();
    const chipClose = document.querySelector('.composer-box button.rounded-full');
    if (chipClose !== null) fireEvent.click(chipClose);
    expect(screen.queryByText('a.txt')).toBeNull();
  });

  it('附件发送：读取内容拼接进消息', async () => {
    const onSend = vi.fn();
    (window.api as unknown as Record<string, unknown>)['dialog'] = {
      pickFiles: vi.fn(async () => ({ data: { canceled: false, paths: ['/proj/a.txt'] } })),
    };
    (window.api as unknown as Record<string, unknown>)['file'] = {
      read: vi.fn(async () => ({
        data: { content: '文件内容', totalLines: 1, encoding: 'utf8' },
      })),
    };
    renderInput({ onSend });
    fireEvent.click(screen.getByLabelText('附加文件'));
    await screen.findByText('a.txt');
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '读它' } });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    await waitFor(() => expect(onSend).toHaveBeenCalledWith(expect.stringContaining('文件内容')));
  });

  it('附件读取失败：标注失败不阻断发送', async () => {
    const onSend = vi.fn();
    (window.api as unknown as Record<string, unknown>)['dialog'] = {
      pickFiles: vi.fn(async () => ({ data: { canceled: false, paths: ['/proj/b.bin'] } })),
    };
    (window.api as unknown as Record<string, unknown>)['file'] = {
      read: vi.fn(async () => ({ error: { code: 'FS_READ_FAILED', message: '二进制' } })),
    };
    renderInput({ onSend });
    fireEvent.click(screen.getByLabelText('附加文件'));
    await screen.findByText('b.bin');
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'x' } });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    await waitFor(() =>
      expect(onSend).toHaveBeenCalledWith(expect.stringContaining('内容读取失败')),
    );
  });

  it('超长消息（>8000 字符）：toast.error 拦截不发送', async () => {
    const onSend = vi.fn();
    renderInput({ onSend });
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'x'.repeat(8001) } });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    expect(onSend).not.toHaveBeenCalled();
    const { toast } = await import('sonner');
    expect(toast.error).toHaveBeenCalled();
  });

  it('受控模式：value 受控 + onValueChange 回调', () => {
    const onValueChange = vi.fn();
    const { rerender } = renderInput({ value: '受控值', onValueChange });
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('受控值');
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '受控值追加' } });
    expect(onValueChange).toHaveBeenCalledWith('受控值追加');
    rerender(
      <ChatInput
        status="ready"
        onSend={vi.fn()}
        onStop={vi.fn()}
        value="新值"
        onValueChange={onValueChange}
      />,
    );
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('新值');
  });

  it('injectedValue：非受控模式同步一次内部值', async () => {
    const { rerender } = renderInput({ chatId: 'chat-inj' });
    rerender(
      <ChatInput
        status="ready"
        onSend={vi.fn()}
        onStop={vi.fn()}
        chatId="chat-inj"
        injectedValue="编辑重提"
      />,
    );
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('编辑重提');
  });

  it('拖拽手柄键盘 ArrowUp/Down：调整 textarea 高度', () => {
    renderInput();
    const handle = document.querySelector('.composer-drag-handle');
    expect(handle).not.toBeNull();
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    Object.defineProperty(textarea, 'offsetHeight', { value: 40, configurable: true });
    // 键盘下限 = min(scrollHeight 自然高度, 160)（与拖拽路径对齐）；jsdom 无布局引擎
    // scrollHeight 恒 0，mock 内容自然高度 40 —— ArrowDown 不得缩破内容高度
    Object.defineProperty(textarea, 'scrollHeight', { value: 40, configurable: true });
    textarea.style.height = '40px';
    if (handle !== null) {
      fireEvent.keyDown(handle, { key: 'ArrowUp' });
      expect(textarea.style.height).toBe('60px');
      fireEvent.keyDown(handle, { key: 'ArrowDown' });
      expect(textarea.style.height).toBe('40px');
    }
  });

  it('空输入 Enter：不发送（canSend false）', () => {
    const onSend = vi.fn();
    renderInput({ onSend });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    expect(onSend).not.toHaveBeenCalled();
  });

  it('草稿附件恢复：预置草稿附件 → 渲染 chip', () => {
    useDraftStore.getState().setDraft('chat-att2', {
      text: '',
      attachments: ['/proj/旧文件.txt'],
    });
    renderInput({ chatId: 'chat-att2' });
    expect(screen.getByText('旧文件.txt')).toBeDefined();
  });

  it('会话切换（chatId 变化）：恢复新会话草稿', () => {
    // 独立挂载验证（避免 rerender effect 时序与共享 store 竞态）
    useDraftStore.getState().setDraft('chat-x', { text: '会话X草稿', attachments: [] });
    useDraftStore.getState().setDraft('chat-y', { text: '会话Y草稿', attachments: [] });
    const { unmount } = renderInput({ chatId: 'chat-x' });
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('会话X草稿');
    unmount();
    renderInput({ chatId: 'chat-y' });
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('会话Y草稿');
  });

  it('pickFiles 取消/重复路径：不新增 chip', async () => {
    (window.api as unknown as Record<string, unknown>)['dialog'] = {
      pickFiles: vi.fn(async () => ({
        data: { canceled: false, paths: ['/proj/a.txt', '/proj/a.txt'] },
      })),
    };
    renderInput({ chatId: 'chat-dup' });
    fireEvent.click(screen.getByLabelText('附加文件'));
    await screen.findByText('a.txt');
    // 重复路径去重：仅一个 chip
    expect(screen.getAllByText('a.txt')).toHaveLength(1);
    // 取消选择：不新增
    (window.api as unknown as Record<string, unknown>)['dialog'] = {
      pickFiles: vi.fn(async () => ({ data: { canceled: true, paths: [] } })),
    };
    fireEvent.click(screen.getByLabelText('附加文件'));
    await screen.findByText('a.txt');
    expect(screen.getAllByText('a.txt')).toHaveLength(1);
  });

  it('@提及 glob 失败：静默清空建议（catch 分支）', async () => {
    (window.api as unknown as Record<string, unknown>)['search'] = {
      glob: vi.fn(async () => {
        throw new Error('network down');
      }),
    };
    renderInput({ workingDir: '/proj' });
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '@ma' } });
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
  });

  it('@提及 Tab 应用：首个文件建议填入路径', async () => {
    (window.api as unknown as Record<string, unknown>)['search'] = {
      glob: vi.fn(async () => ({ data: { files: ['/proj/src/main.ts'], truncated: false } })),
    };
    renderInput({ workingDir: '/proj' });
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '@ma' } });
    await screen.findByRole('option', { name: /main\.ts/ });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Tab' });
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toContain(
      '@/proj/src/main.ts',
    );
  });

  it('斜杠按钮点击：填充 / 并打开建议面板', () => {
    renderInput();
    fireEvent.click(screen.getByLabelText('斜杠命令'));
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('/');
    expect(screen.getByRole('listbox')).toBeDefined();
  });

  it('@提及 window.api 未注入：静默清空建议', async () => {
    Object.defineProperty(window, 'api', {
      value: undefined,
      writable: true,
      configurable: true,
    });
    renderInput({ workingDir: '/proj' });
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '@ma' } });
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
  });

  it('附件读取抛异常：标注失败不阻断发送（catch 分支）', async () => {
    const onSend = vi.fn();
    (window.api as unknown as Record<string, unknown>)['dialog'] = {
      pickFiles: vi.fn(async () => ({ data: { canceled: false, paths: ['/proj/c.bin'] } })),
    };
    (window.api as unknown as Record<string, unknown>)['file'] = {
      read: vi.fn(async () => {
        throw new Error('permission denied');
      }),
    };
    renderInput({ onSend });
    fireEvent.click(screen.getByLabelText('附加文件'));
    await screen.findByText('c.bin');
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'x' } });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    await waitFor(() =>
      expect(onSend).toHaveBeenCalledWith(expect.stringContaining('内容读取失败')),
    );
  });

  it('拖拽手柄：pointerdown/move/up 调整高度（向上拖变高）', () => {
    // jsdom 无布局，mock 布局属性
    const originalSetPointerCapture = HTMLElement.prototype.setPointerCapture;
    HTMLElement.prototype.setPointerCapture = vi.fn();
    try {
      renderInput();
      const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
      Object.defineProperty(textarea, 'scrollHeight', { value: 100, configurable: true });
      Object.defineProperty(textarea, 'offsetHeight', { value: 40, configurable: true });
      const handle = document.querySelector('.composer-drag-handle') as HTMLElement;
      fireEvent.pointerDown(handle, { clientY: 200, pointerId: 1 });
      // 向上拖 100px（clientY 200 → 100）：高度 40 → 140
      fireEvent.pointerMove(document, { clientY: 100 });
      expect(textarea.style.height).toBe('140px');
      expect(textarea.style.maxHeight).toBe('140px');
      // 向下拖超下限：钳位到 dragMinH（100）
      fireEvent.pointerMove(document, { clientY: 300 });
      expect(textarea.style.height).toBe('100px');
      // 拖拽结束清理
      fireEvent.pointerUp(document);
    } finally {
      HTMLElement.prototype.setPointerCapture = originalSetPointerCapture;
    }
  });

  it('拖拽手柄双击：重置高度（自动档）', () => {
    renderInput();
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    Object.defineProperty(textarea, 'scrollHeight', { value: 80, configurable: true });
    const handle = document.querySelector('.composer-drag-handle') as HTMLElement;
    if (handle !== null) {
      fireEvent.doubleClick(handle);
      expect(textarea.style.height).toBe('80px');
      expect(textarea.style.maxHeight).toBe('');
    }
  });
});
