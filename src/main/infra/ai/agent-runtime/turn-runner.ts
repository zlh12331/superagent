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
   * 用途：上层推送 agent:stream:part 等原始通道（meta.ts subscribeStreamPart；
   * 宿主经 createTurnPartForwarder 合帧后推送，本层不感知传输目标）。
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
  /**
   * 模型级超时归因回调（combinedAbortSignals 把超时与用户中断都折叠成 abort；
   * 返回 true 时中断被归因为 reason='timeout' 而非 'aborted'——二者出口不同：
   * timeout 走错误出口 finalizeErrorTurn，aborted 走中断出口 completeTurn）
   *
   * 生产接线现实：turn-assembly 仅当模型配置 generationConfig.timeoutMs 才注入
   * 本回调——生产常态未配置（模型条目无此字段，已登记待补数据源），此时超时
   * abort 会归为 'aborted'；真实可达的超时保护是流空闲超时（AI_TIMEOUT，走抛错）。
   */
  readonly isTimeout?: () => boolean;
}

/**
 * 回合执行结果（turn-end 的统计输入）
 */
export interface TurnRunResult {
  /** 终止原因：completed 正常结束 / aborted 用户中断 / timeout 模型级总时长超时 */
  readonly reason: 'completed' | 'aborted' | 'timeout';
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
