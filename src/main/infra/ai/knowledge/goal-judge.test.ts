// src/main/infra/ai/knowledge/goal-judge.test.ts
// 目标判定器单测：LLM 判定映射 + 失败默认 not met（安全）

import { describe, expect, it, vi } from 'vitest';
import type { LlmClient } from '../llm-client';
import { GoalJudge } from './goal-judge';

/** fake LlmClient：generateJson 可配置输出或抛错 */
function createFakeLlm(output?: unknown, throwError = false): LlmClient {
  return {
    generateJson: vi.fn(async () => {
      if (throwError) {
        throw new Error('API 不可用');
      }
      return (
        output ?? {
          met: false,
          reason: '未发现达成证据',
          impossible: false,
        }
      );
    }),
  } as unknown as LlmClient;
}

describe('GoalJudge', () => {
  it('met=true → 判定达成', async () => {
    const llm = createFakeLlm({ met: true, reason: '测试通过', impossible: false });
    const result = await new GoalJudge(llm).judge('修复测试', 'transcript');
    expect(result.met).toBe(true);
    expect(result.impossible).toBe(false);
    expect(result.reason).toBe('测试通过');
  });

  it('impossible=true → 判定不可能（即使 met=false）', async () => {
    const llm = createFakeLlm({ met: false, reason: '依赖不可用', impossible: true });
    const result = await new GoalJudge(llm).judge('x', 't');
    expect(result.met).toBe(false);
    expect(result.impossible).toBe(true);
  });

  it('LLM 失败（抛错）→ 默认 not met + impossible=false（安全），不阻塞', async () => {
    const failing = createFakeLlm(undefined, true);
    const result = await new GoalJudge(failing).judge('x', 't');
    expect(result.met).toBe(false);
    expect(result.impossible).toBe(false);
    // 不抛错给调用方
  });

  it('impossible 缺省（undefined）→ 归一为 false', async () => {
    const llm = createFakeLlm({ met: true, reason: 'ok' });
    const result = await new GoalJudge(llm).judge('y', 't');
    expect(result.impossible).toBe(false);
  });
});
