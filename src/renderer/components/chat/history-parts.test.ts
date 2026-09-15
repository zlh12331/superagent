// src/renderer/components/chat/history-parts.test.ts
// 持久化历史 → UIMessage 忠实重建纯函数测试（高杠杆纯函数，无 DOM 依赖）
// 业务逻辑不 mock：直接测真实 reconstructHistory / toInitialMessages 实现。

import type { ChatMessage } from '@code-agent/shared/renderer';
import { describe, expect, it } from 'vitest';

import { reconstructHistory, toInitialMessages } from './history-parts';

/** 构造一条消息（宽松对象，cast 成 ChatMessage） */
function msg(role: string, content: string | object[]): ChatMessage {
  return { role, content } as unknown as ChatMessage;
}

describe('reconstructHistory', () => {
  it('空消息数组 → 空结果', () => {
    const r = reconstructHistory([]);
    expect(r.messages).toEqual([]);
    expect(r.droppedPartTypes).toEqual([]);
    expect(r.hasRichParts).toBe(false);
  });

  it('string content（纯文本）→ 单条 text part；空字符串跳过', () => {
    const r = reconstructHistory([msg('user', '你好'), msg('user', ''), msg('assistant', '回答')]);
    expect(r.messages).toHaveLength(2); // 空字符串那条跳过
    expect(r.messages[0]).toMatchObject({ role: 'user', parts: [{ type: 'text', text: '你好' }] });
    expect(r.messages[1]).toMatchObject({
      role: 'assistant',
      parts: [{ type: 'text', text: '回答' }],
    });
  });

  it('reasoning part → 富 part 标记 hasRichParts=true', () => {
    const r = reconstructHistory([msg('assistant', [{ type: 'reasoning', text: '思考中' }])]);
    expect(r.messages[0]?.parts[0]).toMatchObject({ type: 'reasoning', text: '思考中' });
    expect(r.hasRichParts).toBe(true);
  });

  it('tool-call 有对应 tool-result → 合并成 output-available 工具卡', () => {
    const r = reconstructHistory([
      msg('assistant', [
        { type: 'tool-call', toolCallId: 'c1', toolName: 'read_file', input: { path: '/a' } },
      ]),
      msg('tool', [{ type: 'tool-result', toolCallId: 'c1', output: '文件内容' }]),
    ]);
    const toolPart = r.messages[0]?.parts.find((p) => 'toolCallId' in p);
    expect(toolPart).toMatchObject({
      type: 'tool-read_file',
      state: 'output-available',
      output: '文件内容',
    });
    expect(r.hasRichParts).toBe(true);
  });

  it('tool-error → output-error 工具卡（含 errorText）', () => {
    const r = reconstructHistory([
      msg('assistant', [{ type: 'tool-call', toolCallId: 'c2', toolName: 'edit_file', input: {} }]),
      msg('tool', [{ type: 'tool-error', toolCallId: 'c2', errorText: '权限不足' }]),
    ]);
    const toolPart = r.messages[0]?.parts.find((p) => 'state' in p && p.state === 'output-error');
    expect(toolPart).toMatchObject({
      type: 'tool-edit_file',
      state: 'output-error',
      errorText: '权限不足',
    });
  });

  it('孤儿 tool-result（无对应 tool-call）→ 独立 dynamic-tool 卡', () => {
    const r = reconstructHistory([
      msg('tool', [
        {
          type: 'tool-result',
          toolCallId: 'orphan',
          toolName: 'run_command',
          input: { cmd: 'ls' },
          output: 'ok',
        },
      ]),
    ]);
    const part = r.messages[0]?.parts[0];
    expect(part).toMatchObject({
      type: 'dynamic-tool',
      toolName: 'run_command',
      state: 'output-available',
      output: 'ok',
    });
  });

  it('孤儿 tool-error（无对应 tool-call）→ output-error 卡且保留 errorText', () => {
    // 回归：兜底此前硬编码 output-available，孤儿错误卡会渲染成成功态并丢 errorText
    const r = reconstructHistory([
      msg('tool', [
        {
          type: 'tool-error',
          toolCallId: 'orphan-err',
          toolName: 'edit_file',
          errorText: '权限不足',
        },
      ]),
    ]);
    expect(r.messages[0]?.parts[0]).toMatchObject({
      type: 'dynamic-tool',
      toolName: 'edit_file',
      state: 'output-error',
      errorText: '权限不足',
    });
  });

  it('孤儿 tool-error 无 toolCallId → 同样按错误态呈现（不误标成功）', () => {
    const r = reconstructHistory([
      msg('tool', [{ type: 'tool-error', toolName: 'run_command', errorText: 'boom' }]),
    ]);
    expect(r.messages[0]?.parts[0]).toMatchObject({
      type: 'dynamic-tool',
      state: 'output-error',
      errorText: 'boom',
    });
  });

  it('file part → UI file part（url 或 base64 data）', () => {
    const r = reconstructHistory([
      msg('user', [
        { type: 'file', mediaType: 'text/plain', url: 'file:///a.txt', filename: 'a.txt' },
      ]),
    ]);
    expect(r.messages[0]?.parts[0]).toMatchObject({
      type: 'file',
      mediaType: 'text/plain',
      url: 'file:///a.txt',
      filename: 'a.txt',
    });
  });

  it('file 无 url 但有 string data → 转 data URL', () => {
    const r = reconstructHistory([
      msg('user', [{ type: 'file', mediaType: 'text/plain', data: 'SGVsbG8=' }]),
    ]);
    const part = r.messages[0]?.parts[0] as { url: string };
    expect(part.url).toMatch(/^data:text\/plain;base64,SGVsbG8=$/);
  });

  it('step-start part 原样保留', () => {
    const r = reconstructHistory([msg('assistant', [{ type: 'step-start' }])]);
    expect(r.messages[0]?.parts[0]).toMatchObject({ type: 'step-start' });
  });

  it('未知 part 类型 → 登记 droppedPartTypes 且不丢消息', () => {
    const r = reconstructHistory([
      msg('assistant', [
        { type: 'unknown-part', foo: 1 },
        { type: 'text', text: 'hi' },
      ]),
    ]);
    expect(r.droppedPartTypes).toContain('unknown-part');
    expect(r.messages[0]?.parts).toHaveLength(1); // 只有 text
  });

  it('旧数据：content 是 URL-like 包装（type json/text）→ unwrap to value', () => {
    const r = reconstructHistory([
      msg('assistant', [
        {
          type: 'tool-call',
          toolCallId: 'c3',
          toolName: 'grep',
          input: { type: 'json', value: { q: 'x' } },
        },
      ]),
      msg('tool', [
        { type: 'tool-result', toolCallId: 'c3', output: { type: 'json', value: '匹配' } },
      ]),
    ]);
    const toolPart = r.messages[0]?.parts.find((p) => 'output' in p) as { output: unknown };
    expect(toolPart.output).toBe('匹配'); // unwrapOutput 还原
  });

  it('assistant/system 角色保映射；非法角色 → user', () => {
    const r = reconstructHistory([
      msg('assistant', [{ type: 'text', text: 'a' }]),
      msg('system', [{ type: 'text', text: 's' }]),
      msg('other', [{ type: 'text', text: 'x' }]),
    ]);
    expect(r.messages.map((m) => m.role)).toEqual(['assistant', 'system', 'user']);
  });

  it('落库的富回合（turn-transcript 形态）→ reasoning + 工具卡 + 文本完整重建', () => {
    // 模拟 agent-service 落库产物：reasoning/tool-call/text 的 assistant 消息
    // + SDK 包装形态 output 的 tool 消息（{type:'text', value}）
    const r = reconstructHistory([
      msg('assistant', [
        { type: 'reasoning', text: '先定位问题' },
        { type: 'tool-call', toolCallId: 'c9', toolName: 'read_file', input: { path: 'a.ts' } },
        { type: 'text', text: '回答文本' },
      ]),
      msg('tool', [
        {
          type: 'tool-result',
          toolCallId: 'c9',
          toolName: 'read_file',
          output: { type: 'text', value: '文件内容' },
        },
      ]),
    ]);
    // tool 消息的结果被合并进工具卡，自身无剩余 parts → 整条跳过
    expect(r.messages).toHaveLength(1);
    const types = r.messages[0]?.parts.map((p) => p.type);
    expect(types).toEqual(['reasoning', 'tool-read_file', 'text']);
    const toolPart = r.messages[0]?.parts.find((p) => 'toolCallId' in p);
    expect(toolPart).toMatchObject({
      type: 'tool-read_file',
      state: 'output-available',
      output: '文件内容', // unwrapOutput 还原包装
    });
    expect(r.hasRichParts).toBe(true); // textOnly 横幅条件不再成立
    expect(r.droppedPartTypes).toEqual([]);
  });
});

describe('toInitialMessages', () => {
  it('只返回 messages 数组（compact 替换本地态用）', () => {
    const arr = toInitialMessages([msg('user', '起始')]);
    expect(arr).toHaveLength(1);
    expect(arr[0]).toMatchObject({ role: 'user', parts: [{ type: 'text', text: '起始' }] });
  });
});
