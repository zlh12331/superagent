// src/renderer/components/agent/__tests__/ask-dialog.test.tsx
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

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useAgentAskStore } from '@/stores/transient/agent-ask-store';
import { AskDialog } from '../ask-dialog';

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

function setAsk(askId: string, questions: ReturnType<typeof mkQuestion>[]) {
  useAgentAskStore.setState({ askId, questions: questions as never });
}

/** 注入 window.api.agent.respondAsk 并返回 mock */
function injectRespondAsk() {
  const respondAsk = vi.fn(async (_p: unknown) => ({}));
  (window.api as unknown as Record<string, Record<string, unknown>>)['agent'] = { respondAsk };
  return respondAsk;
}

describe('AskDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAgentAskStore.setState({ askId: null, questions: [] });
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
    expect(screen.getByPlaceholderText('自由回答（可选）…')).toBeInTheDocument();
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
    await user.type(screen.getByPlaceholderText('自由回答（可选）…'), '补充说明');
    await user.click(screen.getByRole('button', { name: '提交' }));
    expect(respondAsk).toHaveBeenCalledTimes(1);
    expect(respondAsk.mock.calls[0]?.[0]).toEqual({
      askId: 'ask-9',
      answers: [{ selectedIndexes: [1], text: '补充说明' }],
    });
    expect(useAgentAskStore.getState().askId).toBeNull();
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
    expect(useAgentAskStore.getState().askId).toBeNull();
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

  it('respondAsk 返回 error：错误码本地化 toast（对齐 unwrapErrorMessage 统一模式）+ 仍清空 store', async () => {
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
    expect(useAgentAskStore.getState().askId).toBeNull();
  });

  it('respondAsk 拒绝：无 [CODE] 前缀原始消息透传 toast + 仍清空 store', async () => {
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
    expect(useAgentAskStore.getState().askId).toBeNull();
  });
});
