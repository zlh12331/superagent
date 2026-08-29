// src/main/infra/ai/agent/context-compression.test.ts
// context-compression 单测：token 估算口径 / 上下文裁剪 / 预算压缩 / 窗口感知调度
//
// 测试要点（纯函数模块，真实实现 + gpt-tokenizer + SDK pruneMessages）：
// 1. estimateTokenCount / estimateMessagesTokens：估算口径必须覆盖 provider
//    真实可见文本（text / reasoning / tool-call 入参 / tool-result 输出 / 多模态）
// 2. pruneContext：旧推理块回收、窗口外工具上下文成对删除（不留孤儿）、空消息清理
// 3. compressByTokenBudget：预算内不动 / 两档压缩（先裁剪后丢弃）/ system 扣额
//    / 切点不制造孤儿 tool_result（供应商 400）/ 兜底永不返回空列表
// 4. compressContext：数量压缩（system 保留 + early 切片 + 工具消息合并）
// 5. getCompactionBudget：大/中/小/极小窗口预算
// 6. getCompactionDecision / getTokenBudgetDecision：四档判定与边界

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
  MULTIMODAL_PART_TOKEN_ALLOWANCE,
  pruneContext,
  TOOL_CONTEXT_KEEP_MESSAGES,
} from './context-compression';

const user = (content: string): ModelMessage => ({ role: 'user', content });
const assistant = (content: string): ModelMessage => ({ role: 'assistant', content });
const system = (content: string): ModelMessage => ({ role: 'system', content });

/** assistant 消息：任意 content parts（text / reasoning / tool-call 混排） */
const assistantParts = (parts: unknown[]): ModelMessage =>
  ({ role: 'assistant', content: parts }) as unknown as ModelMessage;

const toolCallPart = (id: string, input: unknown = { path: 'src/a.ts' }): unknown => ({
  type: 'tool-call',
  toolCallId: id,
  toolName: 'read_file',
  input,
});

/** SDK v7 工具结果消息（tool-result part + output 判别联合） */
const toolResult = (id: string, value: string): ModelMessage =>
  ({
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId: id,
        toolName: 'read_file',
        output: { type: 'text', value },
      },
    ],
  }) as unknown as ModelMessage;

/** v7 允许一条 tool 消息携带多个 tool-result 段 */
const toolResults = (ids: string[]): ModelMessage =>
  ({
    role: 'tool',
    content: ids.map((id) => ({
      type: 'tool-result',
      toolCallId: id,
      toolName: 'read_file',
      output: { type: 'text', value: `${id}_output` },
    })),
  }) as unknown as ModelMessage;

/** 带工具调用的 assistant 消息（旧版 toolCalls 字段形态，供 compressContext 用例） */
const assistantCall = (id: string): ModelMessage =>
  ({
    role: 'assistant',
    content: '',
    toolCalls: [{ type: 'function', id, function: { name: 'grep', arguments: '{}' } }],
  }) as unknown as ModelMessage;

/** 工具结果消息（旧版形态） */
const legacyToolResult = (id: string): ModelMessage =>
  ({ role: 'tool', content: 'ok', toolCallId: id }) as unknown as ModelMessage;

/** 收集消息里所有 tool-call / tool-result 的 id，用于校验配对完整性 */
function collectToolIds(messages: ModelMessage[]): { calls: string[]; results: string[] } {
  const calls: string[] = [];
  const results: string[] = [];
  for (const msg of messages) {
    const content = msg.content as unknown;
    if (typeof content === 'string' || !Array.isArray(content)) {
      continue;
    }
    for (const part of content) {
      const p = part as { type?: string; toolCallId?: string };
      if (p.type === 'tool-call' && p.toolCallId !== undefined) {
        calls.push(p.toolCallId);
      } else if (p.type === 'tool-result' && p.toolCallId !== undefined) {
        results.push(p.toolCallId);
      }
    }
  }
  return { calls, results };
}

describe('estimateTokenCount', () => {
  it('空文本：返回 0', () => {
    expect(estimateTokenCount('')).toBe(0);
  });

  it('中文按词表精确计数', () => {
    expect(estimateTokenCount('字'.repeat(100))).toBe(100);
    expect(estimateTokenCount('你好世界')).toBeGreaterThan(0);
  });

  it('英文单词计数在合理区间', () => {
    const count = estimateTokenCount('hello world');
    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThanOrEqual(4);
  });

  it('更长文本 token 数单调不减', () => {
    expect(estimateTokenCount('short text with much more content here')).toBeGreaterThanOrEqual(
      estimateTokenCount('short text'),
    );
  });
});

describe('estimateMessagesTokens（估算口径覆盖 provider 可见文本）', () => {
  it('空列表为 0', () => {
    expect(estimateMessagesTokens([])).toBe(0);
  });

  it('多条字符串消息：求和', () => {
    const messages = [user('hello world'), assistant('你好')];
    expect(estimateMessagesTokens(messages)).toBe(
      estimateTokenCount('hello world') + estimateTokenCount('你好'),
    );
  });

  it('多段 content：text 段全部拼接计数', () => {
    const messages = [
      assistantParts([
        { type: 'text', text: '第一段' },
        { type: 'text', text: '第二段' },
      ]),
    ];
    expect(estimateMessagesTokens(messages)).toBe(estimateTokenCount('第一段\n第二段'));
  });

  it('推理块计入（旧实现只数 text → 思考模型占用严重低估）', () => {
    const messages = [
      assistantParts([
        { type: 'reasoning', text: '让我先想想' },
        { type: 'text', text: '答案' },
      ]),
    ];
    expect(estimateMessagesTokens(messages)).toBe(estimateTokenCount('让我先想想\n答案'));
  });

  it('工具调用入参计入（旧实现按 0 计）', () => {
    const messages = [assistantParts([toolCallPart('c1')])];
    expect(estimateMessagesTokens(messages)).toBe(
      estimateTokenCount('read_file {"path":"src/a.ts"}'),
    );
  });

  it('工具结果正文计入（agent 对话最大消耗，旧实现按 0 计）', () => {
    const messages = [toolResult('c1', '文件内容很长的模拟输出')];
    expect(estimateMessagesTokens(messages)).toBe(estimateTokenCount('文件内容很长的模拟输出'));
    expect(estimateMessagesTokens(messages)).toBeGreaterThan(0);
  });

  it('工具结果 json 输出按序列化计数', () => {
    const messages: ModelMessage[] = [
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'c1',
            toolName: 'search',
            output: { type: 'json', value: { hits: 3 } },
          },
        ],
      } as unknown as ModelMessage,
    ];
    expect(estimateMessagesTokens(messages)).toBe(estimateTokenCount('{"hits":3}'));
  });

  it('工具结果 content 多段：文本段计数、文件段走固定折算', () => {
    const messages: ModelMessage[] = [
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'c1',
            toolName: 'screenshot',
            output: {
              type: 'content',
              value: [
                { type: 'text', text: '截图说明' },
                { type: 'file', mediaType: 'image/png', data: { type: 'data', data: 'AAAA' } },
              ],
            },
          },
        ],
      } as unknown as ModelMessage,
    ];
    expect(estimateMessagesTokens(messages)).toBe(
      estimateTokenCount('截图说明') + MULTIMODAL_PART_TOKEN_ALLOWANCE,
    );
  });

  it('多模态 part 按固定额度折算（base64 负载不逐字符计数）', () => {
    const messages: ModelMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: '看下这张图' },
          { type: 'image', image: 'data:image/png;base64,AAAA' },
        ],
      } as unknown as ModelMessage,
    ];
    expect(estimateMessagesTokens(messages)).toBe(
      estimateTokenCount('看下这张图') + MULTIMODAL_PART_TOKEN_ALLOWANCE,
    );
  });

  it('内联文本型 file 负载按文本计数（不叠加资产固定额度）', () => {
    const messages: ModelMessage[] = [
      {
        role: 'user',
        content: [
          {
            type: 'file',
            mediaType: 'text/plain',
            data: { type: 'text', text: '文档正文内容' },
          },
        ],
      } as unknown as ModelMessage,
    ];
    expect(estimateMessagesTokens(messages)).toBe(estimateTokenCount('文档正文内容'));
  });

  it('非法 content 形状（非 string 非数组）：String() 兜底不抛', () => {
    const weird = { role: 'user', content: 42 } as unknown as ModelMessage;
    expect(estimateMessagesTokens([weird])).toBe(estimateTokenCount('42'));
  });
});

describe('pruneContext（SDK pruneMessages 封装）', () => {
  it('旧推理块只保留最后一条 assistant 的 reasoning', () => {
    const messages = [
      assistantParts([
        { type: 'reasoning', text: '早期思考' },
        { type: 'text', text: '早期回答' },
      ]),
      user('追问'),
      assistantParts([
        { type: 'reasoning', text: '最新思考' },
        { type: 'text', text: '最新回答' },
      ]),
    ];
    const text = JSON.stringify(pruneContext(messages));
    expect(text).not.toContain('早期思考');
    expect(text).toContain('早期回答');
    expect(text).toContain('最新思考');
  });

  it('窗口外工具调用与结果成对删除，且不留空消息壳', () => {
    const messages: ModelMessage[] = [
      assistantParts([toolCallPart('old')]),
      toolResult('old', '很久以前的输出'),
      ...Array.from({ length: TOOL_CONTEXT_KEEP_MESSAGES }, (_, i) => user(`f${i}`)),
    ];
    const pruned = pruneContext(messages);
    const { calls, results } = collectToolIds(pruned);
    expect(calls).toEqual([]);
    expect(results).toEqual([]);
    // 调用方与结果方一起消失 → 长度少 2
    expect(pruned).toHaveLength(TOOL_CONTEXT_KEEP_MESSAGES);
    expect(JSON.stringify(pruned)).not.toContain('很久以前的输出');
  });

  it('结果落在保留窗口内时，其调用即使在窗口外也一起保留（配对完整性）', () => {
    const messages: ModelMessage[] = [
      assistantParts([toolCallPart('c1')]),
      ...Array.from({ length: TOOL_CONTEXT_KEEP_MESSAGES - 1 }, (_, i) => user(`f${i}`)),
      toolResult('c1', '窗口内的输出'),
    ];
    const pruned = pruneContext(messages);
    const { calls, results } = collectToolIds(pruned);
    expect(calls).toContain('c1');
    expect(results).toContain('c1');
    expect(JSON.stringify(pruned)).toContain('窗口内的输出');
  });

  it('保留窗口可收窄（自定义 keepRecentMessages 生效）', () => {
    const messages: ModelMessage[] = [
      assistantParts([toolCallPart('c1')]),
      toolResult('c1', '将被裁掉的输出'),
      user('a'),
      user('b'),
      user('c'),
    ];
    const pruned = pruneContext(messages, 3);
    expect(JSON.stringify(pruned)).not.toContain('将被裁掉的输出');
    expect(pruned.filter((msg) => msg.role === 'user')).toHaveLength(3);
  });

  it('system 与纯文本消息不参与裁剪', () => {
    const pruned = pruneContext([system('系统提示词'), user('hi'), assistant('回答')]);
    expect(pruned).toEqual([system('系统提示词'), user('hi'), assistant('回答')]);
  });
});

describe('compressByTokenBudget（两档预算压缩）', () => {
  it('maxTokens ≤ 0：返回空数组', () => {
    expect(compressByTokenBudget([user('hi')], 0)).toEqual([]);
  });

  it('空消息列表：返回空数组', () => {
    expect(compressByTokenBudget([])).toEqual([]);
  });

  it('预算内：原样返回，不做任何有信息损失的裁剪', () => {
    const messages: ModelMessage[] = [
      system('sys'),
      assistantParts([
        { type: 'reasoning', text: '思考' },
        { type: 'text', text: '回答' },
      ]),
      toolResult('c1', '工具输出'),
      user('短消息'),
    ];
    expect(compressByTokenBudget(messages, 10_000)).toBe(messages);
  });

  it('超出预算：丢弃前缀，保留最新消息', () => {
    // 预算 2：'字字'(2) + '字'(1) 反向累积时 1+2>2 → 只保留最后一条
    const messages: ModelMessage[] = [user('字字'), user('字')];
    expect(compressByTokenBudget(messages, 2)).toEqual([user('字')]);
  });

  it('单条消息超预算：至少保留最后一条（避免空上下文）', () => {
    const long = '字'.repeat(100);
    const messages: ModelMessage[] = [user('短'), user(long)];
    const result = compressByTokenBudget(messages, 10);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(user(long));
  });

  it('system 占用先从预算扣除（否则压缩后总上下文仍超窗口）', () => {
    const bigSystem = system('系'.repeat(100));
    const messages: ModelMessage[] = [bigSystem, user('字'.repeat(50))];
    // 预算恰好等于 system → 对话额度为 0 → 兜底仍保留最后一条 + system 不丢
    expect(compressByTokenBudget(messages, estimateTokenCount('系'.repeat(100)))).toEqual([
      bigSystem,
      user('字'.repeat(50)),
    ]);
    // 预算小于 system → 对话额度归零，system 依然保留
    expect(compressByTokenBudget(messages, 10)[0]?.role).toBe('system');
  });

  it('第一档生效：窗口外巨型工具结果被裁剪后，早期对话轮次得以保留', () => {
    const early = [user('最早的问题'), user('最早的追问')];
    const huge = '字'.repeat(5_000);
    const fillers = Array.from({ length: TOOL_CONTEXT_KEEP_MESSAGES }, (_, i) => user(`f${i}`));
    const messages: ModelMessage[] = [
      ...early,
      assistantParts([toolCallPart('c1', { path: huge })]),
      toolResult('c1', huge),
      ...fillers,
    ];
    // 预算 = 裁剪后的实际占用（早期 + filler）+ 余量
    const budget = estimateMessagesTokens([...early, ...fillers]) + 50;
    const result = compressByTokenBudget(messages, budget);

    expect(JSON.stringify(result)).not.toContain(huge);
    // 没有第一档裁剪时，drop-oldest 会在巨型消息处 break 而丢掉更早的轮次
    expect(result).toContainEqual(user('最早的问题'));
    expect(result).toContainEqual(user('最早的追问'));
    expect(result).toHaveLength(messages.length - 2);
  });

  it('裁剪后仍超预算：继续从后往前整条丢弃', () => {
    const messages: ModelMessage[] = [system('系统提示词')];
    for (let i = 1; i <= 20; i += 1) {
      messages.push(user(`消息 ${i} ${'内容'.repeat(50)}`));
    }
    const result = compressByTokenBudget(messages, 300);
    expect(result[0]?.role).toBe('system');
    expect(result.length).toBeLessThan(messages.length);
    expect(result.at(-1)).toEqual(messages.at(-1));
  });

  it('不修改原始数组', () => {
    const messages = [system('s'), user('a'), user('b')];
    const before = [...messages];
    compressByTokenBudget(messages, 1);
    expect(messages).toEqual(before);
  });

  it('稀疏数组（含空洞）：不抛错', () => {
    const sparse: ModelMessage[] = [];
    sparse[2] = user('b');
    expect(compressByTokenBudget(sparse, 1)).toContainEqual(user('b'));
  });

  it('切点落在调用与结果之间：孤儿 tool_result 整条丢弃（防供应商 400）', () => {
    const call = assistantParts([toolCallPart('c1')]);
    const result = toolResult('c1', '工具输出');
    const tail = user('最新问题');
    // 预算刚好够 result + tail → call 被切掉，result 成了无主孤儿
    const compressed = compressByTokenBudget(
      [call, result, tail],
      estimateMessagesTokens([result, tail]),
    );
    expect(compressed).toEqual([tail]);
    expect(collectToolIds(compressed).results).toEqual([]);
  });

  it('结果消息混有「已切掉的调用」与「保留的调用」：只剥孤儿段', () => {
    const oldCall = assistantParts([toolCallPart('c_old')]);
    const newCall = assistantParts([toolCallPart('c_new')]);
    const mixed = toolResults(['c_old', 'c_new']);
    const tail = user('最新问题');
    const compressed = compressByTokenBudget(
      [oldCall, newCall, mixed, tail],
      estimateMessagesTokens([newCall, mixed, tail]),
    );
    expect(compressed).toHaveLength(3);
    expect(collectToolIds(compressed)).toEqual({ calls: ['c_new'], results: ['c_new'] });
    const json = JSON.stringify(compressed);
    expect(json).toContain('c_new_output');
    expect(json).not.toContain('c_old_output');
  });

  it('切片全是孤儿结果：只留 system（不返回空 messages）', () => {
    const sys = system('系统提示词');
    const compressed = compressByTokenBudget(
      [sys, assistantParts([toolCallPart('c1')]), toolResult('c1', '工具输出')],
      estimateMessagesTokens([sys, toolResult('c1', '工具输出')]),
    );
    expect(compressed).toEqual([sys]);
  });

  it('无 system 且全是孤儿结果：带回未剥离切片（空 prompt 会被 SDK 直接拒绝）', () => {
    const result = toolResult('c1', '工具输出');
    const compressed = compressByTokenBudget(
      [assistantParts([toolCallPart('c1')]), result],
      estimateMessagesTokens([result]),
    );
    expect(compressed).toEqual([result]);
  });
});

describe('compressContext（数量压缩 + 工具合并）', () => {
  it('消息数在限制内：返回同一引用（不压缩）', () => {
    const messages: ModelMessage[] = [user('a'), assistant('b'), user('c')];
    expect(compressContext(messages)).toBe(messages);
  });

  it('默认阈值下短对话不压缩', () => {
    const messages: ModelMessage[] = [system('sys'), user('hi'), assistant('hello')];
    expect(compressContext(messages)).toHaveLength(3);
  });

  it('超限制：system 保留 + early 只留最近 recentMessages 条', () => {
    const messages: ModelMessage[] = [
      system('sys'),
      ...Array.from({ length: 12 }, (_, i) => user(`m${i}`)),
    ];
    const result = compressContext(messages, { maxMessages: 5, recentMessages: 3 });
    expect(result.filter((m) => m.role === 'system')).toHaveLength(1);
    expect(result.filter((m) => m.role === 'user').map((m) => m.content)).toEqual([
      'm9',
      'm10',
      'm11',
    ]);
  });

  it('默认参数：60 条 user + 1 条 assistant → 保留 system 与最近 10 条', () => {
    const messages: ModelMessage[] = [
      system('系统提示词'),
      ...Array.from({ length: 60 }, (_, i) => user(`消息${i}`)),
      assistant('最近回复'),
    ];
    const result = compressContext(messages);
    expect(result[0]).toEqual(system('系统提示词'));
    expect(result.filter((m) => m.role === 'user')).toHaveLength(9);
    expect(result.filter((m) => m.role === 'assistant')).toHaveLength(1);
  });

  it('自定义 maxMessages/recentMessages 生效', () => {
    const messages: ModelMessage[] = [
      system('sys'),
      ...Array.from({ length: 30 }, (_, i) => user(`m${i}`)),
    ];
    expect(compressContext(messages, { maxMessages: 20, recentMessages: 5 })).toHaveLength(6);
  });

  it('连续工具调用对：合并为最新一对', () => {
    const messages: ModelMessage[] = [
      assistantCall('c1'),
      legacyToolResult('c1'),
      assistantCall('c2'),
      legacyToolResult('c2'),
      user('最终结论'),
    ];
    const result = compressContext(messages, { maxMessages: 3, recentMessages: 2 });
    expect(result.filter((m) => m.role === 'tool')).toHaveLength(2);
    expect(result.filter((m) => m.role === 'assistant')).toHaveLength(2);
  });

  it('悬空工具调用（无配对结果）：不进入合并输出', () => {
    const messages: ModelMessage[] = [assistantCall('c1'), user('中断')];
    const result = compressContext(messages, { maxMessages: 1, recentMessages: 1 });
    expect(result.filter((m) => m.role === 'assistant')).toHaveLength(0);
  });

  it('末尾未配对工具调用：不 flush', () => {
    const messages: ModelMessage[] = [
      assistantCall('c1'),
      legacyToolResult('c1'),
      assistantCall('c2'),
    ];
    const result = compressContext(messages, { maxMessages: 2, recentMessages: 5 });
    expect(result.filter((m) => m.role === 'assistant')).toHaveLength(1);
    expect(result.filter((m) => m.role === 'tool')).toHaveLength(1);
  });
});

describe('getCompactionBudget（窗口感知预算）', () => {
  it('大窗口：预留封顶 20000（5% 超限时取上限）', () => {
    expect(getCompactionBudget(1_000_000)).toBe(750_000 - 20_000);
  });

  it('中窗口：预留按 5% 缩水', () => {
    expect(getCompactionBudget(100_000)).toBe(75_000 - 5_000);
  });

  it('32K 窗口：预留按 5% 缩水', () => {
    expect(getCompactionBudget(32_000)).toBe(22_400);
  });

  it('极小窗口：不低于 MIN_COMPACTION_BUDGET', () => {
    expect(getCompactionBudget(8_000)).toBe(MIN_COMPACTION_BUDGET);
    expect(getCompactionBudget(2_000)).toBe(MIN_COMPACTION_BUDGET);
  });
});

describe('getCompactionDecision / getTokenBudgetDecision（四档判定）', () => {
  // 100K 窗口：compactAt = 70000，warn 线 = 65000，hardLimit = 95000
  const Window = 100_000;

  it('ok：远低于压缩线', () => {
    expect(getCompactionDecision(10_000, Window)).toBe('ok');
    expect(getTokenBudgetDecision(1_000, Window).level).toBe('ok');
  });

  it('warn：接近压缩线（缓冲区内）', () => {
    expect(getCompactionDecision(67_000, Window)).toBe('warn');
    expect(getTokenBudgetDecision(66_000, Window).level).toBe('warn');
  });

  it('compact：达到压缩线', () => {
    const d = getTokenBudgetDecision(70_000, Window);
    expect(d.level).toBe('compact');
    expect(d.compactAt).toBe(70_000);
    expect(getCompactionDecision(80_000, Window)).toBe('compact');
  });

  it('over-limit：超出硬上限（窗口 − 输出预留）拒止', () => {
    const d = getTokenBudgetDecision(96_000, Window);
    expect(d.level).toBe('over-limit');
    expect(d.hardLimit).toBe(95_000);
  });

  it('边界：恰好等于硬上限不拒止', () => {
    const window = 128_000;
    const hardLimit = window - 6_400;
    expect(getTokenBudgetDecision(hardLimit, window).hardLimit).toBe(hardLimit);
    expect(getTokenBudgetDecision(hardLimit, window).level).not.toBe('over-limit');
    expect(getTokenBudgetDecision(hardLimit + 1, window).level).toBe('over-limit');
  });
});
