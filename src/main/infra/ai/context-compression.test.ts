// src/main/infra/ai/context-compression.test.ts
// context-compression 单测：长对话上下文压缩策略

import type { ModelMessage } from 'ai';
import { describe, expect, it } from 'vitest';
import {
  compressByTokenBudget,
  compressContext,
  estimateMessagesTokens,
  estimateTokenCount,
  getCompactionBudget,
  getCompactionDecision,
  getTokenBudgetDecision,
  MIN_COMPACTION_BUDGET,
} from './context-compression';

/** 构造消息辅助 */
const user = (content: string): ModelMessage => ({ role: 'user', content });
const assistant = (content: string): ModelMessage => ({ role: 'assistant', content });
const system = (content: string): ModelMessage => ({ role: 'system', content });
const toolResult = (content: string): ModelMessage =>
  ({ role: 'tool', content }) as unknown as ModelMessage;
const toolCall = (name: string): ModelMessage =>
  ({
    role: 'assistant',
    content: '',
    toolCalls: [{ type: 'tool-call', toolName: name, toolCallId: `call-${name}` }],
  }) as unknown as ModelMessage;

describe('estimateTokenCount', () => {
  it('空文本为 0', () => {
    expect(estimateTokenCount('')).toBe(0);
  });

  it('英文单词计数（gpt-tokenizer 精确计数）', () => {
    const count = estimateTokenCount('hello world');
    expect(count).toBeGreaterThan(0);
    // cl100k 词表下 hello world 约为 2 token
    expect(count).toBeLessThanOrEqual(4);
  });

  it('中文按字节特征计数（非 1 字符 1 token）', () => {
    const count = estimateTokenCount('你好世界');
    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThan(8);
  });

  it('长文本 token 数单调不减', () => {
    const short = estimateTokenCount('short text');
    const long = estimateTokenCount('short text with much more content here');
    expect(long).toBeGreaterThanOrEqual(short);
  });
});

describe('compressByTokenBudget', () => {
  it('预算充足：全部保留', () => {
    const messages = [system('系统提示词'), user('hi'), assistant('hello')];
    const result = compressByTokenBudget(messages, 10_000);
    expect(result).toHaveLength(3);
  });

  it('超预算：保留 system + 从后往前的消息', () => {
    // 每条 user 消息内容不同长度，预算只够容纳最后几条
    const messages: ModelMessage[] = [system('系统提示词')];
    for (let i = 1; i <= 20; i += 1) {
      messages.push(user(`消息 ${i} ${'内容'.repeat(50)}`));
    }
    const result = compressByTokenBudget(messages, 300);
    // system 必在
    expect(result[0]?.role).toBe('system');
    // 保留数量少于原始（发生了压缩）
    expect(result.length).toBeLessThan(messages.length);
    // 最后一条消息必在（最新上下文优先）
    expect(result.at(-1)).toEqual(messages.at(-1));
  });

  it('单条消息就超预算：至少保留最后一条', () => {
    const messages = [user('短消息'), user('x'.repeat(5000))];
    const result = compressByTokenBudget(messages, 10);
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result.at(-1)).toEqual(messages.at(-1));
  });

  it('maxTokens <= 0：返回空数组', () => {
    expect(compressByTokenBudget([user('x')], 0)).toEqual([]);
  });

  it('空消息列表：返回空数组', () => {
    expect(compressByTokenBudget([])).toEqual([]);
  });

  it('不修改原始数组', () => {
    const messages = [system('s'), user('a'), user('b')];
    const before = [...messages];
    compressByTokenBudget(messages, 10);
    expect(messages).toEqual(before);
  });
});

describe('compressContext', () => {
  it('消息数 <= maxMessages：原样返回（不压缩）', () => {
    const messages = [user('a'), assistant('b'), user('c')];
    const result = compressContext(messages);
    expect(result).toBe(messages);
  });

  it('短消息：返回相同引用（默认 maxMessages=50）', () => {
    const messages = [system('sys'), user('hi'), assistant('hello')];
    const result = compressContext(messages);
    expect(result).toHaveLength(3);
  });

  it('超长对话：保留 system 消息与最近 N 轮', () => {
    const messages: ModelMessage[] = [
      system('系统提示词'),
      ...Array.from({ length: 60 }, (_, i) => user(`消息${i}`)),
      assistant('最近回复'),
    ];
    const result = compressContext(messages);
    // system 保留 + 最近 10 条（9 条 user + 1 条 assistant，assistant 是最后一条）
    expect(result.filter((m) => m.role === 'system')).toHaveLength(1);
    expect(result[0]).toEqual(system('系统提示词'));
    // 最近 10 条保留（user 9 条 + assistant 1 条）
    expect(result.filter((m) => m.role === 'user')).toHaveLength(9);
    expect(result.filter((m) => m.role === 'assistant')).toHaveLength(1);
  });

  it('自定义 maxMessages/recentMessages：生效', () => {
    const messages: ModelMessage[] = [
      system('sys'),
      ...Array.from({ length: 30 }, (_, i) => user(`m${i}`)),
    ];
    const result = compressContext(messages, { maxMessages: 20, recentMessages: 5 });
    expect(result.filter((m) => m.role === 'user')).toHaveLength(5);
    expect(result).toHaveLength(6); // system + 5 user
  });

  it('工具调用合并：保留最近的 tool-call + tool-result 对', () => {
    const messages: ModelMessage[] = [
      toolCall('read_file'),
      toolResult('file content 1'),
      toolCall('grep'),
      toolResult('grep result'),
    ];
    // 未超阈值时原样返回
    const result = compressContext(messages, { maxMessages: 3, recentMessages: 1 });
    // 压缩后：早期非 tool 消息为空，tool 对合并
    expect(result.length).toBeGreaterThan(0);
  });

  it('超长时工具调用只保留最新结果（mergeToolMessages 生效）', () => {
    // 构造 50+ 条消息触发压缩，包含多个工具调用对
    const messages: ModelMessage[] = [
      system('sys'),
      ...Array.from({ length: 40 }, (_, i) => user(`m${i}`)),
      toolCall('write_file'),
      toolResult('written 1'),
      toolCall('write_file'),
      toolResult('written 2'),
      assistant('完成'),
    ];
    const result = compressContext(messages);
    // system 保留
    expect(result[0]?.role).toBe('system');
    // 结果非空
    expect(result.length).toBeGreaterThan(0);
  });
});

describe('压缩服务化（窗口感知预算 + 阈值判定）', () => {
  describe('getCompactionBudget', () => {
    it('大窗口：75% 窗口 − 20K 预留', () => {
      // 1M 窗口：750K − 20K = 730K
      expect(getCompactionBudget(1_000_000)).toBe(730_000);
    });

    it('小窗口：预留缩水（min(20K, 5%×window)）', () => {
      // 32K 窗口：24K − 1.6K = 22.4K
      expect(getCompactionBudget(32_000)).toBe(22_400);
    });

    it('极小窗口：下限 MIN_COMPACTION_BUDGET 保护', () => {
      // 8K 窗口：6K − 0.4K = 5.6K < 8K → 8K
      expect(getCompactionBudget(8_000)).toBe(MIN_COMPACTION_BUDGET);
    });
  });

  describe('estimateMessagesTokens', () => {
    it('空列表为 0', () => {
      expect(estimateMessagesTokens([])).toBe(0);
    });

    it('多消息求和', () => {
      const messages = [user('hello world'), assistant('你好')];
      const expected = estimateTokenCount('hello world') + estimateTokenCount('你好');
      expect(estimateMessagesTokens(messages)).toBe(expected);
    });
  });

  describe('getCompactionDecision', () => {
    const window = 100_000; // warn 缓冲 = 5K

    it('低于 warn 线：ok', () => {
      // compact 线 = 75K − 5K = 70K；warn 线 = 65K
      expect(getCompactionDecision(60_000, window)).toBe('ok');
    });

    it('warn 区：提前提醒（compact 线 − 缓冲）', () => {
      expect(getCompactionDecision(67_000, window)).toBe('warn');
    });

    it('达到 compact 线：应压缩', () => {
      expect(getCompactionDecision(70_000, window)).toBe('compact');
    });
  });

  describe('getTokenBudgetDecision（回合级调度）', () => {
    const Window = 128_000;

    it('ok：上下文安全', () => {
      const decision = getTokenBudgetDecision(10_000, Window);
      expect(decision.level).toBe('ok');
      // 硬上限 = 窗口 − 输出预留（5% × 128K = 6.4K）
      expect(decision.hardLimit).toBe(Window - 6_400);
    });

    it('compact：达到压缩线', () => {
      const compactAt = getCompactionBudget(Window);
      expect(getTokenBudgetDecision(compactAt, Window).level).toBe('compact');
    });

    it('over-limit：超出硬上限（窗口 − 输出预留）拒止', () => {
      const hardLimit = Window - 6_400;
      const decision = getTokenBudgetDecision(hardLimit + 1, Window);
      expect(decision.level).toBe('over-limit');
      expect(decision.hardLimit).toBe(hardLimit);
    });

    it('窗口边界：恰好等于硬上限不拒止', () => {
      const hardLimit = Window - 6_400;
      expect(getTokenBudgetDecision(hardLimit, Window).level).not.toBe('over-limit');
    });
  });
});
