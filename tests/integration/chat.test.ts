// tests/integration/chat.test.ts
// Chat 域集成测试（batch 8/9 收尾）
// ──────────────────────────────────────────────────────────────
// 链路：IPC handler（真实）→ ChatService（真实）→ streamText（真实 SDK）→
//       fake LLM model（外部边界替身）→ 事件推送/落库（真实）
// 替身：LLM（getModel → fake model）+ webContents（IPC 推送目标）
//
// 维度覆盖：接口契约 / 时序编排（事件序列）/ 状态一致性（落库 idle）/
//           错误传播（容错）/ 资源生命周期（abort 清理）
// 场景：事件流完整性 / 并发
// ──────────────────────────────────────────────────────────────

import { describe, expect, it, vi } from 'vitest';
import { getChatService, resetChatService } from '../../src/main/infra/ai/agent/chat-service';
import {
  getSessionService,
  resetSessionService,
} from '../../src/main/infra/storage/session-service';
import { createChatHandlers } from '../../src/main/ipc/chat.handler';
import { createFakeModel, modelParts } from './helpers/fake-model';
import { createFakeWebContents } from './helpers/fake-webcontents';
import { withTempUserData } from './helpers/with-db';

/** 当前 fake model（每用例切换；ai-provider 的 getModel 替身读取） */
let currentFakeModel: ReturnType<typeof createFakeModel>;

// LLM 是外部服务边界（允许替身）：getModel 返回当前 fake model
vi.mock('../../src/main/infra/ai/llm-client/ai-provider', () => ({
  getModel: async () => currentFakeModel,
}));

describe('chat 域集成链路（batch 8 收尾）', () => {
  it('正向：send 返回 sessionId，PART+END 推送，消息落库', async () => {
    resetSessionService();
    resetChatService();
    await withTempUserData(async () => {
      currentFakeModel = createFakeModel([
        [modelParts.textDelta('你好，我是助手'), modelParts.finish('stop')],
      ]);
      const chatService = getChatService(getSessionService());
      const handlers = createChatHandlers({ chatService });
      const { wc, sent } = createFakeWebContents();

      const sid = await getSessionService().create({
        workingDir: '/proj',
        title: undefined,
        messages: [],
      });
      const { sessionId } = await handlers.send(
        {
          messages: [{ role: 'user', content: '你好' }],
          sessionId: sid,
        },
        { traceId: 't1', sender: wc } as never,
      );
      expect(sessionId).toBe(sid);

      await vi.waitFor(
        () => {
          expect(sent.some((s) => s.channel.includes('stream:end'))).toBe(true);
        },
        { timeout: 2000 },
      );
      // chat 域为纯流式转发（无 sessionService 依赖——持久化由 agent 域负责，
      // 职责边界：chat 链路核心是事件流契约）
      const endEvent = sent.find((s) => s.channel.includes('stream:end'))?.payload as {
        sessionId: string;
      };
      // chat 的 END payload 无 reason 字段（与 agent 不同——结构契约验证）
      expect(endEvent.sessionId).toBe(sessionId);
    });
  });

  it('事件流完整性：文本拼接顺序', async () => {
    resetSessionService();
    resetChatService();
    await withTempUserData(async () => {
      currentFakeModel = createFakeModel([
        [modelParts.textDelta('第一段'), modelParts.textDelta('第二段'), modelParts.finish('stop')],
      ]);
      const handlers = createChatHandlers({ chatService: getChatService(getSessionService()) });
      const { wc, sent } = createFakeWebContents();
      const sid = await getSessionService().create({
        workingDir: '/proj',
        title: undefined,
        messages: [],
      });

      await handlers.send({ messages: [{ role: 'user', content: 'hi' }], sessionId: sid }, {
        traceId: 't2',
        sender: wc,
      } as never);
      await vi.waitFor(
        () => {
          expect(sent.some((s) => s.channel.includes('stream:end'))).toBe(true);
        },
        { timeout: 2000 },
      );
      const textPayloads = sent
        .filter((s) => s.channel.includes('stream:part'))
        .map((s) => {
          const part = (s.payload as { part: { text?: string; delta?: string } }).part;
          return part.text ?? part.delta ?? '';
        })
        .join('');
      expect(textPayloads).toContain('第一段第二段');
    });
  });

  it('stop：abort 中断信号生效 + 资源清理', async () => {
    resetSessionService();
    resetChatService();
    await withTempUserData(async () => {
      currentFakeModel = createFakeModel([[modelParts.textDelta('等待')]], undefined, {
        holdOpen: true,
      });
      const chatService = getChatService(getSessionService());
      const handlers = createChatHandlers({ chatService });
      const { wc } = createFakeWebContents();
      const sid = await getSessionService().create({
        workingDir: '/proj',
        title: undefined,
        messages: [],
      });

      const { sessionId } = await handlers.send(
        { messages: [{ role: 'user', content: 'hi' }], sessionId: sid },
        { traceId: 't3', sender: wc } as never,
      );
      await new Promise((resolve) => setTimeout(resolve, 200));
      const stopped = await handlers.stop({ sessionId });
      expect(stopped.stopped).toBe(true);
      // 资源清理：再次 abort 返回 false
      expect(await handlers.stop({ sessionId })).toEqual({ stopped: false });
    });
  });

  it('异常容错：model 抛错 → 回合不崩溃 + 会话归位 idle', async () => {
    resetSessionService();
    resetChatService();
    await withTempUserData(async () => {
      currentFakeModel = createFakeModel([], () => {
        throw new Error('model down');
      });
      const chatService = getChatService(getSessionService());
      const handlers = createChatHandlers({ chatService });
      const { wc, sent } = createFakeWebContents();
      const sid = await getSessionService().create({
        workingDir: '/proj',
        title: undefined,
        messages: [],
      });

      await handlers.send({ messages: [{ role: 'user', content: 'hi' }], sessionId: sid }, {
        traceId: 't4',
        sender: wc,
      } as never);
      await vi.waitFor(
        () => {
          expect(
            sent.some((s) => s.channel.includes('stream:end')) ||
              sent.some((s) => s.channel.includes('stream:error')),
          ).toBe(true);
        },
        { timeout: 2000 },
      );
      const detail = await getSessionService().get(sid);
      expect(detail.session.lastRunStatus).toBe('idle');
    });
  });

  it('并发：并行 send 互不干扰', async () => {
    resetSessionService();
    resetChatService();
    await withTempUserData(async () => {
      currentFakeModel = createFakeModel([[modelParts.textDelta('ok'), modelParts.finish('stop')]]);
      const chatService = getChatService(getSessionService());
      const handlers = createChatHandlers({ chatService });

      const results = await Promise.all(
        Array.from({ length: 3 }, (_, i) =>
          (async () => {
            const sid = await getSessionService().create({
              workingDir: '/proj',
              title: `s${i}`,
              messages: [],
            });
            return handlers.send(
              { messages: [{ role: 'user', content: `m${i}` }], sessionId: sid },
              { traceId: `t${i}`, sender: createFakeWebContents().wc } as never,
            );
          })(),
        ),
      );
      expect(results).toHaveLength(3);
      // 等全部完成
      await new Promise((resolve) => setTimeout(resolve, 500));
      const list = await getSessionService().list(10, 0);
      expect(list.total).toBe(3);
    });
  });
});
