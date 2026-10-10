// loop-detector.ts：Agent 死循环检测——连续相同工具调用 / 连续读同一文件超阈值即抛错终止回合
import { AppError, ErrorCode } from '@code-agent/shared/main';

// 工具连续 5 次（同入参）或同文件连读 15 次：模型抽风但用户文件可能确实需要多次读——阈值留了余量
const TOOL_CALL_LOOP_THRESHOLD = 5;
const FILE_READ_LOOP_THRESHOLD = 15;

/** 循环检测错误（AI_LOOP_DETECTED 码——渲染层可按此提示「检测到循环已终止」） */
export class LoopDetectedError extends AppError {
  constructor(detail: string) {
    super(ErrorCode.AI_LOOP_DETECTED, `检测到回合循环：${detail}`, undefined);
    this.name = 'LoopDetectedError';
  }
}

/** 死循环检测器：每回合一个实例（reset 清 streak）；record* 命中阈值直接抛 */
export class LoopDetector {
  private lastToolCall: { name: string; inputHash: string } | null = null;
  private toolCallStreak = 0;
  private lastReadPath: string | null = null;
  private readStreak = 0;

  reset(): void {
    this.lastToolCall = null;
    this.toolCallStreak = 0;
    this.lastReadPath = null;
    this.readStreak = 0;
  }

  recordToolCall(name: string, inputJson: string): void {
    if (
      this.lastToolCall !== null &&
      this.lastToolCall.name === name &&
      this.lastToolCall.inputHash === inputJson
    ) {
      this.toolCallStreak += 1;
    } else {
      this.lastToolCall = { name, inputHash: inputJson };
      this.toolCallStreak = 1;
    }
    if (this.toolCallStreak >= TOOL_CALL_LOOP_THRESHOLD) {
      throw new LoopDetectedError(`工具 ${name} 连续调用 ${this.toolCallStreak} 次且入参相同`);
    }
  }

  recordFileRead(path: string): void {
    if (this.lastReadPath === path) {
      this.readStreak += 1;
    } else {
      this.lastReadPath = path;
      this.readStreak = 1;
    }
    if (this.readStreak >= FILE_READ_LOOP_THRESHOLD) {
      throw new LoopDetectedError(`文件 ${path} 连续读取 ${this.readStreak} 次`);
    }
  }
}
