// src/renderer/components/$1/ask-dialog.test.tsx
// AskDialog（Agent 提问对话框）渲染与交互测试
//
// 此前该组件无任何覆盖（codegraph 核查），补齐：
// 1. 空态不渲染 / 提问渲染结构（标题/问题/选项/自由输入/底部按钮）
// 2. 单选语义：点击第二个选项仅保留最后一个
// 3. 多选语义：multiSelect 累积 + 再次点击取消
// 4. 提交 payload：selectedIndexes / text 条件字段
// 5. 取消 = 空回答回传 + 清空 store
// 6. 进度条：单问题不渲染，多问题渲染（aria-valuemax）
// 7. 异常路径：respondAsk 拒绝 / 返回 error → toast + 清空

import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useActiveSessionStore } from '@/stores/persistent/sessions-store';
import { useAgentAskStore } from '@/stores/transient/agent-ask-store';
import { AskDialog } from './ask-dialog';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

/** 最小 AgentQuestion 构造 */
function mkQuestion(overrides: Record<string, unknown> = {}) {
  return {
    question: '选择后续方向？',
    options: [
      { label: '方案 A', description: '保守' },
      { label: '方案 B', description: '激进' },
    ],
    ...overrides,
  } as never;
}

/** 当前激活会话 id（队列 selector 按激活会话取队头） */
const ACTIVE_SESSION = 'session-1';

/** 入队一条提问（队列形态：asks[] 按到达顺序 FIFO） */
function setAsk(
  askId: string,
  questions: ReturnType<typeof mkQuestion>[],
  sessionId = ACTIVE_SESSION,
) {
  useAgentAskStore.setState({
    asks: [{ askId, questions: questions as never, sessionId, receivedAt: Date.now() }],
  });
}

/** 当前队头 askId（null = 该会话无待答提问） */
function headAskId(): string | null {
  return (
    useAgentAskStore.getState().asks.find((a) => a.sessionId === ACTIVE_SESSION)?.askId ?? null
  );
}

/** 注入 window.api.agent.respondAsk 并返回 mock（合法 IpcResponse 成功体） */
function injectRespondAsk() {
  const respondAsk = vi.fn(async (_p: unknown) => ({ data: { ok: true } }));
  (window.api as unknown as Record<string, Record<string, unknown>>)['agent'] = { respondAsk };
  return respondAsk;
}

describe('AskDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAgentAskStore.setState({ asks: [] });
    // 会话归属：队列 selector 按「当前激活会话」取队头——运行时提问总发生
    // 在已激活会话中，测试需对齐该前提
    useActiveSessionStore.setState({ activeSessionId: ACTIVE_SESSION });
  });

  it('无提问时不渲染', () => {
    const { container } = render(<AskDialog />);
    expect(container).toBeEmptyDOMElement();
  });

  it('提问到达：渲染标题/问题/选项/自由输入/提交取消按钮', () => {
    setAsk('ask-1', [mkQuestion()]);
    render(<AskDialog />);
    // Radix 迁移后 sr-only DialogTitle 与可见头部并存：用 getAllByText 断言
    expect(screen.getAllByText('Agent 提问').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('选择后续方向？')).toBeInTheDocument();
    expect(screen.getByText('方案 A')).toBeInTheDocument();
    expect(screen.getByText('方案 B')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('第 1 问的自由回答（可选）…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '提交' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '取消' })).toBeInTheDocument();
  });

  it('单选语义：点击第二个选项后仅保留最后一个选中', async () => {
    const user = userEvent.setup();
    setAsk('ask-1', [mkQuestion()]);
    render(<AskDialog />);
    await user.click(screen.getByText('方案 A'));
    await user.click(screen.getByText('方案 B'));
    expect(screen.getByText('方案 A').closest('button')?.className).not.toContain('bg-primary/10');
    expect(screen.getByText('方案 B').closest('button')?.className).toContain('bg-primary/10');
  });

  it('多选语义：multiSelect 累积选中，再次点击取消', async () => {
    const user = userEvent.setup();
    setAsk('ask-1', [mkQuestion({ multiSelect: true })]);
    render(<AskDialog />);
    await user.click(screen.getByText('方案 A'));
    await user.click(screen.getByText('方案 B'));
    expect(screen.getByText('方案 A').closest('button')?.className).toContain('bg-primary/10');
    expect(screen.getByText('方案 B').closest('button')?.className).toContain('bg-primary/10');
    await user.click(screen.getByText('方案 A'));
    expect(screen.getByText('方案 A').closest('button')?.className).not.toContain('bg-primary/10');
  });

  it('提交：回传 selectedIndexes + text（条件字段），并清空 store', async () => {
    const user = userEvent.setup();
    const respondAsk = injectRespondAsk();
    setAsk('ask-9', [mkQuestion()]);
    render(<AskDialog />);
    await user.click(screen.getByText('方案 B'));
    await user.type(screen.getByPlaceholderText('第 1 问的自由回答（可选）…'), '补充说明');
    await user.click(screen.getByRole('button', { name: '提交' }));
    expect(respondAsk).toHaveBeenCalledTimes(1);
    expect(respondAsk.mock.calls[0]?.[0]).toEqual({
      askId: 'ask-9',
      answers: [{ selectedIndexes: [1], text: '补充说明' }],
    });
    expect(headAskId()).toBeNull();
  });

  it('未作答直接提交：answers 为无字段对象（LLM 按未选择继续）', async () => {
    const user = userEvent.setup();
    const respondAsk = injectRespondAsk();
    setAsk('ask-9', [mkQuestion()]);
    render(<AskDialog />);
    await user.click(screen.getByRole('button', { name: '提交' }));
    expect(respondAsk.mock.calls[0]?.[0]).toEqual({ askId: 'ask-9', answers: [{}] });
  });

  it('取消：空回答回传 + 清空 store', async () => {
    const user = userEvent.setup();
    const respondAsk = injectRespondAsk();
    setAsk('ask-9', [mkQuestion()]);
    render(<AskDialog />);
    await user.click(screen.getByRole('button', { name: '取消' }));
    expect(respondAsk).toHaveBeenCalledTimes(1);
    expect(headAskId()).toBeNull();
  });

  it('进度条：单问题不渲染，多问题渲染且 aria-valuemax 对齐问题数', () => {
    setAsk('ask-1', [mkQuestion()]);
    const single = render(<AskDialog />);
    expect(single.queryByRole('progressbar')).toBeNull();
    single.unmount();

    setAsk('ask-2', [mkQuestion(), mkQuestion({ question: '第二问？' })]);
    render(<AskDialog />);
    const bar = screen.getByRole('progressbar');
    expect(bar.getAttribute('aria-valuemax')).toBe('2');
  });

  it('进度条边界：全部答完时 aria-valuenow 不越界（≤ valuemax）', async () => {
    // 回归锚：调用方按「已答题数 + 1」算进度，两问全答会算到 3 > max=2。
    // ARIA 要求 valuenow ≤ valuemax，组件内钳制后不再越界。
    const user = userEvent.setup();
    setAsk('ask-2', [mkQuestion(), mkQuestion({ question: '第二问？' })]);
    render(<AskDialog />);
    // 两问各选一个选项 → 全部作答
    await user.click(screen.getAllByText('方案 A')[0] as HTMLElement);
    await user.click(screen.getAllByText('方案 A')[1] as HTMLElement);

    const bar = screen.getByRole('progressbar');
    const now = Number(bar.getAttribute('aria-valuenow'));
    const max = Number(bar.getAttribute('aria-valuemax'));
    expect(now).toBeLessThanOrEqual(max);
    expect(now).toBe(2);
  });

  it('respondAsk 返回 error：本地化 toast + 保留现场可重试', async () => {
    const user = userEvent.setup();
    const respondAsk = vi.fn(async (_p: unknown) => ({
      error: { code: 'INVALID_INPUT', message: '答案格式不合法' },
    }));
    (window.api as unknown as Record<string, Record<string, unknown>>)['agent'] = { respondAsk };
    setAsk('ask-9', [mkQuestion()]);
    render(<AskDialog />);
    await user.click(screen.getByRole('button', { name: '提交' }));
    const { toast } = await import('sonner');
    // [CODE] 前缀错误 → 错误码经 errors namespace 本地化（zh-CN：输入参数有误）
    expect(toast.error).toHaveBeenCalledWith('输入参数有误');
    // 失败不 clearAsk：选项保留，用户可原地重试（此前强制关窗丢答案）
    expect(headAskId()).toBe('ask-9');
  });

  it('respondAsk 拒绝：无 [CODE] 前缀原始消息透传 toast + 保留现场', async () => {
    const user = userEvent.setup();
    const respondAsk = vi.fn(async (_p: unknown) => {
      throw new Error('ipc down');
    });
    (window.api as unknown as Record<string, Record<string, unknown>>)['agent'] = { respondAsk };
    setAsk('ask-9', [mkQuestion()]);
    render(<AskDialog />);
    await user.click(screen.getByRole('button', { name: '提交' }));
    const { toast } = await import('sonner');
    // 非 IPC 错误响应（无 [CODE] 前缀）→ unwrapErrorMessage 原样透传（全仓统一行为）
    expect(toast.error).toHaveBeenCalledWith('ipc down');
    expect(headAskId()).toBe('ask-9');
  });

  it('取消：回传空回答且清空 store（与提交失败区分）', async () => {
    const user = userEvent.setup();
    const respondAsk = injectRespondAsk();
    setAsk('ask-9', [mkQuestion()]);
    render(<AskDialog />);
    await user.click(screen.getByRole('button', { name: '取消' }));
    expect(respondAsk).toHaveBeenCalledWith({ askId: 'ask-9', answers: [] });
    expect(headAskId()).toBeNull();
  });

  // ── 队列化（2026-10-08）：一轮多 ask 工具并发到达，FIFO 逐条呈现 ──

  it('队列：两条待答 → 只渲染队头；队头出队后下一条自动上浮', async () => {
    const user = userEvent.setup();
    injectRespondAsk();
    // 模拟并发到达：两条同会话提问同时入队（AI SDK Promise.all 并行执行工具）
    useAgentAskStore.setState({
      asks: [
        {
          askId: 'ask-1',
          questions: [mkQuestion({ question: '第一问？' })] as never,
          sessionId: ACTIVE_SESSION,
          receivedAt: Date.now(),
        },
        {
          askId: 'ask-2',
          questions: [mkQuestion({ question: '第二问？' })] as never,
          sessionId: ACTIVE_SESSION,
          receivedAt: Date.now(),
        },
      ],
    });
    render(<AskDialog />);

    // 队头（先问先答）：只显示第一问
    expect(screen.getByText('第一问？')).toBeInTheDocument();
    expect(screen.queryByText('第二问？')).not.toBeInTheDocument();

    // 提交队头 → 出队 → 第二问自动上浮
    await user.click(screen.getByRole('button', { name: '提交' }));
    expect(screen.getByText('第二问？')).toBeInTheDocument();
    expect(screen.queryByText('第一问？')).not.toBeInTheDocument();
    expect(headAskId()).toBe('ask-2');
  });

  it('队列：超时的队头被决议事件放行（不阻塞后续提问）', () => {
    // 主进程 60s 超时 → agent:event:ask:resolved(timed-out) → bridge 调 removeAsk。
    // 此处直接断言 store 语义（bridge 订阅链路由 use-agent-ask-bridge 覆盖）
    useAgentAskStore.setState({
      asks: [
        {
          askId: 'ask-timeout',
          questions: [mkQuestion()] as never,
          sessionId: ACTIVE_SESSION,
          receivedAt: Date.now(),
        },
        {
          askId: 'ask-next',
          questions: [mkQuestion({ question: '第二问？' })] as never,
          sessionId: ACTIVE_SESSION,
          receivedAt: Date.now(),
        },
      ],
    });
    render(<AskDialog />);
    expect(screen.queryByText('第二问？')).not.toBeInTheDocument();

    // 决议事件到达（removeAsk 幂等；用户未曾操作）
    // act 包裹：zustand 外部更新须让 React 同步渲染后才可断言
    act(() => {
      useAgentAskStore.getState().removeAsk('ask-timeout');
    });

    expect(screen.getByText('第二问？')).toBeInTheDocument();
  });

  it('队列：只呈现当前激活会话的提问（跨会话不串扰）', () => {
    useAgentAskStore.setState({
      asks: [
        {
          askId: 'ask-other',
          questions: [mkQuestion({ question: '别的会话？' })] as never,
          sessionId: 'session-2',
          receivedAt: Date.now(),
        },
      ],
    });
    const { container } = render(<AskDialog />);
    expect(container).toBeEmptyDOMElement();
  });

  it('队列：本会话清理不影响其他会话的提问', () => {
    useAgentAskStore.setState({
      asks: [
        {
          askId: 'ask-a',
          questions: [mkQuestion()] as never,
          sessionId: ACTIVE_SESSION,
          receivedAt: Date.now(),
        },
        {
          askId: 'ask-b',
          questions: [mkQuestion()] as never,
          sessionId: 'session-2',
          receivedAt: Date.now(),
        },
      ],
    });
    useAgentAskStore.getState().clearAsk(ACTIVE_SESSION);
    const ids = useAgentAskStore.getState().asks.map((a) => a.askId);
    expect(ids).toEqual(['ask-b']);
  });
});
