// src/main/infra/ai/agent/agent-ask-service.test.ts
// AgentAskService 单测：提问推送/响应/超时/销毁守卫（ask_user_question 闭环核心）
//
// 测试要点：
// 1. ask 推送 payload（sessionId/askId/questions）经 emitEvent 统一出口
// 2. respond 匹配 pending → 回答返回；未匹配 → false
// 3. webContents 已销毁 → 立即 resolve null（不挂满 60s 超时）
// 4. 60s 无响应 → resolve null + pending 清理
// 5. dispose 清理全部 pending（回合中断不挂起）

import type { AgentAnswer, AgentQuestion } from '@code-agent/shared/main';
import type { WebContents } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentAskService } from './agent-ask-service';

/**
 * webContents 替身：send 记录推送（emitEvent 真实调用，边界替身对齐测试原则）
 */
function makeWebContents(destroyed = false): WebContents & { send: ReturnType<typeof vi.fn> } {
  return {
    isDestroyed: () => destroyed,
    send: vi.fn(),
  } as unknown as WebContents & { send: ReturnType<typeof vi.fn> };
}

describe('AgentAskService.ask（提问推送）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('推送 payload 含 sessionId/askId/questions（并发回合按会话归属）', async () => {
    const service = new AgentAskService();
    const wc = makeWebContents();
    const promise = service.ask(wc, [{ question: '继续吗？' }], 'sess-1');

    expect(wc.send).toHaveBeenCalledTimes(1);
    const [channel, payload] = wc.send.mock.calls[0] as unknown as [
      string,
      { sessionId: string; askId: string; questions: readonly AgentQuestion[] },
    ];
    expect(channel).toBeDefined();
    expect(payload.sessionId).toBe('sess-1');
    expect(payload.askId).toMatch(/^[\w-]{8,}$/);
    expect(payload.questions).toEqual([{ question: '继续吗？' }]);

    service.dispose();
    await expect(promise).resolves.toBeNull();
  });

  it('respond 匹配 pending → 回答返回且 pending 清理', async () => {
    const service = new AgentAskService();
    const wc = makeWebContents();
    const promise = service.ask(wc, [{ question: '确认？' }], 's1');
    const payload = wc.send.mock.calls[0]?.[1] as { askId: string };

    const answers: AgentAnswer[] = [{ text: '确认' }];
    const responded = service.respond(payload.askId, answers);

    expect(responded).toBe(true);
    await expect(promise).resolves.toEqual(answers);
    expect(service.getPendingCount()).toBe(0);
  });

  it('respond 未匹配（已超时/重复响应）→ false 且不抛', async () => {
    const service = new AgentAskService();
    expect(service.respond('no-such-ask', [{ text: 'x' }])).toBe(false);
  });

  it('webContents 已销毁 → 立即 resolve null（不挂满超时）', async () => {
    const service = new AgentAskService();
    const promise = service.ask(makeWebContents(true), [{ question: '谁在？' }], 's1');

    // 未经过 60s 即已 resolve（销毁守卫）
    await expect(promise).resolves.toBeNull();
    expect(service.getPendingCount()).toBe(0);
  });

  it('60s 无响应 → resolve null + pending 清理', async () => {
    const service = new AgentAskService();
    const promise = service.ask(makeWebContents(), [{ question: '超时测试' }], 's1');

    await vi.advanceTimersByTimeAsync(61_000);

    await expect(promise).resolves.toBeNull();
    expect(service.getPendingCount()).toBe(0);
  });

  it('dispose 清理全部 pending（应用退出/回合中断不挂起）', async () => {
    const service = new AgentAskService();
    const p1 = service.ask(makeWebContents(), [{ question: 'q1' }], 's1');
    const p2 = service.ask(makeWebContents(), [{ question: 'q2' }], 's2');

    service.dispose();

    await expect(p1).resolves.toBeNull();
    await expect(p2).resolves.toBeNull();
    expect(service.getPendingCount()).toBe(0);
  });
});
