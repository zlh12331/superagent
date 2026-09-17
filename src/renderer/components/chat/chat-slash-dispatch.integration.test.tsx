// chat-slash-dispatch.integration.test.tsx
// ChatPanel 斜杠命令分发集成测试（全链）：
// 用户输入 → ChatInput 建议面板 → executeSlashCommand → ChatPanel 动作回调 → IPC / store / AI SDK
// ──────────────────────────────────────────────────────────────
// 隔离面：仅 mock AI SDK 编排层（useAgentWithIpc）与 react-router 导航；
// ChatPanel / ChatInput / 建议面板 / executeSlashCommand / ui-store / IPC mock 全部真实。
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useUiStore } from '@/stores/transient/ui-store';

import { ChatPanel } from './ChatPanel';

const stopSpy = vi.fn();
const setMessagesSpy = vi.fn();
const sendMessageSpy = vi.fn();
const navigateSpy = vi.fn();

vi.mock('@/hooks/use-agent', () => ({
  useAgentWithIpc: vi.fn(() => ({
    messages: [],
    sendMessage: sendMessageSpy,
    status: 'ready',
    stop: stopSpy,
    regenerate: vi.fn(),
    setMessages: setMessagesSpy,
  })),
}));

vi.mock('react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router')>();
  return { ...actual, useNavigate: () => navigateSpy };
});

/** window.api 最小挂载（goal 挂载查询 + compact；agent 层已被 use-agent mock 隔离） */
function mountApi(): ReturnType<typeof vi.fn> {
  const w = window as unknown as {
    api?: {
      goal?: {
        list: ReturnType<typeof vi.fn>;
        create: ReturnType<typeof vi.fn>;
        clear: ReturnType<typeof vi.fn>;
      };
      session?: { compact: ReturnType<typeof vi.fn> };
    };
  };
  const api = {
    goal: {
      list: vi.fn().mockResolvedValue({ data: { goals: [] } }),
      create: vi.fn(),
      clear: vi.fn(),
    },
    session: { compact: vi.fn() },
  };
  w.api = api;
  return api.session.compact;
}

/** 渲染 ChatPanel 并返回输入框（斜杠命令经输入 + Enter 应用建议触发；useQuery 需 QueryClientProvider） */
function renderPanel(): HTMLTextAreaElement {
  const qc = new QueryClient();
  render(
    <QueryClientProvider client={qc}>
      <ChatPanel chatId="s1" workingDir="/p" />
    </QueryClientProvider>,
  );
  return screen.getByRole('textbox') as HTMLTextAreaElement;
}

/** 输入斜杠命令并回车应用唯一建议项 */
async function typeSlashCommand(input: HTMLTextAreaElement, command: string): Promise<void> {
  const user = userEvent.setup({ delay: null });
  await user.type(input, `${command}{enter}`);
}

describe('ChatPanel 斜杠命令分发（集成）', () => {
  let compact: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.clearAllMocks();
    useUiStore.setState({ shortcutHelpOpen: false, settingsOpen: false, paletteOpen: false });
    compact = mountApi();
  });

  it('正向 /compact：全链分发 → session:compact IPC 调用', async () => {
    const input = renderPanel();
    await typeSlashCommand(input, '/compact');
    await waitFor(() => {
      expect(compact).toHaveBeenCalledWith({ sessionId: 's1' });
    });
  });

  it('正向 /interrupt：分发 → stop 调用（AI SDK 中断）', async () => {
    const input = renderPanel();
    await typeSlashCommand(input, '/interrupt');
    expect(stopSpy).toHaveBeenCalledTimes(1);
  });

  it('正向 /clear：分发 → setMessages([])（清空本地消息态）', async () => {
    const input = renderPanel();
    await typeSlashCommand(input, '/clear');
    expect(setMessagesSpy).toHaveBeenCalledWith([]);
  });

  it('正向 /new：分发 → 导航回欢迎页（/）', async () => {
    const input = renderPanel();
    await typeSlashCommand(input, '/new');
    expect(navigateSpy).toHaveBeenCalledWith('/');
  });

  it('正向 /help：分发 → ui-store 打开快捷键帮助（单实例挂载约定）', async () => {
    const input = renderPanel();
    await typeSlashCommand(input, '/help');
    expect(useUiStore.getState().shortcutHelpOpen).toBe(true);
  });

  it('正向 /demo：走消息通道触发 mock 流（不经 onSlashCommand 分支）', async () => {
    const input = renderPanel();
    await typeSlashCommand(input, '/demo');
    expect(sendMessageSpy).toHaveBeenCalledWith({ text: '/demo' });
  });

  it('边界：普通文本 Enter 走 sendMessage，不触发任何斜杠动作', async () => {
    const input = renderPanel();
    const user = userEvent.setup({ delay: null });
    await user.type(input, '普通问题{enter}');
    expect(sendMessageSpy).toHaveBeenCalledWith({ text: '普通问题' });
    expect(compact).not.toHaveBeenCalled();
    expect(stopSpy).not.toHaveBeenCalled();
  });

  it('边界：输入 /zzz（无匹配命令）→ 建议面板关闭，Enter 不分发任何动作', async () => {
    const input = renderPanel();
    const user = userEvent.setup({ delay: null });
    await user.type(input, '/zzz');
    expect(screen.queryByRole('listbox')).toBeNull();
    await user.type(input, '{enter}');
    expect(compact).not.toHaveBeenCalled();
    expect(stopSpy).not.toHaveBeenCalled();
    expect(navigateSpy).not.toHaveBeenCalled();
    // 普通消息通道兜底（非空文本发送）
    expect(sendMessageSpy).toHaveBeenCalledWith({ text: '/zzz' });
  });

  it('边界：斜杠命令执行后输入框清空（建议应用路径）', async () => {
    const input = renderPanel();
    await typeSlashCommand(input, '/compact');
    expect(input).toHaveValue('');
  });
});
