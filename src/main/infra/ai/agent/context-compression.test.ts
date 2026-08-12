// src/main/infra/ai/agent/context-compression.test.ts
// context-compression 单测：token 预算压缩 / 窗口感知预算 / 回合级调度
//
// 测试要点（纯函数模块，真实实现 + gpt-tokenizer）：
// 1. estimateTokenCount：空/非空文本
// 2. compressByTokenBudget：预算内保留 / 超预算截断 / 单条超预算兜底 / system 保留
// 3. compressContext：数量压缩（system 保留 + early 切片 + 工具消息合并）
// 4. messageToText：多段 content 拼接 / 非文本 part 跳过 / 非法形状兜底
// 5. getCompactionBudget：大窗口 / 小窗口 / 极小窗口下限
// 6. getCompactionDecision / getTokenBudgetDecision：四档判定

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

const user = (content: string): ModelMessage => ({ role: 'user', content });

/** 带工具调用的 assistant 消息（SDK 类型联合不含 toolCalls 字面量，需断言） */
const assistantCall = (id: string): ModelMessage =>
  ({
    role: 'assistant',
    content: '',
    toolCalls: [{ type: 'function', id, function: { name: 'grep', arguments: '{}' } }],
  }) as unknown as ModelMessage;

/** 工具结果消息 */
const toolResult = (id: string): ModelMessage =>
  ({
    role: 'tool',
    content: 'ok',
    toolCallId: id,
  }) as unknown as ModelMessage;

describe('context-compression 批次4 缺口补全', () => {
  describe('estimateTokenCount', () => {
    it('空文本：返回 0', () => {
      expect(estimateTokenCount('')).toBe(0);
    });

    it('非空文本：gpt-tokenizer 精确计数', () => {
      // 中文 1 字 ≈ 1 token（已验证 90000 字 = 90000 tokens）
      expect(estimateTokenCount('字'.repeat(100))).toBe(100);
      expect(estimateTokenCount('hello world')).toBeGreaterThan(0);
    });
  });

  describe('messageToText（经 estimateMessagesTokens 间接测）', () => {
    it('多段 content：text part 拼接，非 text part 跳过', () => {
      const messages: ModelMessage[] = [
        {
          role: 'user',
          content: [
            { type: 'text', text: '第一段' },
            { type: 'image', image: 'data:image/png;base64,xxx' },
            { type: 'text', text: '第二段' },
          ],
        },
      ];
      // '第一段第二段' = 5 个中文字符 → 5 tokens
      expect(estimateMessagesTokens(messages)).toBe(5);
    });

    it('非法 content 形状（非 string 非数组）：String() 兜底不抛', () => {
      const weird = {
        role: 'user',
        content: 42,
      } as unknown as ModelMessage;
      expect(estimateMessagesTokens([weird])).toBe(estimateTokenCount('42'));
    });
  });

  describe('compressByTokenBudget（token 预算压缩）', () => {
    it('maxTokens ≤ 0：返回空数组', () => {
      expect(compressByTokenBudget([user('hi')], 0)).toEqual([]);
    });

    it('预算内：全部保留（system + user）', () => {
      const messages: ModelMessage[] = [{ role: 'system', content: 'sys' }, user('短消息')];
      const result = compressByTokenBudget(messages, 10_000);
      expect(result).toEqual(messages);
    });

    it('超出预算：丢弃前缀，保留最新消息', () => {
      // 预算 2：'字字'(2) + '字'(1) 反向累积时 1+2>2 → 只保留最后一条
      const messages: ModelMessage[] = [user('字字'), user('字')];
      const result = compressByTokenBudget(messages, 2);
      expect(result).toEqual([user('字')]);
    });

    it('单条消息超预算：至少保留最后一条（避免空上下文）', () => {
      const long = '字'.repeat(100);
      const messages: ModelMessage[] = [user('短'), user(long)];
      const result = compressByTokenBudget(messages, 10);
      // 短(1) + long(100) 超预算；long 单独也超 → 兜底保留最后一条
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual(user(long));
    });

    it('system 消息无条件保留（即使超预算）', () => {
      const messages: ModelMessage[] = [
        { role: 'system', content: '系统提示' },
        user('字'.repeat(50)),
      ];
      const result = compressByTokenBudget(messages, 10);
      expect(result[0]?.role).toBe('system');
      expect(result).toHaveLength(2); // system + 兜底保留的最后一条
    });

    it('稀疏数组（undefined 元素）：跳过不抛', () => {
      const sparse: ModelMessage[] = [user('a')];
      sparse[2] = user('b');
      // sparse[1] 为 undefined（空洞）
      const result = compressByTokenBudget(sparse, 100);
      expect(result).toContainEqual(user('b'));
    });
  });

  describe('compressContext（数量压缩 + 工具合并）', () => {
    it('消息数在限制内：原样返回', () => {
      const messages: ModelMessage[] = [user('a'), user('b')];
      expect(compressContext(messages, { maxMessages: 10 })).toEqual(messages);
    });

    it('超限制：system 保留 + early 只留最近 recentMessages 条', () => {
      const messages: ModelMessage[] = [
        { role: 'system', content: 'sys' },
        ...Array.from({ length: 12 }, (_, i) => user(`m${i}`)),
      ];
      const result = compressContext(messages, { maxMessages: 5, recentMessages: 3 });
      expect(result.filter((m) => m.role === 'system')).toHaveLength(1);
      const users = result.filter((m) => m.role === 'user');
      expect(users.map((m) => m.content)).toEqual(['m9', 'm10', 'm11']);
    });

    it('连续工具调用对：合并为最新一对', () => {
      const messages: ModelMessage[] = [
        assistantCall('c1'),
        toolResult('c1'),
        assistantCall('c2'),
        toolResult('c2'),
        user('最终结论'),
      ];
      // maxMessages 限制下走压缩：工具对合并保留
      const result = compressContext(messages, { maxMessages: 3, recentMessages: 2 });
      expect(result.filter((m) => m.role === 'tool')).toHaveLength(2);
      expect(result.filter((m) => m.role === 'assistant')).toHaveLength(2);
    });

    it('悬空工具调用（无配对结果）：不进入合并输出', () => {
      const messages: ModelMessage[] = [assistantCall('c1'), user('中断')];
      const result = compressContext(messages, { maxMessages: 1, recentMessages: 1 });
      // 未配对（无 tool result）→ 合并时丢弃
      expect(result.filter((m) => m.role === 'assistant')).toHaveLength(0);
    });

    it('末尾未配对工具调用：不 flush', () => {
      const messages: ModelMessage[] = [assistantCall('c1'), toolResult('c1'), assistantCall('c2')];
      const result = compressContext(messages, { maxMessages: 2, recentMessages: 5 });
      // c1 配对保留；c2 未配对（末尾）→ 合并时丢弃（不入 recent）
      expect(result.filter((m) => m.role === 'assistant')).toHaveLength(1);
      expect(result.filter((m) => m.role === 'tool')).toHaveLength(1);
    });
  });

  describe('getCompactionBudget（窗口感知预算）', () => {
    it('大窗口：预留封顶 20000（5% 超限时取上限）', () => {
      // 1M 窗口：reserve = min(20000, 50000) = 20000；budget = 750000 − 20000
      expect(getCompactionBudget(1_000_000)).toBe(750_000 - 20_000);
    });

    it('中窗口：预留按 5% 缩水', () => {
      // 100K 窗口：reserve = min(20000, 5000) = 5000；budget = 75000 − 5000
      expect(getCompactionBudget(100_000)).toBe(75_000 - 5_000);
    });

    it('极小窗口：压缩预算不低于下限', () => {
      // 2000 窗口：0.75×2000 − 100 = 1400 < 8000 → 取下限
      expect(getCompactionBudget(2000)).toBe(MIN_COMPACTION_BUDGET);
    });
  });

  describe('getCompactionDecision / getTokenBudgetDecision（四档判定）', () => {
    // 100K 窗口：compactAt = 70000，warn 线 = 65000，hardLimit = 95000
    const Window = 100_000;

    it('over-limit：超出硬上限（窗口 − 5% 预留）', () => {
      const d = getTokenBudgetDecision(96_000, Window);
      expect(d.level).toBe('over-limit');
      expect(d.hardLimit).toBe(95_000);
    });

    it('compact：达到压缩线', () => {
      const d = getTokenBudgetDecision(70_000, Window);
      expect(d.level).toBe('compact');
      expect(d.compactAt).toBe(70_000);
    });

    it('warn：接近压缩线（缓冲区内）', () => {
      const d = getTokenBudgetDecision(66_000, Window);
      expect(d.level).toBe('warn');
    });

    it('ok：远低于压缩线', () => {
      const d = getTokenBudgetDecision(1_000, Window);
      expect(d.level).toBe('ok');
    });

    it('getCompactionDecision 独立判定（compact/warn/ok 三档）', () => {
      expect(getCompactionDecision(80_000, Window)).toBe('compact');
      expect(getCompactionDecision(68_000, Window)).toBe('warn');
      expect(getCompactionDecision(10_000, Window)).toBe('ok');
    });
  });
});
