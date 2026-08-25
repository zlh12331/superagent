// src/main/infra/ai/agent/repair-tool-call.test.ts
// repairToolCall 单测：工具入参校验失败时的自动修复行为
// ──────────────────────────────────────────────────────────────
// 覆盖：
// - InvalidToolInputError → 调用 llmClient.generateText 修复，返回修正 toolCall
// - NoSuchToolError → 不修复，返回 null（工具不存在走 SDK 原逻辑）
// - 修复输出解析失败 / 修复调用失败 → 返回 null（不阻塞主流程）
// - extractRepairedToolCallJson：代码块包裹 / 尾随文本 / 非法 JSON 容错
// ──────────────────────────────────────────────────────────────

import { InvalidToolInputError, NoSuchToolError } from 'ai';
import { describe, expect, it, vi } from 'vitest';

import type { LlmClient } from '../llm-client/llm-client';
import { createRepairToolCall, extractRepairedToolCallJson } from './repair-tool-call';

/** 最小 toolCall 结构（与实现侧 ToolCallLike 对齐） */
interface ToolCallLike {
  readonly type: 'tool-call';
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: string;
}

/** 构造 mock LlmClient（generateText 可控） */
function createMockLlmClient(text?: string): LlmClient {
  const generateText = vi.fn(async () => ({ text: text ?? '{}', usage: undefined }));
  return { generateText } as unknown as LlmClient;
}

/** 基础 toolCall 夹具 */
function baseToolCall(overrides: Partial<{ name: string; input: string }> = {}): ToolCallLike {
  return {
    type: 'tool-call',
    toolCallId: 'call-1',
    toolName: overrides.name ?? 'read_file',
    input: overrides.input ?? '{"path": 123}',
  };
}

describe('extractRepairedToolCallJson', () => {
  it('解析纯 JSON', () => {
    expect(extractRepairedToolCallJson('{"name":"read_file","arguments":{"path":"a.ts"}}')).toEqual(
      { name: 'read_file', arguments: { path: 'a.ts' } },
    );
  });

  it('剥离 ```json 代码块包裹', () => {
    expect(
      extractRepairedToolCallJson('```json\n{"name":"grep","arguments":{"pattern":"x"}}\n```'),
    ).toEqual({ name: 'grep', arguments: { pattern: 'x' } });
  });

  it('剥离 ``` 无语言代码块 + 尾随文本', () => {
    expect(
      extractRepairedToolCallJson(
        'Here is the fix:\n```\n{"name":"glob","arguments":{"pattern":"**/*.ts"}}\n```',
      ),
    ).toEqual({ name: 'glob', arguments: { pattern: '**/*.ts' } });
  });

  it('非法 JSON 返回 null', () => {
    expect(extractRepairedToolCallJson('not json at all')).toBeNull();
  });

  it('结构不符（缺 name）返回 null', () => {
    expect(extractRepairedToolCallJson('{"arguments":{}}')).toBeNull();
  });
});

describe('createRepairToolCall', () => {
  it('InvalidToolInputError → 调用修复，返回修正后的 toolCall（保留 toolCallId）', async () => {
    const llm = createMockLlmClient('{"name":"read_file","arguments":{"path":"/a/b.ts"}}');
    const repair = createRepairToolCall({ llmClient: llm });
    const toolCall = baseToolCall();

    const repaired = await repair({
      toolCall,
      error: new InvalidToolInputError({
        toolName: 'read_file',
        toolInput: '{"path": 123}',
        cause: new Error('expected string, got number'),
      }),
    });

    expect(llm.generateText).toHaveBeenCalledTimes(1);
    expect(repaired).toEqual({
      ...toolCall,
      toolName: 'read_file',
      input: '{"path":"/a/b.ts"}',
    });
  });

  it('NoSuchToolError → 不调用修复，返回 null', async () => {
    const llm = createMockLlmClient();
    const repair = createRepairToolCall({ llmClient: llm });

    const repaired = await repair({
      toolCall: baseToolCall({ name: 'nonexistent' }),
      error: new NoSuchToolError({ toolName: 'nonexistent' }),
    });

    expect(repaired).toBeNull();
    expect(llm.generateText).not.toHaveBeenCalled();
  });

  it('修复输出解析失败 → 返回 null 且不抛错', async () => {
    const llm = createMockLlmClient('this is not json');
    const repair = createRepairToolCall({ llmClient: llm });

    const repaired = await repair({
      toolCall: baseToolCall(),
      error: new InvalidToolInputError({
        toolName: 'read_file',
        toolInput: '{}',
        cause: new Error('bad'),
      }),
    });

    expect(repaired).toBeNull();
  });

  it('修复调用抛错 → 返回 null（不阻塞主流程）', async () => {
    const generateText = vi.fn(async () => {
      throw new Error('provider down');
    });
    const llm = { generateText } as unknown as LlmClient;
    const repair = createRepairToolCall({ llmClient: llm });

    const repaired = await repair({
      toolCall: baseToolCall(),
      error: new InvalidToolInputError({
        toolName: 'read_file',
        toolInput: '{}',
        cause: new Error('bad'),
      }),
    });

    expect(repaired).toBeNull();
  });

  it('透传 modelId / signal / maxAttempts 到 generateText', async () => {
    const generateText = vi.fn(async () => ({
      text: '{"name":"x","arguments":{}}',
      usage: undefined,
    }));
    const llm = { generateText } as unknown as LlmClient;
    const signal = new AbortController().signal;
    const repair = createRepairToolCall({ llmClient: llm, modelId: 'deepseek-chat', signal });

    await repair({
      toolCall: baseToolCall(),
      error: new InvalidToolInputError({
        toolName: 'read_file',
        toolInput: '{}',
        cause: new Error('bad'),
      }),
    });

    expect(generateText).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'deepseek-chat',
        signal,
        maxAttempts: 1,
      }),
    );
  });
});
