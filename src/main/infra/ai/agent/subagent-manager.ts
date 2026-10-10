import { randomUUID } from 'node:crypto';
import { TurnEventType } from '@code-agent/shared/main';
import { logger } from '../../../utils/logger';
import type { IAgentService } from './agent-service';
import { StallWatchdog } from './stall-watchdog';
import { TaskKind, TaskStatus, taskService } from './task-service';

export interface SubagentSpec {
  readonly name: string;
  readonly description: string;
  readonly prompt: string;
  readonly maxSteps?: number;
}

export interface SubagentResult {
  readonly output: string;
  readonly durationMs: number;
  readonly hasOutput: boolean;
}

export interface SubagentRunOptions {
  readonly stallMs?: number;
  readonly maxAttempts?: number;
}

const SUBAGENT_TIMEOUT_MS = 5 * 60 * 1000;

const BUILTIN_SUBAGENTS: readonly SubagentSpec[] = Object.freeze([
  {
    name: 'general',
    description: '通用子代理：处理任意独立子任务（研究/分析/实现）',
    prompt: '你是一个专注的通用子代理。完成被委派的任务并输出结论。',
    maxSteps: 15,
  },
  {
    name: 'code_review',
    description: '代码审查子代理：独立审查代码变更',
    prompt: [
      '你是一个代码审查子代理。审查被委派的代码变更，输出结构化审查结论：',
      '1. 每个发现标注严重度（critical/warning/nit）',
      '2. 给出具体修复建议',
      '3. 总结总体评估',
    ].join('\n'),
    maxSteps: 10,
  },
  {
    name: 'plan',
    description: '方案子代理：只读分析并输出实施计划（不执行）',
    prompt: [
      '你是一个方案子代理。分析被委派的任务并输出实施计划：',
      '1. 目标与范围',
      '2. 实施步骤（含涉及文件）',
      '3. 风险与验证方式',
      '只读分析，不修改任何文件。',
    ].join('\n'),
    maxSteps: 10,
  },
]);

export class SubagentManager {
  private readonly specs = new Map<string, SubagentSpec>(
    BUILTIN_SUBAGENTS.map((spec) => [spec.name, spec]),
  );

  constructor(private readonly agentService: IAgentService) {}

  list(): SubagentSpec[] {
    return [...this.specs.values()];
  }

  async run(
    name: string,
    task: string,
    workingDir: string,
    options?: SubagentRunOptions,
  ): Promise<SubagentResult> {
    const spec = this.specs.get(name);
    if (spec === undefined) {
      throw new Error(`未知子代理: ${name}（可用：${[...this.specs.keys()].join(', ')}）`);
    }

    const sessionId = randomUUID();
    const startTime = Date.now();
    const taskId = taskService.create(
      sessionId,
      TaskKind.AGENT,
      `子代理 ${name}：${task.slice(0, 60)}`,
    );
    this.updateTaskStatus(taskId, TaskStatus.RUNNING);

    const watchdog = new StallWatchdog({
      ...(options?.stallMs !== undefined ? { stallMs: options.stallMs } : {}),
      ...(options?.maxAttempts !== undefined ? { maxAttempts: options.maxAttempts } : {}),
    });
    const finalOutput = await watchdog.guard({
      label: `子代理 ${name}`,
      dispatch: async (signal, report) => {
        let output = '';
        let resolveDone: (() => void) | undefined;
        let done = false;

        const unsubscribe = this.agentService.onTurnEvent((event) => {
          try {
            if (event.sessionId !== sessionId) {
              return;
            }
            if (event.type === TurnEventType.TEXT_DELTA) {
              output += event.text;
              report({ type: 'progress' });
            } else if (event.type === TurnEventType.TOOL_CALL) {
              report({ type: 'tool-start' });
            } else if (event.type === TurnEventType.TOOL_RESULT) {
              report({ type: 'tool-end' });
            } else if (event.type === TurnEventType.TURN_END && !done) {
              done = true;
              const reason = event.reason;
              this.updateTaskStatus(
                taskId,
                reason === 'completed' ? TaskStatus.COMPLETED : TaskStatus.FAILED,
              );
              report({ type: 'progress' });
              resolveDone?.();
            }
          } catch (err: unknown) {
            logger.error({ error: err }, '子代理事件处理异常');
          }
        });

        try {
          const completion = this.waitForTurnCompletion({
            name,
            sessionId,
            taskId,
            signal,
            isDone: () => done,
            markDone: () => {
              done = true;
            },
            setResolve: (fn) => {
              resolveDone = fn;
            },
          });
          await this.agentService.startAgent({
            messages: [{ role: 'user', content: task }],
            sessionId,
            workingDir,
            systemPrompt: spec.prompt,
            maxSteps: spec.maxSteps ?? 15,
          });
          await completion;
          return output;
        } finally {
          unsubscribe();
        }
      },
    });

    return {
      output: finalOutput,
      durationMs: Date.now() - startTime,
      hasOutput: finalOutput.trim().length > 0,
    };
  }

  private async waitForTurnCompletion(params: {
    readonly name: string;
    readonly sessionId: string;
    readonly taskId: string;
    readonly signal: AbortSignal;
    readonly isDone: () => boolean;
    readonly markDone: () => void;
    readonly setResolve: (fn: () => void) => void;
  }): Promise<void> {
    const { name, sessionId, taskId, signal, isDone, markDone, setResolve } = params;
    const fail = (): void => {
      if (isDone()) {
        return;
      }
      markDone();
      this.updateTaskStatus(taskId, TaskStatus.FAILED);
      this.agentService.abort(sessionId);
    };
    const abortListener = (): void => {
      fail();
      resolveCompletion?.();
    };
    let resolveCompletion: (() => void) | undefined;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise<void>((resolve) => {
        resolveCompletion = resolve;
        setResolve(resolve);
        timeoutTimer = setTimeout(() => {
          if (!isDone()) {
            markDone();
            logger.warn({ subagent: name, sessionId }, '子代理回合超时');
            this.agentService.abort(sessionId);
            this.updateTaskStatus(taskId, TaskStatus.FAILED);
            resolve();
          }
        }, SUBAGENT_TIMEOUT_MS);
        timeoutTimer.unref?.();
        signal.addEventListener('abort', abortListener);
      });
    } finally {
      if (timeoutTimer !== undefined) {
        clearTimeout(timeoutTimer);
      }
      signal.removeEventListener('abort', abortListener);
    }
  }

  register(spec: SubagentSpec): void {
    this.specs.set(spec.name, spec);
  }

  private updateTaskStatus(taskId: string, status: TaskStatus): void {
    try {
      taskService.update(taskId, status);
    } catch (err: unknown) {
      logger.error({ error: err }, '任务状态更新失败');
    }
  }
}

let manager: SubagentManager | null = null;

export function initSubagentManager(agentService: IAgentService): SubagentManager {
  if (manager === null) {
    manager = new SubagentManager(agentService);
  }
  return manager;
}

export function getSubagentManager(): SubagentManager {
  if (manager === null) {
    throw new Error('SubagentManager 未初始化（请先调用 initSubagentManager）');
  }
  return manager;
}
