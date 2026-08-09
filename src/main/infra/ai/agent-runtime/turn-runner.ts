// src/main/infra/ai/agent-runtime/turn-runner.ts
// 回合执行器（TurnRunner）：读流 → 翻译 → 事件产出 → 回合统计
// ──────────────────────────────────────────────────────────────
// 职责：
// - 消费 streamText 的 UIMessageStream，逐 part 翻译为 TurnEvent 并 emit
// - 回合统计：耗时、终止原因（completed / aborted）
// - 流空闲超时守卫（复用 stream-reader）
//
// 设计（对齐 qwen AgentCore.runReasoningLoop 的收敛子集）：
// - 不感知 webContents / DB：事件经 TurnEventEmitter 产出，由订阅方推送/落库
// - 中断（AbortError）归为 reason='aborted'，其余错误抛出由上层分类
// - usage（token 统计）来自 streamText 结果对象（上层持有），本层不重复采集
// ──────────────────────────────────────────────────────────────

import type { TurnToolCallEvent } from '@code-agent/shared/main';
import { TurnEventType } from '@code-agent/shared/main';
import { isAbortError } from '../tools/error-classifier';
import { readTracker } from '../tools/read-tracker';
import { LoopDetector } from './loop-detector';
import { DEFAULT_STREAM_IDLE_TIMEOUT_MS, readWithIdleTimeout } from './stream-reader';
import type { TurnEventEmitter } from './turn-emitter';
import type { StreamPart } from './turn-translator';
import { translatePart } from './turn-translator';

/**
 * TurnRunner 构造参数
 */
export interface TurnRunnerOptions {
  readonly sessionId: string;
  /** 回合唯一 id（由调用方生成） */
  readonly turnId: string;
  /** 本次回合使用的模型 id（turn-start 事件携带） */
  readonly modelId: string;
  /** 中断控制器（abort 归为 reason='aborted'；超时也会触发 abort） */
  readonly controller: AbortController;
  /** 事件产出目标（订阅方负责推送/落库） */
  readonly emitter: TurnEventEmitter;
  /** 流空闲超时毫秒数（默认 10 分钟） */
  readonly idleTimeoutMs?: number;
  /**
   * 原始 part 回调（读流时每个 part 先回调再翻译）
   *
   * 用途：上层推送 AGENT_STREAM_PART 等原始通道（本层不感知传输目标）。
   * 注意：类型是领域投影（编译期裁剪），运行时对象为 SDK 完整 part，透传无损。
   */
  readonly onPart?: (part: StreamPart) => void;
  /**
   * 预读的首个 part（请求级重试链路：首读在重试内完成，此处接续）
   *
   * 语义：与循环内 read 结果相同——{ done: true } 或 { done: false, value: part }。
   * 提供时回合先处理该 part 再继续循环读流。
   */
  readonly firstPart?: { done: boolean; value?: unknown };
}

/**
 * 回合执行结果（turn-end 的统计输入）
 */
export interface TurnRunResult {
  /** 终止原因：completed 正常结束 / aborted 用户中断 */
  readonly reason: 'completed' | 'aborted';
  /** 回合总耗时（毫秒） */
  readonly durationMs: number;
}

/**
 * 回合执行器
 *
 * 无状态单次执行：构造后调用 run() 消费一个流。
 * 每次 agent:run 一个实例（与回合事件生命周期一致）。
 */
export class TurnRunner {
  private readonly options: TurnRunnerOptions;
  private readonly startTime: number;

  constructor(options: TurnRunnerOptions) {
    this.options = options;
    this.startTime = Date.now();
  }

  /**
   * 执行回合：读流 → 翻译 → emit → 统计
   *
   * @param stream streamText 的 toUIMessageStream() 产物
   * @returns 回合执行结果（completed/aborted + 耗时）
   * @throws 非中断错误（含流空闲超时 AI_TIMEOUT）由上层分类处理
   */
  async run(
    stream: ReadableStream<unknown>,
    reader?: ReadableStreamDefaultReader<unknown>,
  ): Promise<TurnRunResult> {
    // turn-start：模型已选定，回合开始
    this.options.emitter.emit({
      type: TurnEventType.TURN_START,
      sessionId: this.options.sessionId,
      turnId: this.options.turnId,
      timestamp: Date.now(),
      modelId: this.options.modelId,
    });

    // 请求级重试链路：上层已持有 reader（首 part 预读）时复用，避免重复 getReader
    const activeReader = reader ?? stream.getReader();
    // 回合循环检测（对齐 qwen loopDetection）：连续相同工具调用/文件读取超阈值终止
    const loopDetector = new LoopDetector();
    try {
      // 请求级重试链路：首 part 已由上层预读（重试内完成），此处接续处理
      if (this.options.firstPart !== undefined) {
        const done = this.options.firstPart.done;
        const value = this.options.firstPart.value;
        if (!done && value !== undefined) {
          this.options.onPart?.(value as StreamPart);
          const translated = translatePart(value as StreamPart, {
            sessionId: this.options.sessionId,
            turnId: this.options.turnId,
            timestamp: Date.now(),
          });
          if (translated !== null) {
            this.options.emitter.emit(translated);
          }
        }
        if (done) {
          return { reason: 'completed', durationMs: Date.now() - this.startTime };
        }
      }
      while (true) {
        const { done, value } = await readWithIdleTimeout(
          activeReader,
          this.options.controller,
          this.options.idleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS,
        );
        if (done) {
          break;
        }
        // 原始 part 回调（上层推送原始通道，运行时对象完整）
        this.options.onPart?.(value as StreamPart);
        // part → 领域事件（text-delta / tool-call；其余由上层处理）
        const translated = translatePart(value as StreamPart, {
          sessionId: this.options.sessionId,
          turnId: this.options.turnId,
          timestamp: Date.now(),
        });
        if (translated !== null) {
          // 循环检测：tool-call 事件记录（同 name + 同入参连续超阈值抛 LoopDetectedError）
          if (translated.type === TurnEventType.TOOL_CALL) {
            const toolCall = translated as TurnToolCallEvent;
            loopDetector.recordToolCall(toolCall.toolName, JSON.stringify(toolCall.input ?? {}));
          }
          this.options.emitter.emit(translated);
        }
      }
      return { reason: 'completed', durationMs: Date.now() - this.startTime };
    } catch (error) {
      // 用户中断：归为 aborted（不视为错误，由上层推送 END(aborted)）
      if (isAbortError(error)) {
        return { reason: 'aborted', durationMs: Date.now() - this.startTime };
      }
      // 其他错误（含流空闲超时 AI_TIMEOUT）：抛出，由上层分类 + 产出 error 事件
      throw error;
    } finally {
      // 回合终态：清理本会话已读文件记录（priorReadEnforcement 防跨回合累积）
      readTracker.clearSession(this.options.sessionId);
    }
  }
}
