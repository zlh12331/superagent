// src/main/infra/ai/agent-runtime/turn-transcript.test.ts
// 回合转录 → 落库消息构造（纯函数测试，无 mock）

import { describe, expect, it } from 'vitest';
import {
  buildAssistantTurnMessages,
  MAX_PERSISTED_TOOL_OUTPUT_BYTES,
  type TurnTranscriptEntry,
  toPersistedOutput,
} from './turn-transcript';

describe('buildAssistantTurnMessages', () => {
  it('纯文本回合：仅返回一条 assistant 消息（text part）', () => {
    const messages = buildAssistantTurnMessages('你好', []);
    expect(messages).toEqual([{ role: 'assistant', content: [{ type: 'text', text: '你好' }] }]);
  });

  it('reasoning 增量合并为单一 part，且位于 tool-call 之前（发生顺序）', () => {
    const entries: TurnTranscriptEntry[] = [
      { kind: 'reasoning', text: '先看' },
      { kind: 'reasoning', text: '一下' },
      { kind: 'tool-call', toolCallId: 'call-1', toolName: 'read_file', input: { path: 'a.ts' } },
    ];
    const [assistant] = buildAssistantTurnMessages('', entries);
    expect(assistant).toMatchObject({
      role: 'assistant',
      content: [
        { type: 'reasoning', text: '先看一下' },
        { type: 'tool-call', toolCallId: 'call-1', toolName: 'read_file', input: { path: 'a.ts' } },
      ],
    });
  });

  it('工具结果归入独立 tool 消息，output 为 SDK 包装形态', () => {
    const entries: TurnTranscriptEntry[] = [
      {
        kind: 'tool-call',
        toolCallId: 'call-1',
        toolName: 'run_command',
        input: { command: 'ls' },
      },
      { kind: 'tool-result', toolCallId: 'call-1', toolName: 'run_command', output: 'a.ts\nb.ts' },
      {
        kind: 'tool-call',
        toolCallId: 'call-2',
        toolName: 'run_command',
        input: { command: 'pwd' },
      },
      {
        kind: 'tool-result',
        toolCallId: 'call-2',
        toolName: 'run_command',
        error: { code: 'E', message: 'boom' },
      },
    ];
    const messages = buildAssistantTurnMessages('完成', entries);
    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'call-1',
          toolName: 'run_command',
          output: { type: 'text', value: 'a.ts\nb.ts' },
        },
        {
          type: 'tool-result',
          toolCallId: 'call-2',
          toolName: 'run_command',
          output: { type: 'json', value: { error: { code: 'E', message: 'boom' } } },
        },
      ],
    });
  });

  it('多步回合保序：reasoning → tool-call → reasoning → tool-call → text', () => {
    const entries: TurnTranscriptEntry[] = [
      { kind: 'reasoning', text: 'step1 思考' },
      { kind: 'tool-call', toolCallId: 'c1', toolName: 'search', input: {} },
      { kind: 'tool-result', toolCallId: 'c1', toolName: 'search', output: [] },
      { kind: 'reasoning', text: 'step2 思考' },
      { kind: 'tool-call', toolCallId: 'c2', toolName: 'read_file', input: { path: 'x' } },
      { kind: 'tool-result', toolCallId: 'c2', toolName: 'read_file', output: 'ok' },
    ];
    const [assistant] = buildAssistantTurnMessages('最终回答', entries);
    const types = (assistant?.content as Array<{ type: string }> | undefined)?.map((p) => p.type);
    expect(types).toEqual(['reasoning', 'tool-call', 'reasoning', 'tool-call', 'text']);
  });

  it('全空回合返回空数组（不落库）', () => {
    expect(buildAssistantTurnMessages('', [])).toEqual([]);
  });

  it('中断回合：仅保留已发生的工具调用（无文本也落库）', () => {
    const entries: TurnTranscriptEntry[] = [
      {
        kind: 'tool-call',
        toolCallId: 'c1',
        toolName: 'run_command',
        input: { command: 'npm test' },
      },
      { kind: 'tool-result', toolCallId: 'c1', toolName: 'run_command', output: 'passing' },
    ];
    const messages = buildAssistantTurnMessages('', entries);
    expect(messages).toHaveLength(2);
  });
});

describe('toPersistedOutput', () => {
  it('未超限的字符串包装为 text 形态', () => {
    expect(toPersistedOutput('short')).toEqual({ type: 'text', value: 'short' });
  });

  it('超限字符串截断并附标记', () => {
    const output = toPersistedOutput('x'.repeat(MAX_PERSISTED_TOOL_OUTPUT_BYTES + 100));
    const result = output as { type: string; value: string };
    expect(result.type).toBe('text');
    expect(result.value.length).toBeLessThan(MAX_PERSISTED_TOOL_OUTPUT_BYTES + 100);
    expect(result.value).toContain('工具输出过长');
  });

  it('对象 output 包装为 json 形态', () => {
    expect(toPersistedOutput({ files: ['a.ts'], count: 2 })).toEqual({
      type: 'json',
      value: { files: ['a.ts'], count: 2 },
    });
  });

  it('超限对象整体替换为截断标记（不保留部分数据）', () => {
    const output = toPersistedOutput({ blob: 'y'.repeat(MAX_PERSISTED_TOOL_OUTPUT_BYTES + 10) });
    expect(output).toEqual({ type: 'json', value: expect.stringContaining('工具输出过长') });
  });

  it('不可序列化 output 降级为字符串形态', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(toPersistedOutput(cyclic)).toEqual({
      type: 'json',
      value: expect.stringContaining('工具输出过长'),
    });
  });
});
