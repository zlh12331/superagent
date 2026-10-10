// （Copyright 2025 Qwen，SPDX-License-Identifier: Apache-2.0）的

import { randomUUID } from 'node:crypto';
import { TurnEventType } from '@code-agent/shared/main';
import { logger } from '../../../utils/logger';
import type { IAgentService } from './agent-service';
import { StallWatchdog } from './stall-watchdog';
import { TaskKind, TaskStatus, taskService } from './task-service';

/** 子代理定义（内置集 + register 注册项共用此形状） */
export interface SubagentSpec {
  /** 代理名（snake_case；同时是 Map 的键，register 覆盖同名即按此键） */
  readonly name: string;
  /** 一句话描述（run_subagent 工具据其选择合适代理） */
  readonly description: string;
  /** 子代理系统提示词（委派时作为 startAgent 的 systemPrompt） */
  readonly prompt: string;
  /** 子代理回合最大步数（缺省回退 15，见 run 内 `spec.maxSteps ?? 15`） */
  readonly maxSteps?: number;
}

/** 子代理执行结果 */
export interface SubagentResult {
  /** 子代理回合累积的文本输出（TEXT_DELTA 拼接；纯工具回合为空串） */
  readonly output: string;
  /** 耗时（毫秒；从 run 入口到看门狗返回，含重试与等待） */
  readonly durationMs: number;
  /** 是否有输出（output.trim() 非空；空串即 false） */
  readonly hasOutput: boolean;
}

/** 子代理执行选项（透传给 StallWatchdog 的配置子集） */
export interface SubagentRunOptions {
  /** 停滞阈值（毫秒；缺省 60s，见 StallWatchdogOptions；工具执行中暂停计时） */
  readonly stallMs?: number;
  /** 停滞重试上限（初始 + 重试；缺省 3） */
  readonly maxAttempts?: number;
}

/** 子代理执行超时（毫秒；硬上限 5 分钟，超时真实中断回合，见 waitForTurnCompletion） */
const SUBAGENT_TIMEOUT_MS = 5 * 60 * 1000;

/** 内置子代理集（冻结只读；构造期装入实例 Map，register 可覆盖） */
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

/**
 * 子代理管理器
 *
 * 依赖 agentService 注入（构造期传入，支持测试替换 fake）；specs 为实例内可变
 * Map（内置集初始化，register 可覆盖同名 / 新增）。生产经模块级单例使用
 * （initSubagentManager / getSubagentManager），故为「模块单例 + 依赖注入」混合形态。
 */
export class SubagentManager {
  private readonly specs = new Map<string, SubagentSpec>(
    BUILTIN_SUBAGENTS.map((spec) => [spec.name, spec]),
  );

  constructor(private readonly agentService: IAgentService) {}

  /**
   * 列出全部子代理定义
   *
   * 返回副本数组（[...values]），调用方改动不影响内部 Map。
   */
  list(): SubagentSpec[] {
    return [...this.specs.values()];
  }

  /**
   * 委派任务给子代理（独立回合执行，无头模式）
   *
   * 流程：查 spec → 建 sessionId/task → 组 StallWatchdog → guard 内跑 dispatch。
   * dispatch 注册类级回合事件监听（按 sessionId 过滤，见文件头并发隔离说明），
   * 累积 TEXT_DELTA 为输出，并把工具事件/文本事件桥接为看门狗进度事件。
   *
   * 停滞防护（对齐 qwen workflow-stall 收敛）：
   * - 无进展（无流式文本/工具事件）超阈值 → 中断回合（agentService.abort）并重试
   * - 工具执行中暂停计时（长跑工具不误判）；父取消不重试
   * - 另有 5 分钟硬超时兜底（waitForTurnCompletion），超时同样真实中断回合
   *
   * @param name 子代理名（list 可查；未注册抛错并列出可用名）
   * @param task 委派任务描述（作为首条 user 消息）
   * @param workingDir 工作目录（工具执行根目录）
   * @param options 执行选项（停滞阈值 / 重试上限）
   * @returns 子代理输出（含耗时与 hasOutput）；代理不存在或重试耗尽均抛错
   */
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

  /**
   * 等待子代理回合结束（TURN_END / 超时兜底 / 停滞 abort）
   *
   * 从 run 提取（2026-09-08）：保持 run 可读并满足函数体门禁。
   * 语义：超时与停滞 abort 都**真实中断回合**（agentService.abort），
   * 避免子代理在后台继续消耗 token 并占用并发槽位；
   * 定时器与 abort 监听在 finally 清理。
   *
   * 三条收敛路径（均只 resolve 一次）：
   * - TURN_END：事件回调置 done 并调 setResolve 注入的 resolve
   * - 5 分钟超时：未 done 则置 done、abort 回合、标 FAILED、resolve
   * - 停滞/父取消（signal abort）：fail() 置 done、标 FAILED、abort 回合，再 resolve
   *
   * @param params.signal per-attempt 信号（来自 StallWatchdog，停滞时 abort）
   * @param params.isDone / markDone 完成标志读写（与事件回调共享的闭包状态）
   * @param params.setResolve 把本函数的 resolve 交给事件回调（TURN_END 时触发）
   */
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

  /**
   * 注册自定义子代理（按 name 覆盖同名；扩展用）
   */
  register(spec: SubagentSpec): void {
    this.specs.set(spec.name, spec);
  }

  /**
   * 任务状态更新（增强链路：失败仅记录日志，不阻断回合收尾）
   *
   * 触发场景：委派时的初始 RUNNING + TURN_END / 超时兜底 / 停滞 abort 四个调用点。
   * 真实缺陷修复：原实现 update 抛错会穿透 listener 的 try/catch，
   * 而 done 已置 true → 超时/停滞兜底被阻断 → 回合永久挂起。
   */
  private updateTaskStatus(taskId: string, status: TaskStatus): void {
    try {
      taskService.update(taskId, status);
    } catch (err: unknown) {
      logger.error({ error: err }, '任务状态更新失败');
    }
  }
}

/** 模块级单例（由 ServiceContainer 初始化注入；未初始化前为 null） */
let manager: SubagentManager | null = null;

/**
 * 初始化子代理管理器（ServiceContainer 调用；幂等）
 *
 * 已初始化则忽略入参直接返回既有实例（重复调用不重建、不换依赖）。
 */
export function initSubagentManager(agentService: IAgentService): SubagentManager {
  if (manager === null) {
    manager = new SubagentManager(agentService);
  }
  return manager;
}

/**
 * 获取子代理管理器（run_subagent 工具注册时调用）
 *
 * @throws 未初始化时抛错（提示先调 initSubagentManager）
 */
export function getSubagentManager(): SubagentManager {
  if (manager === null) {
    throw new Error('SubagentManager 未初始化（请先调用 initSubagentManager）');
  }
  return manager;
}
