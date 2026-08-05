// src/main/infra/ai/subagent-manager.ts
// 子代理管理器：任务委派 → 独立回合执行 → 结果收集（对齐 qwen subagents 语义收敛）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 内置子代理定义（general / code_review / plan）
// - run：委派任务给子代理（独立 sessionId + 无头回合执行）
// - 结果收集：订阅回合事件总线（按 sessionId 过滤），累积转录 + TURN_END resolve
//
// 借鉴声明：
// 本模块参考 qwen-code 参考项目 packages/core/src/subagents/
// （Copyright 2025 Qwen，SPDX-License-Identifier: Apache-2.0）的
// BuiltinAgentRegistry（内置代理注册表）+ SubagentManager（委派执行）语义，
// 按我们的技术栈收敛重写：
// - 移除文件配置层（frontmatter schema / validation / 四级加载，强耦合不搬运）
// - 复用我们的无头执行基础（webContents 可空化）+ onTurnEvent 类级总线
// - 并发安全：多子代理并发时按 sessionId 过滤事件累积
// ──────────────────────────────────────────────────────────────

import { randomUUID } from 'node:crypto';
import { TurnEventType } from '@code-agent/shared/main';
import { logger } from '../../utils/logger';
import type { IAgentService } from './agent-service';
import { StallWatchdog } from './stall-watchdog';
import { TaskKind, TaskStatus, taskService } from './task-service';

/** 子代理定义 */
export interface SubagentSpec {
  /** 代理名（snake_case） */
  readonly name: string;
  /** 一句话描述（run_subagent 工具选择依据） */
  readonly description: string;
  /** 子代理系统提示词（委派时作为 systemPrompt） */
  readonly prompt: string;
  /** 子代理回合最大步数（默认 15） */
  readonly maxSteps?: number;
}

/** 子代理执行结果 */
export interface SubagentResult {
  /** 子代理回合输出文本 */
  readonly output: string;
  /** 耗时（毫秒） */
  readonly durationMs: number;
  /** 是否有输出（纯工具回合为空） */
  readonly hasOutput: boolean;
}

/** 子代理执行选项 */
export interface SubagentRunOptions {
  /** 停滞阈值（毫秒；缺省 60s；工具执行中暂停计时） */
  readonly stallMs?: number;
  /** 停滞重试上限（初始 + 重试；缺省 3） */
  readonly maxAttempts?: number;
}

/** 子代理执行超时（毫秒） */
const SUBAGENT_TIMEOUT_MS = 5 * 60 * 1000;

/** 内置子代理集 */
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
 * 子代理管理器（模块单例，依赖 agentService 注入）
 */
export class SubagentManager {
  private readonly specs = new Map<string, SubagentSpec>(
    BUILTIN_SUBAGENTS.map((spec) => [spec.name, spec]),
  );

  constructor(private readonly agentService: IAgentService) {}

  /**
   * 列出全部子代理定义
   */
  list(): SubagentSpec[] {
    return [...this.specs.values()];
  }

  /**
   * 委派任务给子代理（独立回合执行，无头模式）
   *
   * 停滞防护（对齐 qwen workflow-stall 收敛）：
   * - 无进展（无流式文本/工具事件）超阈值 → 中断回合（agentService.abort）并重试
   * - 工具执行中暂停计时（长跑工具不误判）；父取消不重试
   *
   * @param name 子代理名（list 可查）
   * @param task 委派任务描述
   * @param workingDir 工作目录（工具执行根目录）
   * @param options 执行选项（停滞阈值 / 重试上限）
   * @returns 子代理输出；代理不存在抛错
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
    // 任务跟踪：委派即任务（增强，失败不影响主流程）
    const taskId = taskService.create(
      sessionId,
      TaskKind.AGENT,
      `子代理 ${name}：${task.slice(0, 60)}`,
    );
    taskService.update(taskId, TaskStatus.RUNNING);

    const watchdog = new StallWatchdog({
      ...(options?.stallMs !== undefined ? { stallMs: options.stallMs } : {}),
      ...(options?.maxAttempts !== undefined ? { maxAttempts: options.maxAttempts } : {}),
    });
    const finalOutput = await watchdog.guard({
      label: `子代理 ${name}`,
      dispatch: async (signal, report) => {
        // 回合转录累积（按 sessionId 过滤：多子代理并发不串流）
        let output = '';
        let resolveDone: (() => void) | undefined;
        let done = false;

        const unsubscribe = this.agentService.onTurnEvent((event) => {
          try {
            if (event.sessionId !== sessionId) {
              return; // 其他回合/子代理的事件，忽略
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
              // reason 区分：completed → 完成；failed/cancelled → 失败
              const reason = event.reason;
              taskService.update(
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
          // 完成信号：TURN_END / 超时兜底 / 停滞 abort
          const completion = new Promise<void>((resolve) => {
            resolveDone = resolve;
            setTimeout(() => {
              if (!done) {
                done = true;
                logger.warn({ subagent: name, sessionId }, '子代理回合超时');
                taskService.update(taskId, TaskStatus.FAILED);
                resolve();
              }
            }, SUBAGENT_TIMEOUT_MS);
            // 停滞 abort：真实中断回合（agentService.abort）+ 本次尝试失败
            signal.addEventListener('abort', () => {
              if (!done) {
                done = true;
                taskService.update(taskId, TaskStatus.FAILED);
                this.agentService.abort(sessionId);
                resolve();
              }
            });
          });

          await this.agentService.startAgent({
            messages: [{ role: 'user', content: task }],
            sessionId,
            workingDir,
            systemPrompt: spec.prompt,
            maxSteps: spec.maxSteps ?? 15,
            // 无头：不传 webContents
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
   * 注册自定义子代理（覆盖同名；扩展用）
   */
  register(spec: SubagentSpec): void {
    this.specs.set(spec.name, spec);
  }
}

/** 模块级单例（由 ServiceContainer 初始化注入） */
let manager: SubagentManager | null = null;

/**
 * 初始化子代理管理器（ServiceContainer 调用；幂等）
 */
export function initSubagentManager(agentService: IAgentService): SubagentManager {
  if (manager === null) {
    manager = new SubagentManager(agentService);
  }
  return manager;
}

/**
 * 获取子代理管理器（run_subagent 工具注册时调用）
 */
export function getSubagentManager(): SubagentManager {
  if (manager === null) {
    throw new Error('SubagentManager 未初始化（请先调用 initSubagentManager）');
  }
  return manager;
}
