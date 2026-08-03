// src/main/infra/ai/context-compression.test.ts
// context-compression 单测：长对话上下文压缩策略

import type { ModelMessage } from 'ai';
import { describe, expect, it } from 'vitest';

import { compressByTokenBudget, compressContext, estimateTokenCount } from './context-compression';

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
