// turn-runner.ts：回合流消费器——读模型流逐 part 翻译为事件（过循环检测），产出结束原因与耗时
// 38 号拆分：本类只管「读流→翻译→发事件」，决策/审批在 agent-turn-machine
import type { TurnToolCallEvent } from '@code-agent/shared/main';
import { TurnEventType } from '@code-agent/shared/main';
import { isAbortError } from '../tools/error-classifier';
import { readTracker } from '../tools/read-tracker';
import { LoopDetector } from './loop-detector';
import { DEFAULT_STREAM_IDLE_TIMEOUT_MS, readWithIdleTimeout } from './stream-reader';
import type { TurnEventEmitter } from './turn-emitter';
import type { StreamPart } from './turn-translator';
import { translatePart } from './turn-translator';

/** 回合流参数：firstPart 为调用方已抢读的首 part（38 号时序坑——流已被读一格） */
export interface TurnRunnerOptions {
  readonly sessionId: string;
  readonly turnId: string;
  readonly modelId: string;
  readonly controller: AbortController;
  readonly emitter: TurnEventEmitter;
  readonly idleTimeoutMs?: number;
  readonly onPart?: (part: StreamPart) => void;
  readonly firstPart?: { done: boolean; value?: unknown };
  readonly isTimeout?: () => boolean;
}

export interface TurnRunResult {
  readonly reason: 'completed' | 'aborted' | 'timeout';
  readonly durationMs: number;
}

/**
 * 回合执行器：逐 part 读取（带空闲超时）→ 翻译 → 发事件；tool_call 过循环检测；
 * AbortError 按 isTimeout 判据分流 timeout/aborted；finally 清会话读计数器
 */
export class TurnRunner {
  private readonly options: TurnRunnerOptions;
  private readonly startTime: number;

  constructor(options: TurnRunnerOptions) {
    this.options = options;
    this.startTime = Date.now();
  }

  async run(
    stream: ReadableStream<unknown>,
    reader?: ReadableStreamDefaultReader<unknown>,
  ): Promise<TurnRunResult> {
    this.options.emitter.emit({
      type: TurnEventType.TURN_START,
      sessionId: this.options.sessionId,
      turnId: this.options.turnId,
      timestamp: Date.now(),
      modelId: this.options.modelId,
    });

    const activeReader = reader ?? stream.getReader();
    const loopDetector = new LoopDetector();
    try {
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
        // 空闲超时兜底：模型流挂着不出数据时从这里脱身（10 分钟默认）
        const { done, value } = await readWithIdleTimeout(
          activeReader,
          this.options.controller,
          this.options.idleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS,
        );
        if (done) {
          break;
        }
        this.options.onPart?.(value as StreamPart);
        const translated = translatePart(value as StreamPart, {
          sessionId: this.options.sessionId,
          turnId: this.options.turnId,
          timestamp: Date.now(),
        });
        if (translated !== null) {
          if (translated.type === TurnEventType.TOOL_CALL) {
            const toolCall = translated as TurnToolCallEvent;
            loopDetector.recordToolCall(toolCall.toolName, JSON.stringify(toolCall.input ?? {}));
          }
          this.options.emitter.emit(translated);
        }
      }
      return { reason: 'completed', durationMs: Date.now() - this.startTime };
    } catch (error) {
      if (isAbortError(error)) {
        const reason = this.options.isTimeout?.() === true ? 'timeout' : 'aborted';
        return { reason, durationMs: Date.now() - this.startTime };
      }
      throw error;
    } finally {
      readTracker.clearSession(this.options.sessionId);
    }
  }
}
