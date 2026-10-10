import { renderHook } from '@testing-library/react';
import type { UIMessage } from 'ai';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useSettingsStore } from '@/stores/persistent/settings-store';

import { useAutoCompact } from './use-auto-compact';

function makeMessages(n: number): UIMessage[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `m${i}`,
    role: 'user',
    parts: [{ type: 'text', text: `q${i}` }],
  })) as UIMessage[];
}

function setAutoCompact(enabled: boolean): void {
  useSettingsStore.setState({
    experimental: { ...useSettingsStore.getState().experimental, autoCompact: enabled },
  });
}

describe('useAutoCompact', () => {
  beforeEach(() => {
    setAutoCompact(false);
  });

  it('默认关闭（opt-in）→ 达到阈值也不触发', () => {
    const compact = vi.fn();
    renderHook(() =>
      useAutoCompact({ chatId: 's1', messages: makeMessages(700), status: 'ready', compact }),
    );
    expect(compact).not.toHaveBeenCalled();
  });

  it('开启 + 消息达阈值 + ready → 触发一次 compact', () => {
    setAutoCompact(true);
    const compact = vi.fn();
    renderHook(() =>
      useAutoCompact({
        chatId: 's1',
        messages: makeMessages(700),
        status: 'ready',
        compact,
        threshold: 600,
      }),
    );
    expect(compact).toHaveBeenCalledOnce();
  });

  it('阈值以下不触发', () => {
    setAutoCompact(true);
    const compact = vi.fn();
    renderHook(() =>
      useAutoCompact({
        chatId: 's1',
        messages: makeMessages(599),
        status: 'ready',
        compact,
        threshold: 600,
      }),
    );
    expect(compact).not.toHaveBeenCalled();
  });

  it('流式/提交中不触发（避免与在途回合竞争）', () => {
    setAutoCompact(true);
    const compact = vi.fn();
    for (const status of ['streaming', 'submitted'] as const) {
      const { unmount } = renderHook(() =>
        useAutoCompact({
          chatId: 's1',
          messages: makeMessages(700),
          status,
          compact,
          threshold: 600,
        }),
      );
      unmount();
    }
    expect(compact).not.toHaveBeenCalled();
  });

  it('同一水位只触发一次（失败不风暴）；再增长满一个区间才重试', () => {
    setAutoCompact(true);
    const compact = vi.fn();
    const { rerender } = renderHook(
      ({ length }: { length: number }) =>
        useAutoCompact({
          chatId: 's1',
          messages: makeMessages(length),
          status: 'ready',
          compact,
          threshold: 600,
        }),
      { initialProps: { length: 700 } as never },
    );
    expect(compact).toHaveBeenCalledOnce();

    rerender({ length: 700 });
    expect(compact).toHaveBeenCalledOnce();

    rerender({ length: 1360 });
    expect(compact).toHaveBeenCalledTimes(2);
  });

  it('切换会话 → 水位线重置（短会话不误触发）', () => {
    setAutoCompact(true);
    const compact = vi.fn();
    const { rerender } = renderHook(
      ({ chatId, length }: { chatId: string; length: number }) =>
        useAutoCompact({
          chatId,
          messages: makeMessages(length),
          status: 'ready',
          compact,
          threshold: 600,
        }),
      { initialProps: { chatId: 's1', length: 700 } as never },
    );
    expect(compact).toHaveBeenCalledOnce();

    rerender({ chatId: 's2', length: 100 });
    expect(compact).toHaveBeenCalledOnce();
  });
});
