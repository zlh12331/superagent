import { describe, expect, it, vi } from 'vitest';
import { AgentService } from '../../src/main/infra/ai/agent/agent-service';
import { PromptService } from '../../src/main/infra/ai/prompt/prompt-service';
import { PermissionService } from '../../src/main/infra/ai/tools/permission-service';
import { ToolExecutor } from '../../src/main/infra/ai/tools/tool-executor';
import { ToolRegistry } from '../../src/main/infra/ai/tools/tool-registry';
import {
  getSessionService,
  resetSessionService,
} from '../../src/main/infra/storage/session-service';
import { createAgentHandlers } from '../../src/main/ipc/agent.handler';
import { createFakeModel, modelParts } from './helpers/fake-model';
import { withTempUserData } from './helpers/with-db';

/** 当前 fake model（每用例切换；ai-provider 的 getModel 替身读取） */
let currentFakeModel: ReturnType<typeof createFakeModel>;

vi.mock('../../src/main/infra/ai/llm-client/ai-provider', () => ({
  getModel: async () => currentFakeModel,
}));

/** fake webContents（IPC 推送目标替身） */
function createFakeWebContents() {
  const sent: Array<{ channel: string; payload: unknown }> = [];
  const wc = {
    send: (channel: string, payload: unknown) => {
      sent.push({ channel, payload });
    },
    isDestroyed: () => false,
  } as never;
  return { wc, sent };
}

/** 装配真实 AgentService（空工具注册表——2a 无工具场景） */
function createHarness() {
  const toolRegistry = new ToolRegistry();
  const permissionService = new PermissionService();
  const toolExecutor = new ToolExecutor(toolRegistry, permissionService);
  const promptService = new PromptService();
  const sessionService = getSessionService();
  const agentService = new AgentService(toolRegistry, toolExecutor, promptService, sessionService);
  const handlers = createAgentHandlers({ agentService });
  return { agentService, handlers, sessionService };
}

describe('agent.run 主链路（batch 2/9 · 2a 无工具）', () => {
  it('正向：run 返回 sessionId，纯文本回复推送 PART+END，消息落库', async () => {
    resetSessionService();
    await withTempUserData(async () => {
      currentFakeModel = createFakeModel([
        [modelParts.textDelta('你好，我是 Code Agent'), modelParts.finish('stop')],
      ]);
      const { handlers, sessionService } = createHarness();
      const { wc, sent } = createFakeWebContents();

      const sid = await sessionService.create({
        workingDir: '/proj',
        title: undefined,
        messages: [],
      });
      const { sessionId } = await handlers.run(
        {
          messages: [{ role: 'user', content: '你好' }],
          sessionId: sid,
          workingDir: '/proj',
          systemPrompt: undefined,
          maxSteps: 5,
          mode: 'chat',
        },
        { traceId: 't1', sender: wc } as never,
      );
      expect(sessionId).toBeDefined();

      await vi.waitFor(() => {
        expect(sent.some((s) => s.channel.includes('stream:end'))).toBe(true);
      });

      const endEvent = sent.find((s) => s.channel.includes('stream:end'))?.payload as {
        reason: string;
      };
      expect(endEvent.reason).toBe('completed');
      const partEvents = sent.filter((s) => s.channel.includes('stream:part'));
      expect(partEvents.length).toBeGreaterThan(0);

      const detail = await sessionService.get(sessionId);
      expect(detail.session.lastRunStatus).toBe('idle');
    });
  });

  it('事件流完整性：工具调用前无 PART，结束后有 END（顺序）', async () => {
    resetSessionService();
    await withTempUserData(async () => {
      currentFakeModel = createFakeModel([
        [modelParts.textDelta('第一段'), modelParts.textDelta('第二段'), modelParts.finish('stop')],
      ]);
      const { handlers, sessionService } = createHarness();
      const { wc, sent } = createFakeWebContents();

      const sid = await sessionService.create({
        workingDir: '/proj',
        title: undefined,
        messages: [],
      });
      await handlers.run(
        {
          messages: [{ role: 'user', content: 'hi' }],
          sessionId: sid,
          workingDir: '/proj',
          systemPrompt: undefined,
          maxSteps: 5,
          mode: 'chat',
        },
        { traceId: 't2', sender: wc } as never,
      );
      await vi.waitFor(() => {
        expect(sent.some((s) => s.channel.includes('stream:end'))).toBe(true);
      });
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

  it('推理链路：reasoning part 全链路透传至 stream:part（推理块数据源）', async () => {
    resetSessionService();
    await withTempUserData(async () => {
      currentFakeModel = createFakeModel([
        [
          modelParts.reasoningStart(),
          modelParts.reasoningDelta('思考中…'),
          modelParts.reasoningEnd(),
          modelParts.textDelta('答案'),
          modelParts.finish('stop'),
        ],
      ]);
      const { handlers, sessionService } = createHarness();
      const { wc, sent } = createFakeWebContents();

      const sid = await sessionService.create({
        workingDir: '/proj',
        title: undefined,
        messages: [],
      });
      await handlers.run(
        {
          messages: [{ role: 'user', content: 'hi' }],
          sessionId: sid,
          workingDir: '/proj',
          systemPrompt: undefined,
          maxSteps: 5,
          mode: 'chat',
        },
        { traceId: 't5', sender: wc } as never,
      );
      await vi.waitFor(() => {
        expect(sent.some((s) => s.channel.includes('stream:end'))).toBe(true);
      });
      const parts = sent
        .filter((s) => s.channel.includes('stream:part'))
        .map((s) => (s.payload as { part: { type: string; delta?: string } }).part);
      const reasoningDeltas = parts.filter((p) => p.type === 'reasoning-delta');
      expect(reasoningDeltas.length).toBeGreaterThan(0);
      expect(reasoningDeltas[0]?.delta).toBe('思考中…');
      expect(parts.some((p) => p.type === 'text-delta')).toBe(true);
    });
  });

  it('异常容错：fake model 抛错 → 回合不崩溃 + 会话归位 idle', async () => {
    resetSessionService();
    await withTempUserData(async () => {
      currentFakeModel = createFakeModel([], () => {
        throw new Error('model down');
      });
      const { handlers, sessionService } = createHarness();
      const { wc, sent } = createFakeWebContents();

      const sid = await sessionService.create({
        workingDir: '/proj',
        title: undefined,
        messages: [],
      });
      const { sessionId } = await handlers.run(
        {
          messages: [{ role: 'user', content: 'hi' }],
          sessionId: sid,
          workingDir: '/proj',
          systemPrompt: undefined,
          maxSteps: 5,
          mode: 'chat',
        },
        { traceId: 't3', sender: wc } as never,
      );
      await vi.waitFor(
        () => {
          expect(
            sent.some((s) => s.channel.includes('stream:end')) ||
              sent.some((s) => s.channel.includes('stream:error')),
          ).toBe(true);
        },
        { timeout: 2000 },
      );
      const detail = await sessionService.get(sessionId);
      expect(detail.session.lastRunStatus).toBe('idle');
    });
  });

  it('stop：run 后 abort → 中断信号生效 + 资源清理', async () => {
    resetSessionService();
    await withTempUserData(async () => {
      currentFakeModel = createFakeModel([[modelParts.textDelta('等待')]], undefined, {
        holdOpen: true,
      });
      const { handlers } = createHarness();
      const { wc, sent } = createFakeWebContents();

      const { sessionId } = await handlers.run(
        {
          messages: [{ role: 'user', content: 'hi' }],
          sessionId: undefined,
          workingDir: '/proj',
          systemPrompt: undefined,
          maxSteps: 5,
          mode: 'chat',
        },
        { traceId: 't4', sender: wc } as never,
      );
      await new Promise((resolve) => setTimeout(resolve, 200));
      const stopped = await handlers.stop({ sessionId });
      expect(stopped.stopped).toBe(true);
      expect(await handlers.stop({ sessionId })).toEqual({ stopped: false });
      await vi.waitFor(
        () => {
          expect(
            sent.some((s) => s.channel.includes('stream:end')) ||
              sent.some((s) => s.channel.includes('stream:error')),
          ).toBe(true);
        },
        { timeout: 2000 },
      );
    });
  });
});
