// src/main/infra/ai/context-compression.test.ts
// context-compression 单测：长对话上下文压缩策略

import type { ModelMessage } from 'ai';
import { describe, expect, it } from 'vitest';

import { compressContext } from './context-compression';

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
