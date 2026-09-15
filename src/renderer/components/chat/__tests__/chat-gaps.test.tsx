// src/renderer/components/chat/__tests__/chat-gaps.test.tsx
// chat 域批次3 缺口补全：message-utils 纯函数 + ChatInput 组件交互
//
// 测试要点：
// 1. message-utils：状态映射四态 / extractText / formatJson（截断/undefined/循环引用）
// 2. ChatInput：发送/停止按钮切换 / Enter·Shift+Enter / Esc 中断 / 禁用 /
//    字符计数 / 草稿恢复·保存·清除 / 斜杠建议 / @提及 / 附件 / 受控 / 注入 / 超长拦截

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n/config';
import { useDraftStore } from '@/stores/persistent/draft-store';
import { ChatInput } from '../ChatInput';
import {
  extractText,
  formatJson,
  mapToolStateToStatusClass,
  mapToolStateToStatusLabelKey,
} from '../message-utils';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

describe('chat 批次3 缺口补全', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useDraftStore.setState({ drafts: {} });
  });

  describe('message-utils 纯函数', () => {
    it('mapToolStateToStatusLabelKey：四态映射', () => {
      expect(mapToolStateToStatusLabelKey('output-error')).toBe('statusError');
      expect(mapToolStateToStatusLabelKey('output-available')).toBe('statusSuccess');
      expect(mapToolStateToStatusLabelKey('input-streaming')).toBe('statusRunning');
      expect(mapToolStateToStatusLabelKey('input-accepted')).toBe('statusRunning');
      expect(mapToolStateToStatusLabelKey('unknown-state')).toBe('statusWaiting');
    });

    it('mapToolStateToStatusClass：四态映射', () => {
      expect(mapToolStateToStatusClass('output-error')).toBe('error');
      expect(mapToolStateToStatusClass('output-available')).toBe('success');
      expect(mapToolStateToStatusClass('input-streaming')).toBe('running');
      expect(mapToolStateToStatusClass('input-accepted')).toBe('running');
      expect(mapToolStateToStatusClass('unknown-state')).toBe('pending');
    });

    it('extractText：提取 text part 并按行拼接，过滤非文本 part', () => {
      const parts = [
        { type: 'text', text: '第一行' },
        { type: 'tool-invocation', toolInvocation: {} },
        { type: 'text', text: '第二行' },
      ] as never;
      expect(extractText(parts)).toBe('第一行\n第二行');
    });

    it('extractText：空数组返回空串', () => {
      expect(extractText([])).toBe('');
    });

    it('formatJson：正常格式化（缩进 + 截断 200 字符）', () => {
      const t = i18n.t.bind(i18n);
      const short = formatJson({ a: 1 }, t);
      expect(short).toBe('{\n  "a": 1\n}');
      const long = formatJson({ data: 'x'.repeat(300) }, t);
      expect(long.startsWith('{\n  "data": "')).toBe(true);
      expect(long.endsWith('(已截断)')).toBe(true);
    });

    it('formatJson：undefined → "undefined" 字符串', () => {
      const result = formatJson(undefined, i18n.t.bind(i18n));
      expect(result).toBe('undefined');
    });

    it('formatJson：循环引用抛错 → String 兜底', () => {
      const circular: Record<string, unknown> = {};
      circular['self'] = circular;
      const result = formatJson(circular, i18n.t.bind(i18n));
      expect(typeof result).toBe('string');
      expect(result).toContain('[object');
    });
  });

  describe('ChatInput 组件交互', () => {
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
});
