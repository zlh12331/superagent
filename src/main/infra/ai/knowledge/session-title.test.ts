// src/main/infra/ai/knowledge/session-title.test.ts
// 会话标题单测：首条/末条 user 提取 + 异步生成（默认标题才覆盖 / 失败静默）

import type { ChatMessage } from '@code-agent/shared/main';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SESSION_TITLE } from '../../storage/session-service';
import {
  ensureSessionTitle,
  firstUserMessageText,
  type ITitleGenerator,
  lastUserMessageText,
} from './session-title';

function userMessage(content: string): ChatMessage {
  return { id: 'm1', role: 'user', content, createdAt: 1, updatedAt: 1 } as unknown as ChatMessage;
}

function assistantMessage(): ChatMessage {
  return {
    id: 'm2',
    role: 'assistant',
    content: 'ok',
    createdAt: 2,
    updatedAt: 2,
  } as unknown as ChatMessage;
}

describe('firstUserMessageText / lastUserMessageText（纯函数）', () => {
  it('提取首条 user 文本', () => {
    expect(
      firstUserMessageText([assistantMessage(), userMessage('你好'), userMessage('再问')]),
    ).toBe('你好');
  });
  it('无 user 消息返回 undefined', () => {
    expect(firstUserMessageText([assistantMessage()])).toBeUndefined();
  });
  it('lastUserMessageText 取最后一条 user（非 assistant 干扰）', () => {
    const messages = [userMessage('第一问'), assistantMessage(), userMessage('第二问')];
    expect(lastUserMessageText(messages)).toBe('第二问');
  });
});

describe('ensureSessionTitle（异步标题生成）', () => {
  let sessionService: {
    get: ReturnType<typeof vi.fn>;
    rename: ReturnType<typeof vi.fn>;
  };
  let titleGenerator: ITitleGenerator;

  beforeEach(() => {
    sessionService = {
      get: vi.fn(async () => ({ session: { title: DEFAULT_SESSION_TITLE } })),
      rename: vi.fn(async () => undefined),
    };
    titleGenerator = {
      generateText: vi.fn(async () => ({ text: '修复登录闪退' })),
    } as unknown as ITitleGenerator;
  });

  it('默认标题时生成并重命名，失败静默', async () => {
    await ensureSessionTitle({
      sessionService: sessionService as never,
      titleGenerator,
      sessionId: 's1',
      firstUserText: '帮我修一下登录闪退',
    });
    expect(titleGenerator.generateText).toHaveBeenCalledTimes(1);
    expect(sessionService.rename).toHaveBeenCalledWith('s1', '修复登录闪退');
  });

  it('会话已有自定义标题时不覆盖', async () => {
    sessionService.get.mockResolvedValueOnce({ session: { title: '我的会话' } });
    await ensureSessionTitle({
      sessionService: sessionService as never,
      titleGenerator,
      sessionId: 's1',
      firstUserText: 'x',
    });
    expect(titleGenerator.generateText).not.toHaveBeenCalled();
  });

  it('首条用户文本为空直接跳过', async () => {
    await ensureSessionTitle({
      sessionService: sessionService as never,
      titleGenerator,
      sessionId: 's1',
      firstUserText: undefined,
    });
    expect(titleGenerator.generateText).not.toHaveBeenCalled();
  });

  it('LLM 失败静默（不抛错，不 rename）', async () => {
    titleGenerator.generateText = vi.fn(async () => {
      throw new Error('API down');
    });
    await expect(
      ensureSessionTitle({
        sessionService: sessionService as never,
        titleGenerator,
        sessionId: 's1',
        firstUserText: 'x',
      }),
    ).resolves.toBeUndefined();
    expect(sessionService.rename).not.toHaveBeenCalled();
  });
});
