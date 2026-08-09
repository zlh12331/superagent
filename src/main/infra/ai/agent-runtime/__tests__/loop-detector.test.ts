// src/main/infra/ai/agent-runtime/__tests__/loop-detector.test.ts
// 回合循环检测单测（真实实现，无 mock）
// ──────────────────────────────────────────────────────────────
// 覆盖：
// - 连续相同工具调用 ≥5 → 抛 LoopDetectedError（AI_LOOP_DETECTED）
// - 中间插入不同调用 → 计数重置（不误报）
// - 连续相同文件读取 ≥15 → 抛 LoopDetectedError
// - 不同文件读取 → 不触发
// - reset 后计数清零
// ──────────────────────────────────────────────────────────────

import { ErrorCode } from '@code-agent/shared/main';
import { describe, expect, it } from 'vitest';
import { LoopDetectedError, LoopDetector } from '../loop-detector';

describe('LoopDetector', () => {
  it('连续相同工具调用 5 次抛 LoopDetectedError（AI_LOOP_DETECTED）', () => {
    const detector = new LoopDetector();
    detector.recordToolCall('read_file', '{"path":"a.ts"}');
    detector.recordToolCall('read_file', '{"path":"a.ts"}');
    detector.recordToolCall('read_file', '{"path":"a.ts"}');
    detector.recordToolCall('read_file', '{"path":"a.ts"}');
    expect(() => detector.recordToolCall('read_file', '{"path":"a.ts"}')).toThrow(
      LoopDetectedError,
    );
    try {
      detector.recordToolCall('read_file', '{"path":"a.ts"}');
    } catch (error) {
      expect((error as LoopDetectedError).code).toBe(ErrorCode.AI_LOOP_DETECTED);
    }
  });

  it('入参不同不触发循环（计数按 name+入参重置）', () => {
    const detector = new LoopDetector();
    expect(() => {
      for (let i = 0; i < 6; i += 1) {
        detector.recordToolCall('read_file', `{"path":"a${i}.ts"}`);
      }
    }).not.toThrow();
  });

  it('相同工具名不同入参打断连续计数', () => {
    const detector = new LoopDetector();
    expect(() => {
      detector.recordToolCall('grep', '{"q":"x"}');
      detector.recordToolCall('grep', '{"q":"x"}');
      detector.recordToolCall('grep', '{"q":"y"}');
      detector.recordToolCall('grep', '{"q":"x"}');
      detector.recordToolCall('grep', '{"q":"x"}');
      detector.recordToolCall('grep', '{"q":"x"}');
      // 中断后重新计数：3 次连续相同，未达 5
    }).not.toThrow();
  });

  it('连续相同文件读取 15 次抛 LoopDetectedError（阈值放宽）', () => {
    const detector = new LoopDetector();
    for (let i = 0; i < 14; i += 1) {
      detector.recordFileRead('/repo/big.ts');
    }
    expect(() => detector.recordFileRead('/repo/big.ts')).toThrow(LoopDetectedError);
  });

  it('不同文件读取不触发', () => {
    const detector = new LoopDetector();
    expect(() => {
      for (let i = 0; i < 20; i += 1) {
        detector.recordFileRead(`/repo/f${i}.ts`);
      }
    }).not.toThrow();
  });

  it('reset 后计数清零（回合复用）', () => {
    const detector = new LoopDetector();
    detector.recordToolCall('read_file', '{"path":"a.ts"}');
    detector.recordToolCall('read_file', '{"path":"a.ts"}');
    detector.reset();
    expect(() => {
      detector.recordToolCall('read_file', '{"path":"a.ts"}');
      detector.recordToolCall('read_file', '{"path":"a.ts"}');
      detector.recordToolCall('read_file', '{"path":"a.ts"}');
      detector.recordToolCall('read_file', '{"path":"a.ts"}');
      // reset 后从 1 重新计数：当前 4 次连续，未达 5
    }).not.toThrow();
  });
});
