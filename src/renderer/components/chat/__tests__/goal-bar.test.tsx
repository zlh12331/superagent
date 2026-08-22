// src/renderer/components/chat/__tests__/goal-bar.test.tsx
// 会话目标栏（ChatPanel 内联）：goal 命令创建 → 输入框上方显示 → 三按钮操作
//
// 测试要点：
// 1. 无目标不显示目标栏；有目标显示 GOAL 标签 + 条件 + 暂停/恢复 · 编辑 · 删除
// 2. 暂停/恢复本地切换；编辑预填 /goal 条件；删除调 goal:clear
// 3. /goal 前缀发送：只创建目标不进对话；普通消息正常发送；裸 /goal 预填引导

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ThemeProvider } from '@/providers/ThemeProvider';
import { useDraftStore } from '@/stores/persistent/draft-store';

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
    // 清草稿：注入预填会写入 draft-store，避免跨测试残留（chatId 相同恢复旧草稿）
    useDraftStore.setState({ drafts: {} });
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

  type GoalEntry = {
    condition: string;
    status: 'active' | 'completed' | 'aborted';
  };

  function renderPanel(goals: GoalEntry[] = []): void {
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

  it('仅 aborted 目标（已清除/被覆盖）：不显示目标栏', async () => {
    renderPanel([{ condition: '旧目标', status: 'aborted' }]);
    // query 异步：等待后确认不显示
    await waitFor(() => {
      expect(screen.queryByText('GOAL')).toBeNull();
    });
  });

  it('completed 目标：显示目标栏 + 已完成徽标，无暂停按钮', async () => {
    renderPanel([{ condition: '已完成的目标', status: 'completed' }]);
    expect(await screen.findByText('GOAL')).toBeInTheDocument();
    expect(screen.getByText('已完成')).toBeInTheDocument();
    expect(screen.queryByLabelText('暂停目标')).toBeNull();
    expect(screen.getByLabelText('编辑目标')).toBeInTheDocument();
    expect(screen.getByLabelText('删除目标')).toBeInTheDocument();
  });

  it('active + aborted 混合：优先展示 active 目标', async () => {
    renderPanel([
      { condition: '旧目标', status: 'aborted' },
      { condition: '当前目标', status: 'active' },
    ]);
    expect(await screen.findByText('GOAL')).toBeInTheDocument();
    expect(screen.getByText('当前目标')).toBeInTheDocument();
    expect(screen.queryByText('旧目标')).toBeNull();
  });

  it('有目标：显示 GOAL 标签 + 条件 + 编辑/删除两按钮（暂停已移除）', async () => {
    renderPanel([{ condition: '修复登录页 500 错误', status: 'active' }]);
    expect(await screen.findByText('GOAL')).toBeInTheDocument();
    expect(screen.getByText('修复登录页 500 错误')).toBeInTheDocument();
    // P2 修复：假「暂停」按钮已移除——goal:pause IPC 未实现，本地翻转纯欺骗
    expect(screen.queryByLabelText('暂停目标')).toBeNull();
    expect(screen.getByLabelText('编辑目标')).toBeInTheDocument();
    expect(screen.getByLabelText('删除目标')).toBeInTheDocument();
  });

  it('active 目标也不渲染暂停按钮（待真实 goal:pause IPC 后恢复入口）', async () => {
    renderPanel([{ condition: '目标A', status: 'active' }]);
    expect(await screen.findByText('GOAL')).toBeInTheDocument();
    expect(screen.queryByLabelText('暂停目标')).toBeNull();
    expect(screen.queryByLabelText('恢复目标')).toBeNull();
  });

  it('编辑按钮：把 /goal 条件填入输入框', async () => {
    const user = userEvent.setup();
    renderPanel([{ condition: '目标A', status: 'active' }]);
    await user.click(await screen.findByLabelText('编辑目标'));
    // 预填 "/goal 目标A" 到输入框（用户修改后回车即覆盖创建）
    await waitFor(() => {
      expect(screen.getByRole('textbox')).toHaveValue('/goal 目标A');
    });
    expect(goalCreateMock).not.toHaveBeenCalled();
  });

  it('删除按钮：调 goal:clear', async () => {
    const user = userEvent.setup();
    renderPanel([{ condition: '目标A', status: 'active' }]);
    await user.click(await screen.findByLabelText('删除目标'));
    await waitFor(() => {
      expect(goalClearMock).toHaveBeenCalledWith({ sessionId: 'chat-1' });
    });
  });

  it('删除后：目标栏消失（clear 后 list 返回 aborted 不再展示）', async () => {
    const user = userEvent.setup();
    renderPanel([{ condition: '目标A', status: 'active' }]);
    // 先更新 mock：clear 后 list 返回 aborted（真实环境后端同步落库，invalidate 拉取新数据）
    goalListMock.mockResolvedValue({
      data: { goals: [{ condition: '目标A', status: 'aborted' }] },
    });
    await user.click(await screen.findByLabelText('删除目标'));
    await waitFor(() => {
      expect(screen.queryByText('GOAL')).toBeNull();
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

  it('裸 /goal 发送：重新填入 /goal 等待补充需求，不创建不发送', async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.type(screen.getByRole('textbox'), '/goal');
    await user.keyboard('{Enter}');
    // 建议面板拦截 Enter → 填入 "/goal "（用户补需求后发送）
    await waitFor(() => {
      expect(screen.getByRole('textbox')).toHaveValue('/goal ');
    });
    expect(goalCreateMock).not.toHaveBeenCalled();
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('点击 /goal 斜杠建议项：填入 /goal 到输入框', async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.type(screen.getByRole('textbox'), '/g');
    await user.click(await screen.findByText('/goal'));
    await waitFor(() => {
      expect(screen.getByRole('textbox')).toHaveValue('/goal ');
    });
    expect(goalCreateMock).not.toHaveBeenCalled();
    expect(sendMessageMock).not.toHaveBeenCalled();
  });
});
