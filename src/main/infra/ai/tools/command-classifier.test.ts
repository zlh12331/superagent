// src/main/infra/ai/command-classifier.test.ts
// 命令分类器单测：safe/dangerous/unknown（fail-closed）/ 缓存

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
    // 第二次命中缓存：LLM 只调用一次
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
    // 填满缓存（CACHE_LIMIT=200，与实现私有常量对齐）
    for (let i = 0; i < 200; i += 1) {
      await classifier.classify(`cmd-${i}`);
    }
    const generateJson = fake.generateJson as ReturnType<typeof vi.fn>;
    generateJson.mockClear();
    // 达限后再写入：最旧条目（cmd-0）被逐出，较新条目仍保留
    await classifier.classify('cmd-new');
    generateJson.mockClear(); // cmd-new 自身的判定不计入后续断言
    await classifier.classify('cmd-0');
    expect(generateJson).toHaveBeenCalledTimes(1); // cmd-0 已被逐出 → 重新判定
    await classifier.classify('cmd-2');
    expect(generateJson).toHaveBeenCalledTimes(1); // cmd-2 仍命中缓存 → 未整体清空
    // （重新判定 cmd-0 时逐出的是当时的次旧 cmd-1，故探针取 cmd-2）
  });
});
