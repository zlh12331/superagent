import { AppError, ErrorCode } from '@code-agent/shared/main';

/** 连续相同工具调用阈值（同 name + 同入参；低于服务端重复调用拒绝阈值） */
const TOOL_CALL_LOOP_THRESHOLD = 5;
/** 连续相同文件读取阈值（合法场景常连续读文件，阈值放宽） */
const FILE_READ_LOOP_THRESHOLD = 15;

/** 循环检测错误（agent-service 分类为 AI_LOOP_DETECTED 回合终止） */
export class LoopDetectedError extends AppError {
  constructor(detail: string) {
    super(ErrorCode.AI_LOOP_DETECTED, `检测到回合循环：${detail}`, undefined);
    this.name = 'LoopDetectedError';
  }
}

/** 单回合循环检测器 */
export class LoopDetector {
  private lastToolCall: { name: string; inputHash: string } | null = null;
  private toolCallStreak = 0;
  private lastReadPath: string | null = null;
  private readStreak = 0;

  /** 重置（回合开始调用） */
  reset(): void {
    this.lastToolCall = null;
    this.toolCallStreak = 0;
    this.lastReadPath = null;
    this.readStreak = 0;
  }

  /**
   * 记录一次工具调用；连续相同（name + 入参 JSON）超阈值抛 LoopDetectedError
   *
   * @param name 工具名
   * @param inputJson 入参 JSON 字符串（哈希源）
   */
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

  /**
   * 记录一次文件读取；连续相同路径超阈值抛 LoopDetectedError
   */
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
