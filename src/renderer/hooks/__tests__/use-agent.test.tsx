// src/renderer/hooks/__tests__/use-agent.test.tsx
// 回归：useAgentWithIpc 必须把 id 透传给 useChat
//
// 根因链（journey-agent E2E 三例失败）：id 被解构掉未透传 → useChat 自生成随机
// chatId → transport 以该随机串作为 IPC sessionId 发往主进程 → 主进程回流的审批
// 载荷 sessionId 与 ChatPanel 的 chatId 永不相等 → InlineApprovalCard 不渲染、
// 回合结束 clearBySession/invalidate 失配。

import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAgentWithIpc } from '../use-agent';

/** 捕获每次 useChat 收到的 options（mock 边界：AI SDK 内部实现不在测试范围） */
const calls = vi.hoisted(() => [] as Array<Record<string, unknown>>);

vi.mock('@ai-sdk/react', () => ({
  useChat: (options: Record<string, unknown>) => {
    calls.push(options);
    return { messages: [], sendMessage: vi.fn(), status: 'ready' };
  },
}));

describe('useAgentWithIpc', () => {
  beforeEach(() => {
    calls.length = 0;
  });

  it('传入 id：透传给 useChat（会话级审批事件匹配的前提）', () => {
    renderHook(() => useAgentWithIpc({ id: 'chat-42', workingDir: '/tmp/proj' }));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.['id']).toBe('chat-42');
  });

  it('未传 id：useChat options 不含 id 键（exactOptionalPropertyTypes 条件展开）', () => {
    renderHook(() => useAgentWithIpc({ workingDir: '/tmp/proj' }));
    expect(calls[0]).not.toHaveProperty('id');
  });

  it('agent 专用字段不外泄给 useChat，transport 正常注入', () => {
    renderHook(() =>
      useAgentWithIpc({ id: 'c1', workingDir: '/w', systemPrompt: 'p', maxSteps: 5 }),
    );
    const options = calls[0];
    expect(options).not.toHaveProperty('workingDir');
    expect(options).not.toHaveProperty('systemPrompt');
    expect(options).not.toHaveProperty('maxSteps');
    expect(options).toHaveProperty('transport');
  });
});
