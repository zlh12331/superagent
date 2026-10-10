import { describe, expect, it, vi } from 'vitest';
import type { LlmClient } from '../llm-client';
import { CommandClassifier } from './command-classifier';

/** fake LlmClient（手写最小实现，符合无 mock 原则的 fake 注入） */
function createFakeLlm(output: unknown, throwError = false): LlmClient {
  return {
    generateJson: vi.fn(async () => {
      if (throwError) {
        throw new Error('API 不可用');
      }
      return output;
    }),
  } as unknown as LlmClient;
}

describe('CommandClassifier', () => {
  it('safe 判定：verdict=safe', async () => {
    const classifier = new CommandClassifier(createFakeLlm({ safe: true, reason: '只读查询' }));
    const result = await classifier.classify('git log --oneline');
    expect(result.verdict).toBe('safe');
    expect(result.reason).toBe('只读查询');
  });

  it('dangerous 判定：verdict=dangerous', async () => {
    const classifier = new CommandClassifier(createFakeLlm({ safe: false, reason: '删除数据' }));
    const result = await classifier.classify('rm -rf /data');
    expect(result.verdict).toBe('dangerous');
  });

  it('fail-closed：API 失败 → unknown（必拦）', async () => {
    const classifier = new CommandClassifier(createFakeLlm(null, true));
    const result = await classifier.classify('some command');
    expect(result.verdict).toBe('unknown');
  });

  it('缓存：同命令重复分类不重复调用 LLM', async () => {
    const fake = createFakeLlm({ safe: true, reason: '安全' });
    const classifier = new CommandClassifier(fake);
    await classifier.classify('git status');
    await classifier.classify('git status');
    const generateJson = fake.generateJson as ReturnType<typeof vi.fn>;
    expect(generateJson).toHaveBeenCalledTimes(1);
  });

  it('clearCache：清空后重新调用 LLM', async () => {
    const fake = createFakeLlm({ safe: true, reason: '安全' });
    const classifier = new CommandClassifier(fake);
    await classifier.classify('git status');
    classifier.clearCache();
    await classifier.classify('git status');
    const generateJson = fake.generateJson as ReturnType<typeof vi.fn>;
    expect(generateJson).toHaveBeenCalledTimes(2);
  });

  it('缓存达限：淘汰最旧而非整体清空', async () => {
    const fake = createFakeLlm({ safe: true, reason: '安全' });
    const classifier = new CommandClassifier(fake);
    for (let i = 0; i < 200; i += 1) {
      await classifier.classify(`cmd-${i}`);
    }
    const generateJson = fake.generateJson as ReturnType<typeof vi.fn>;
    generateJson.mockClear();
    await classifier.classify('cmd-new');
    generateJson.mockClear();
    await classifier.classify('cmd-0');
    expect(generateJson).toHaveBeenCalledTimes(1);
    await classifier.classify('cmd-2');
    expect(generateJson).toHaveBeenCalledTimes(1);
  });
});
