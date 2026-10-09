// turn-error-notice.test.tsx
// 回合错误提示卡单测：具体错误渲染 / 关闭 / 重试 / 复制 / 未注册码回退 / 会话隔离
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useTurnErrorStore } from '@/stores/transient/turn-error-store';

import { TurnErrorNotice } from './turn-error-notice';

const writeText = vi.fn(() => Promise.resolve());
Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

describe('TurnErrorNotice', () => {
  beforeEach(() => {
    useTurnErrorStore.setState({ errors: {} });
    writeText.mockClear();
  });

  it('无错误：不渲染', () => {
    const { container } = render(<TurnErrorNotice sessionId="s1" />);
    expect(container.firstChild).toBeNull();
  });

  it('渲染具体错误：错误码本地化标题 + 消息原文 + API Key 族定向提示', () => {
    useTurnErrorStore.getState().set('s1', 'AI_API_KEY_INVALID', '无效的 API Key');
    render(<TurnErrorNotice sessionId="s1" />);
    expect(screen.getByRole('alert')).toBeDefined();
    // 标题来自 errors.json 本地化（zh 默认），而非泛化文案
    expect(screen.getByText('API Key 无效')).toBeDefined();
    // 详情为主进程消息原文逐字展示
    expect(screen.getByText('无效的 API Key')).toBeDefined();
    // API Key 族给定向提示（本地网关案例）
    expect(screen.getByText(/本地网关模型需使用网关自身签发/)).toBeDefined();
  });

  it('通用错误族：给通用提示（非 API Key 定向）', () => {
    useTurnErrorStore.getState().set('s1', 'AI_TIMEOUT', '请求超时');
    render(<TurnErrorNotice sessionId="s1" />);
    expect(screen.getByText(/设置 → 诊断/)).toBeDefined();
  });

  it('未注册错误码：回退通用标题，仍显示原文', () => {
    useTurnErrorStore.getState().set('s1', 'WEIRD_CODE', '远端拒绝');
    render(<TurnErrorNotice sessionId="s1" />);
    expect(screen.getByText('对话出错')).toBeDefined();
    expect(screen.getByText('远端拒绝')).toBeDefined();
  });

  it('空消息：详情显示占位文案', () => {
    useTurnErrorStore.getState().set('s1', 'AI_TIMEOUT', '   ');
    render(<TurnErrorNotice sessionId="s1" />);
    expect(screen.getByText('（无更多详情）')).toBeDefined();
  });

  it('会话隔离：其他会话的错误不渲染', () => {
    useTurnErrorStore.getState().set('s2', 'AI_TIMEOUT', 'x');
    const { container } = render(<TurnErrorNotice sessionId="s1" />);
    expect(container.firstChild).toBeNull();
  });

  it('关闭：点击 × → store 清除 → 组件消失', () => {
    useTurnErrorStore.getState().set('s1', 'AI_TIMEOUT', 'x');
    render(<TurnErrorNotice sessionId="s1" />);
    fireEvent.click(screen.getByRole('button', { name: '关闭' }));
    expect(useTurnErrorStore.getState().errors['s1']).toBeUndefined();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('重试：先清卡再回调 onRetry', () => {
    const onRetry = vi.fn();
    useTurnErrorStore.getState().set('s1', 'AI_TIMEOUT', 'x');
    render(<TurnErrorNotice sessionId="s1" onRetry={onRetry} />);
    fireEvent.click(screen.getByRole('button', { name: /重试/ }));
    expect(onRetry).toHaveBeenCalledOnce();
    expect(useTurnErrorStore.getState().errors['s1']).toBeUndefined();
  });

  it('无 onRetry：不渲染重试按钮', () => {
    useTurnErrorStore.getState().set('s1', 'AI_TIMEOUT', 'x');
    render(<TurnErrorNotice sessionId="s1" />);
    expect(screen.queryByRole('button', { name: /重试/ })).toBeNull();
  });

  it('复制详情：写入 [code] message', () => {
    useTurnErrorStore.getState().set('s1', 'AI_TIMEOUT', '原文');
    render(<TurnErrorNotice sessionId="s1" />);
    fireEvent.click(screen.getByRole('button', { name: /复制详情/ }));
    expect(writeText).toHaveBeenCalledWith('[AI_TIMEOUT] 原文');
  });
});
