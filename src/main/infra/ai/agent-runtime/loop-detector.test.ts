// src/main/infra/ai/agent-runtime/loop-detector.test.ts
// LoopDetector 单测：回合循环检测（安全关键——防止无限循环消耗 token）
//
// 测试要点：
// 1. 连续相同工具调用（同 name + 同入参）≥5 → LoopDetectedError
// 2. 阈值边界（4 次不抛）
// 3. 入参/工具名变化 → 重置 streak
// 4. 连续相同文件读取 ≥15 → LoopDetectedError（阈值放宽）
// 5. reset() 后重新计数

import { ErrorCode } from '@code-agent/shared/main';
import { describe, expect, it } from 'vitest';

import { LoopDetectedError, LoopDetector } from './loop-detector';

describe('LoopDetector.recordToolCall', () => {
  it('连续相同工具调用 5 次 → 抛 LoopDetectedError', () => {
    const detector = new LoopDetector();
    for (let i = 0; i < 4; i += 1) {
      detector.recordToolCall('read_file', '{"path":"a.ts"}');
    }
    expect(() => detector.recordToolCall('read_file', '{"path":"a.ts"}')).toThrow(
      LoopDetectedError,
    );
  });

  it('阈值边界：4 次不抛（第 5 次才触发）', () => {
    const detector = new LoopDetector();
    for (let i = 0; i < 4; i += 1) {
      expect(() => detector.recordToolCall('grep', '{"pattern":"x"}')).not.toThrow();
    }
  });

  it('错误码为 AI_LOOP_DETECTED（agent-service 据此终止回合）', () => {
    const detector = new LoopDetector();
    for (let i = 0; i < 5; i += 1) {
      try {
        detector.recordToolCall('edit_file', '{"path":"a.ts"}');
      } catch (error) {
        expect(error).toMatchObject({ code: ErrorCode.AI_LOOP_DETECTED });
        return;
      }
    }
    throw new Error('应已抛出 LoopDetectedError');
  });

  it('入参变化 → 重置 streak（不误判）', () => {
    const detector = new LoopDetector();
    for (let i = 0; i < 4; i += 1) {
      detector.recordToolCall('read_file', '{"path":"a.ts"}');
    }
    // 入参变化：重新计数（此前 4 次作废）
    for (let i = 0; i < 4; i += 1) {
      detector.recordToolCall('read_file', '{"path":"b.ts"}');
    }
    // 新入参 streak 已到 4：第 5 次同入参才抛
    expect(() => detector.recordToolCall('read_file', '{"path":"b.ts"}')).toThrow(
      LoopDetectedError,
    );
  });

  it('工具名变化 → 重置 streak', () => {
    const detector = new LoopDetector();
    for (let i = 0; i < 4; i += 1) {
      detector.recordToolCall('read_file', '{"path":"a.ts"}');
    }
    detector.recordToolCall('grep', '{"pattern":"x"}');
    expect(() => detector.recordToolCall('grep', '{"pattern":"x"}')).not.toThrow();
  });
});

describe('LoopDetector.recordFileRead', () => {
  it('连续相同路径读取 15 次 → 抛 LoopDetectedError（阈值放宽）', () => {
    const detector = new LoopDetector();
    for (let i = 0; i < 14; i += 1) {
      detector.recordFileRead('/repo/src/main.ts');
    }
    expect(() => detector.recordFileRead('/repo/src/main.ts')).toThrow(LoopDetectedError);
  });

  it('14 次不抛（边界）', () => {
    const detector = new LoopDetector();
    for (let i = 0; i < 14; i += 1) {
      expect(() => detector.recordFileRead('/repo/package.json')).not.toThrow();
    }
  });

  it('路径变化 → 重置 streak', () => {
    const detector = new LoopDetector();
    for (let i = 0; i < 14; i += 1) {
      detector.recordFileRead('/repo/a.ts');
    }
    detector.recordFileRead('/repo/b.ts');
    expect(() => detector.recordFileRead('/repo/b.ts')).not.toThrow();
  });
});

describe('LoopDetector.reset', () => {
  it('reset 后重新计数（回合间复用同一实例）', () => {
    const detector = new LoopDetector();
    for (let i = 0; i < 4; i += 1) {
      detector.recordToolCall('read_file', '{"path":"a.ts"}');
    }
    detector.reset();
    for (let i = 0; i < 4; i += 1) {
      expect(() => detector.recordToolCall('read_file', '{"path":"a.ts"}')).not.toThrow();
    }
  });
});
