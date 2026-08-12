// src/main/infra/ai/agent/subagent-manager.test.ts
// SubagentManager 单测：委派执行 / 回合事件累积 / 停滞防护 / 任务跟踪
//
// 测试要点：
// 1. list：内置子代理定义（general/code_review/plan）
// 2. run：委派 startAgent（无头）+ TURN_END 事件收集输出
// 3. 事件按 sessionId 过滤（多子代理并发不串流）
// 4. 停滞：无进展超阈值 → abort + 任务 FAILED + 返回空输出
// 5. 回合超时兜底（5min）→ 任务 FAILED
// 6. 未知代理名抛错；startAgent 失败重试耗尽抛错
// 7. 单例：getSubagentManager 未初始化抛错（首个用例）；init 幂等
//
// 依赖策略：agentService 注入 fake；taskService 为数据库外部依赖 → mock；
// StallWatchdog 真实实现（停滞阈值用短 stallMs 驱动）。

import type { TurnEvent } from '@code-agent/shared/main';
import { TurnEventType } from '@code-agent/shared/main';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IAgentService } from './agent-service';
import type { SubagentResult } from './subagent-manager';
import { getSubagentManager, initSubagentManager, SubagentManager } from './subagent-manager';

const mocks = vi.hoisted(() => {
  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  // taskService 为数据库外部依赖：mock 单例（保留 TaskKind/TaskStatus 真实枚举）
  const mockTaskService = {
    create: vi.fn(() => 'task-1'),
    update: vi.fn(),
  };
  return { mockLogger, mockTaskService };
});

vi.mock('node:crypto', () => ({
  randomUUID: () => 'sub-session-1',
}));

vi.mock('../../../utils/logger', () => ({
  logger: mocks.mockLogger,
}));

vi.mock('./task-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./task-service')>();
  return {
    ...actual,
    taskService: mocks.mockTaskService,
  };
});

import { TaskKind, TaskStatus } from './task-service';

/** 单例访问（模块级 manager 初始为 null；本 describe 必须是文件首个用例块） */
describe('getSubagentManager 单例访问', () => {
  it('未初始化：抛错提示先调用 initSubagentManager', () => {
    expect(() => getSubagentManager()).toThrow('SubagentManager 未初始化');
  });
});

/**
 * 创建 fake agentService：捕获 onTurnEvent 注册的监听器，测试手动驱动回合事件
 */
function createFakeAgentService() {
  let listener: ((event: TurnEvent) => void) | undefined;
  const agentService = {
    onTurnEvent: vi.fn((l: (event: TurnEvent) => void) => {
      listener = l;
      return () => {
        if (listener === l) {
          listener = undefined;
        }
      };
    }),
    startAgent: vi.fn(async (..._args: unknown[]) => 'sub-session-1'),
    abort: vi.fn(() => true),
    abortAll: vi.fn(),
    dispose: vi.fn(async () => {}),
  };
  /** 向当前监听器推送一个回合事件 */
  const emit = (event: TurnEvent): void => {
    listener?.(event);
  };
  return { agentService, emit };
}

function textDelta(sessionId: string, text: string): TurnEvent {
  return {
    type: TurnEventType.TEXT_DELTA,
    sessionId,
    turnId: 'turn-1',
    timestamp: Date.now(),
    text,
  } as TurnEvent;
}

function turnEnd(sessionId: string, reason: 'completed' | 'failed' | 'cancelled'): TurnEvent {
  return {
    type: TurnEventType.TURN_END,
    sessionId,
    turnId: 'turn-1',
    timestamp: Date.now(),
    reason,
    durationMs: 100,
  } as TurnEvent;
}

describe('SubagentManager 批次3 缺口补全', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.mockTaskService.create.mockReturnValue('task-1');
  });

  describe('list / register', () => {
    it('list：返回内置 3 个子代理定义', () => {
      const { agentService } = createFakeAgentService();
      const manager = new SubagentManager(agentService as unknown as IAgentService);

      const specs = manager.list();

      expect(specs).toHaveLength(3);
      expect(specs.map((s) => s.name)).toEqual(['general', 'code_review', 'plan']);
      expect(specs[0]?.maxSteps).toBe(15);
    });

    it('register：覆盖同名定义；新名字可注册并可运行', async () => {
      const { agentService, emit } = createFakeAgentService();
      const manager = new SubagentManager(agentService as unknown as IAgentService);
      // 无 maxSteps 的定义：run 时回退默认 15（maxSteps ?? 15 分支）
      manager.register({ name: 'custom', description: '自定义', prompt: '你是自定义代理' });

      const names = manager.list().map((s) => s.name);
      expect(names).toContain('custom');

      const promise = manager.run('custom', '做点事', '/tmp/proj');
      const args = agentService.startAgent.mock.calls[0]?.[0] as { maxSteps: number } | undefined;
      expect(args?.maxSteps).toBe(15);
      emit(turnEnd('sub-session-1', 'completed'));
      await promise;
    });
  });

  describe('单例管理', () => {
    it('initSubagentManager：幂等，重复调用返回同一实例', () => {
      const { agentService } = createFakeAgentService();
      const first = initSubagentManager(agentService as unknown as IAgentService);
      const second = initSubagentManager(agentService as unknown as IAgentService);

      expect(second).toBe(first);
    });
  });

  describe('run 委派执行', () => {
    it('委派：startAgent 无头调用（不传 webContents）+ 任务跟踪', async () => {
      const { agentService, emit } = createFakeAgentService();
      const manager = new SubagentManager(agentService as unknown as IAgentService);

      const promise = manager.run('general', '分析项目结构', '/tmp/proj');

      expect(mocks.mockTaskService.create).toHaveBeenCalledWith(
        'sub-session-1',
        TaskKind.AGENT,
        expect.stringContaining('子代理 general'),
      );
      expect(mocks.mockTaskService.update).toHaveBeenCalledWith('task-1', TaskStatus.RUNNING);
      const args = agentService.startAgent.mock.calls[0]?.[0] as
        | Record<string, unknown>
        | undefined;
      expect(args?.['messages']).toEqual([{ role: 'user', content: '分析项目结构' }]);
      expect(args?.['sessionId']).toBe('sub-session-1');
      expect(args?.['systemPrompt']).toBe('你是一个专注的通用子代理。完成被委派的任务并输出结论。');
      expect(args?.['webContents']).toBeUndefined();
      emit(turnEnd('sub-session-1', 'completed'));
      await promise;
    });

    it('回合完成：TEXT_DELTA 累积为输出 + 任务 COMPLETED', async () => {
      const { agentService, emit } = createFakeAgentService();
      const manager = new SubagentManager(agentService as unknown as IAgentService);

      const promise = manager.run('general', '任务', '/tmp/proj');
      emit(textDelta('sub-session-1', '第一段'));
      emit(textDelta('sub-session-1', '第二段'));
      emit(turnEnd('sub-session-1', 'completed'));

      const result: SubagentResult = await promise;
      expect(result.output).toBe('第一段第二段');
      expect(result.hasOutput).toBe(true);
      expect(mocks.mockTaskService.update).toHaveBeenLastCalledWith('task-1', TaskStatus.COMPLETED);
    });

    it('回合失败：TURN_END(failed) → 任务 FAILED，输出为累积内容', async () => {
      const { agentService, emit } = createFakeAgentService();
      const manager = new SubagentManager(agentService as unknown as IAgentService);

      const promise = manager.run('general', '任务', '/tmp/proj');
      emit(textDelta('sub-session-1', '部分输出'));
      emit(turnEnd('sub-session-1', 'failed'));

      const result = await promise;
      expect(result.output).toBe('部分输出');
      expect(mocks.mockTaskService.update).toHaveBeenLastCalledWith('task-1', TaskStatus.FAILED);
    });

    it('事件按 sessionId 过滤：其他回合事件不累积', async () => {
      const { agentService, emit } = createFakeAgentService();
      const manager = new SubagentManager(agentService as unknown as IAgentService);

      const promise = manager.run('general', '任务', '/tmp/proj');
      emit(textDelta('other-session', '别人的输出'));
      emit(textDelta('sub-session-1', '我的输出'));
      emit(turnEnd('sub-session-1', 'completed'));

      const result = await promise;
      expect(result.output).toBe('我的输出');
    });

    it('工具事件：TOOL_CALL/TOOL_RESULT 喂入看门狗（不阻断累积）', async () => {
      const { agentService, emit } = createFakeAgentService();
      const manager = new SubagentManager(agentService as unknown as IAgentService);

      const promise = manager.run('general', '任务', '/tmp/proj');
      emit({
        type: TurnEventType.TOOL_CALL,
        sessionId: 'sub-session-1',
        turnId: 'turn-1',
        timestamp: Date.now(),
        toolName: 'grep',
        input: { pattern: 'x' },
      } as TurnEvent);
      emit({
        type: TurnEventType.TOOL_RESULT,
        sessionId: 'sub-session-1',
        turnId: 'turn-1',
        timestamp: Date.now(),
        toolCallId: 'c1',
        toolName: 'grep',
        success: true,
      } as TurnEvent);
      emit(textDelta('sub-session-1', '结论'));
      emit(turnEnd('sub-session-1', 'completed'));

      const result = await promise;
      expect(result.output).toBe('结论');
    });

    it('任务状态更新失败：不阻断回合收尾（完成信号仍发出）', async () => {
      const { agentService, emit } = createFakeAgentService();
      const manager = new SubagentManager(agentService as unknown as IAgentService);
      // 第一次 update（RUNNING）正常；第二次（TURN_END 的 COMPLETED）抛错
      mocks.mockTaskService.update
        .mockImplementationOnce(() => {})
        .mockImplementationOnce(() => {
          throw new Error('db down');
        });

      const promise = manager.run('general', '任务', '/tmp/proj');
      emit(textDelta('sub-session-1', '输出'));
      emit(turnEnd('sub-session-1', 'completed'));

      const result = await promise;
      expect(result.output).toBe('输出');
      // 任务跟踪失败仅记录日志（真实缺陷修复：原实现会因 done 已置位导致回合永久挂起）
      expect(mocks.mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.any(Error) }),
        expect.stringContaining('任务状态更新失败'),
      );
    });

    it('未知代理名：抛错并列出可用代理', async () => {
      const { agentService } = createFakeAgentService();
      const manager = new SubagentManager(agentService as unknown as IAgentService);

      await expect(manager.run('ghost', '任务', '/tmp/proj')).rejects.toThrow(/未知子代理: ghost/);
      expect(agentService.startAgent).not.toHaveBeenCalled();
    });
  });

  describe('停滞与超时防护', () => {
    it('停滞：无进展超阈值 → abort 回合 + 任务 FAILED + 空输出', async () => {
      const { agentService } = createFakeAgentService();
      const manager = new SubagentManager(agentService as unknown as IAgentService);

      const result = await manager.run('general', '任务', '/tmp/proj', { stallMs: 50 });

      expect(agentService.abort).toHaveBeenCalledWith('sub-session-1');
      expect(mocks.mockTaskService.update).toHaveBeenLastCalledWith('task-1', TaskStatus.FAILED);
      expect(result.output).toBe('');
      expect(result.hasOutput).toBe(false);
      expect(mocks.mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ label: '子代理 general', stallMs: 50 }),
        '检测到执行停滞',
      );
    });

    it('工具执行中暂停停滞计时：长跑工具不被误判', async () => {
      vi.useFakeTimers();
      try {
        const { agentService, emit } = createFakeAgentService();
        const manager = new SubagentManager(agentService as unknown as IAgentService);

        const promise = manager.run('general', '任务', '/tmp/proj', { stallMs: 100 });
        // 停滞阈值内工具开始执行（暂停计时），持续推进越过停滞阈值
        await vi.advanceTimersByTimeAsync(50);
        emit({
          type: TurnEventType.TOOL_CALL,
          sessionId: 'sub-session-1',
          turnId: 'turn-1',
          timestamp: Date.now(),
          toolName: 'grep',
        } as TurnEvent);
        await vi.advanceTimersByTimeAsync(500);
        // 工具执行中不触发停滞 abort
        expect(agentService.abort).not.toHaveBeenCalled();
        // 工具结束恢复计时 → 继续无进展 → 停滞
        emit({
          type: TurnEventType.TOOL_RESULT,
          sessionId: 'sub-session-1',
          turnId: 'turn-1',
          timestamp: Date.now(),
          toolCallId: 'c1',
          toolName: 'grep',
          success: true,
        } as TurnEvent);
        await vi.advanceTimersByTimeAsync(300);
        expect(agentService.abort).toHaveBeenCalledWith('sub-session-1');
        const assertion = expect(promise).resolves.toBeDefined();
        await vi.advanceTimersByTimeAsync(0);
        await assertion;
      } finally {
        vi.useRealTimers();
      }
    });

    it('回合超时兜底（5min）：任务 FAILED，不无限等待', async () => {
      vi.useFakeTimers();
      try {
        const { agentService } = createFakeAgentService();
        const manager = new SubagentManager(agentService as unknown as IAgentService);

        const promise = manager.run('general', '任务', '/tmp/proj', { stallMs: 600_000 });
        const assertion = expect(promise).resolves.toMatchObject({ output: '' });
        await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 100);

        await assertion;
        expect(mocks.mockTaskService.update).toHaveBeenLastCalledWith('task-1', TaskStatus.FAILED);
        expect(mocks.mockLogger.warn).toHaveBeenCalledWith(
          expect.objectContaining({ subagent: 'general', sessionId: 'sub-session-1' }),
          '子代理回合超时',
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it('startAgent 失败：看门狗重试耗尽后抛错', async () => {
      const { agentService } = createFakeAgentService();
      agentService.startAgent.mockRejectedValue(new Error('provider down'));
      const manager = new SubagentManager(agentService as unknown as IAgentService);

      await expect(manager.run('general', '任务', '/tmp/proj', { maxAttempts: 2 })).rejects.toThrow(
        /停滞重试耗尽/,
      );
      expect(agentService.startAgent).toHaveBeenCalledTimes(2);
    });
  });
});
