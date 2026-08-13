// src/renderer/components/chat/__tests__/goal-bar.test.tsx
// 会话目标栏（ChatPanel 内联）：goal 命令创建 → 输入框上方显示 → 三按钮操作
//
// 测试要点：
// 1. 无目标不显示目标栏；有目标显示 GOAL 标签 + 条件 + 暂停/恢复 · 编辑 · 删除
// 2. 暂停/恢复本地切换；编辑打开 GoalEditDialog 预填条件；删除调 goal:clear
// 3. /goal 前缀发送：只创建目标不进对话；普通消息正常发送；裸 /goal 引导 toast

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ThemeProvider } from '@/providers/ThemeProvider';

import { ChatPanel } from '../ChatPanel';

// useAgentWithIpc 外壳：目标栏测试只关心目标状态，不关心 agent 流式链路
const { sendMessageMock } = vi.hoisted(() => ({ sendMessageMock: vi.fn() }));
vi.mock('@/hooks/use-agent', () => ({
  useAgentWithIpc: () => ({
    messages: [],
    sendMessage: sendMessageMock,
    status: 'ready',
    stop: vi.fn(),
    regenerate: vi.fn(),
    setMessages: vi.fn(),
  }),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

describe('会话目标栏（ChatPanel 内联）', () => {
  const goalCreateMock = vi.fn().mockResolvedValue({ data: { ok: true } });
  const goalClearMock = vi.fn().mockResolvedValue({ data: { ok: true } });
  const goalListMock = vi.fn().mockResolvedValue({ data: { goals: [] } });
  let queryClient: QueryClient;

  beforeEach(() => {
    vi.clearAllMocks();
    goalCreateMock.mockResolvedValue({ data: { ok: true } });
    goalClearMock.mockResolvedValue({ data: { ok: true } });
    goalListMock.mockResolvedValue({ data: { goals: [] } });
    // window.api 空骨架（setup.ts afterEach 重建），注入 goal/models 域
    window.api.goal = {
      create: goalCreateMock,
      list: goalListMock,
      clear: goalClearMock,
    } as never;
    window.api.models = {
      list: vi.fn().mockResolvedValue({ data: { models: [] } }),
    } as never;
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
  });

  function renderPanel(goals: Array<{ condition: string }> = []): void {
    goalListMock.mockResolvedValue({ data: { goals } });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <ThemeProvider>
            <ChatPanel chatId="chat-1" workingDir="D:\\proj" />
          </ThemeProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  it('无目标：不显示目标栏', () => {
    renderPanel();
    expect(screen.queryByText('GOAL')).toBeNull();
  });

  it('有目标：显示 GOAL 标签 + 条件 + 暂停/编辑/删除三按钮', async () => {
    renderPanel([{ condition: '修复登录页 500 错误' }]);
    expect(await screen.findByText('GOAL')).toBeInTheDocument();
    expect(screen.getByText('修复登录页 500 错误')).toBeInTheDocument();
    expect(screen.getByLabelText('暂停目标')).toBeInTheDocument();
    expect(screen.getByLabelText('编辑目标')).toBeInTheDocument();
    expect(screen.getByLabelText('删除目标')).toBeInTheDocument();
  });

  it('暂停/恢复切换：按钮互转', async () => {
    const user = userEvent.setup();
    renderPanel([{ condition: '目标A' }]);
    await user.click(await screen.findByLabelText('暂停目标'));
    expect(screen.getByLabelText('恢复目标')).toBeInTheDocument();
    expect(screen.queryByLabelText('暂停目标')).toBeNull();
    await user.click(screen.getByLabelText('恢复目标'));
    expect(screen.getByLabelText('暂停目标')).toBeInTheDocument();
  });

  it('编辑按钮：打开对话框并预填条件；保存调 goal:create', async () => {
    const user = userEvent.setup();
    renderPanel([{ condition: '目标A' }]);
    await user.click(await screen.findByLabelText('编辑目标'));
    const textarea = await screen.findByLabelText('目标完成条件');
    expect(textarea).toHaveValue('目标A');
    await user.clear(textarea);
    await user.type(textarea, '新目标');
    await user.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => {
      expect(goalCreateMock).toHaveBeenCalledWith({
        sessionId: 'chat-1',
        condition: '新目标',
      });
    });
  });

  it('删除按钮：调 goal:clear', async () => {
    const user = userEvent.setup();
    renderPanel([{ condition: '目标A' }]);
    await user.click(await screen.findByLabelText('删除目标'));
    await waitFor(() => {
      expect(goalClearMock).toHaveBeenCalledWith({ sessionId: 'chat-1' });
    });
  });

  it('/goal 需求 发送：创建目标且不进对话', async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.type(screen.getByRole('textbox'), '/goal 完成用户中心');
    await user.keyboard('{Enter}');
    await waitFor(() => {
      expect(goalCreateMock).toHaveBeenCalledWith({
        sessionId: 'chat-1',
        condition: '完成用户中心',
      });
    });
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('普通消息发送：仅 sendMessage，不创建目标', async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.type(screen.getByRole('textbox'), '你好');
    await user.keyboard('{Enter}');
    await waitFor(() => {
      expect(sendMessageMock).toHaveBeenCalledWith({ text: '你好' });
    });
    expect(goalCreateMock).not.toHaveBeenCalled();
  });

  it('裸 /goal 发送：打开编辑对话框，不创建不发送', async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.type(screen.getByRole('textbox'), '/goal');
    await user.keyboard('{Enter}');
    // 打开目标编辑对话框（无目标 → “设置会话目标”标题）
    expect(await screen.findByText('设置会话目标')).toBeInTheDocument();
    expect(goalCreateMock).not.toHaveBeenCalled();
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('点击 /goal 斜杠建议项：打开编辑对话框', async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.type(screen.getByRole('textbox'), '/g');
    await user.click(await screen.findByText('/goal'));
    expect(await screen.findByText('设置会话目标')).toBeInTheDocument();
    expect(goalCreateMock).not.toHaveBeenCalled();
    expect(sendMessageMock).not.toHaveBeenCalled();
  });
});
