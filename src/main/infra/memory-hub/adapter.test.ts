// src/main/infra/memory-hub/adapter.test.ts
// HttpMemoryPort 单测：HTTP 请求形状 / 响应解析 / 失败降级
// ──────────────────────────────────────────────────────────────
// 测试策略（遵循"外部依赖注入 fake"）：
// - fetch 为网络边界 → vi.stubGlobal 注入 fake（业务判定逻辑保持真实）
// - 验证点：路径 / 鉴权头 / snake_case body / 失败降级语义
// ──────────────────────────────────────────────────────────────

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { HttpMemoryPort } from './adapter';

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
}));

/** 构造 fetch 响应 fake */
function respond(status: number, body?: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body ?? {},
  } as Response;
}

function createPort(): HttpMemoryPort {
  return new HttpMemoryPort({
    baseUrl: 'http://127.0.0.1:43210/',
    apiKey: 'test-api-key',
  });
}

describe('HttpMemoryPort', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', mocks.fetch);
  });

  describe('health', () => {
    it('GET /health 返回 ok → true', async () => {
      mocks.fetch.mockResolvedValueOnce(respond(200));
      await expect(createPort().health()).resolves.toBe(true);
      const [url, init] = mocks.fetch.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe('http://127.0.0.1:43210/health');
      expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer test-api-key');
    });

    it('非 2xx → false', async () => {
      mocks.fetch.mockResolvedValueOnce(respond(500));
      await expect(createPort().health()).resolves.toBe(false);
    });

    it('网络异常 → false（不抛错）', async () => {
      mocks.fetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
      await expect(createPort().health()).resolves.toBe(false);
    });
  });

  describe('capture', () => {
    it('POST /capture：snake_case body + 解析 l0_recorded / scheduler_notified', async () => {
      mocks.fetch.mockResolvedValueOnce(
        // biome-ignore lint/style/useNamingConvention: 上游 gateway 协议字段（snake_case）
        respond(200, { l0_recorded: 2, scheduler_notified: true }),
      );
      const result = await createPort().capture({
        sessionKey: 'sess-1',
        userContent: '用户内容',
        assistantContent: '助手内容',
      });
      expect(result).toEqual({ l0Recorded: 2, schedulerNotified: true });
      const [url, init] = mocks.fetch.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe('http://127.0.0.1:43210/capture');
      expect(JSON.parse(String(init.body))).toEqual({
        // biome-ignore lint/style/useNamingConvention: 上游 gateway 协议字段（snake_case）
        user_content: '用户内容',
        // biome-ignore lint/style/useNamingConvention: 上游 gateway 协议字段（snake_case）
        assistant_content: '助手内容',
        // biome-ignore lint/style/useNamingConvention: 上游 gateway 协议字段（snake_case）
        session_key: 'sess-1',
      });
      expect((init.headers as Record<string, string>)['Content-Type']).toContain(
        'application/json',
      );
    });

    it('字段缺省：l0_recorded 非 number / scheduler_notified 非 true → 0 / false', async () => {
      mocks.fetch.mockResolvedValueOnce(respond(200, {}));
      const result = await createPort().capture({
        sessionKey: 's',
        userContent: 'u',
        assistantContent: 'a',
      });
      expect(result).toEqual({ l0Recorded: 0, schedulerNotified: false });
    });

    it('非 2xx → 降级为 {0,false}（不抛错）', async () => {
      mocks.fetch.mockResolvedValueOnce(respond(503));
      const result = await createPort().capture({
        sessionKey: 's',
        userContent: 'u',
        assistantContent: 'a',
      });
      expect(result).toEqual({ l0Recorded: 0, schedulerNotified: false });
    });

    it('网络异常 → 降级为 {0,false}（不抛错）', async () => {
      mocks.fetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
      const result = await createPort().capture({
        sessionKey: 's',
        userContent: 'u',
        assistantContent: 'a',
      });
      expect(result).toEqual({ l0Recorded: 0, schedulerNotified: false });
    });
  });

  describe('recall', () => {
    it('POST /recall：解析 context / memory_count → ok=true', async () => {
      mocks.fetch.mockResolvedValueOnce(
        // biome-ignore lint/style/useNamingConvention: 上游 gateway 协议字段（snake_case）
        respond(200, { context: '召回内容', memory_count: 3 }),
      );
      const result = await createPort().recall({ query: '关键词' });
      expect(result).toEqual({ ok: true, context: '召回内容', memoryCount: 3 });
      const [, init] = mocks.fetch.mock.calls[0] as unknown as [string, RequestInit];
      expect(JSON.parse(String(init.body))).toEqual({ query: '关键词' });
    });

    it('sessionKey 提供时追加 session_key', async () => {
      mocks.fetch.mockResolvedValueOnce(
        // biome-ignore lint/style/useNamingConvention: 上游 gateway 协议字段（snake_case）
        respond(200, { context: '', memory_count: 0 }),
      );
      await createPort().recall({ query: 'q', sessionKey: 'sess-9' });
      const [, init] = mocks.fetch.mock.calls[0] as unknown as [string, RequestInit];
      expect(JSON.parse(String(init.body))).toEqual({
        query: 'q',
        // biome-ignore lint/style/useNamingConvention: 上游 gateway 协议字段（snake_case）
        session_key: 'sess-9',
      });
    });

    it('上游 code !== 0 → ok=false + message', async () => {
      mocks.fetch.mockResolvedValueOnce(respond(200, { code: 10001, message: '缺 embedding' }));
      const result = await createPort().recall({ query: 'q' });
      expect(result).toEqual({ ok: false, context: '', memoryCount: 0, message: '缺 embedding' });
    });

    it('code 非 0 且无 message → 回退 code 文本', async () => {
      mocks.fetch.mockResolvedValueOnce(respond(200, { code: 42 }));
      const result = await createPort().recall({ query: 'q' });
      expect(result.ok).toBe(false);
      expect(result.message).toBe('code=42');
    });

    it('网络异常 → ok=false + 异常信息', async () => {
      mocks.fetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
      const result = await createPort().recall({ query: 'q' });
      expect(result).toEqual({ ok: false, context: '', memoryCount: 0, message: 'ECONNREFUSED' });
    });
  });

  describe('searchMemories / searchConversations', () => {
    it('searchMemories：POST /search/memories + 解析 results / total', async () => {
      mocks.fetch.mockResolvedValueOnce(respond(200, { results: '条目', total: 5 }));
      const result = await createPort().searchMemories('q', 10);
      expect(result).toEqual({ content: '条目', total: 5 });
      const [url, init] = mocks.fetch.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe('http://127.0.0.1:43210/search/memories');
      expect(JSON.parse(String(init.body))).toEqual({ query: 'q', limit: 10 });
    });

    it('searchConversations：POST /search/conversations，limit 省略时不携带', async () => {
      mocks.fetch.mockResolvedValueOnce(respond(200, { results: '对话', total: 2 }));
      const result = await createPort().searchConversations('q');
      expect(result).toEqual({ content: '对话', total: 2 });
      const [, init] = mocks.fetch.mock.calls[0] as unknown as [string, RequestInit];
      expect(JSON.parse(String(init.body))).toEqual({ query: 'q' });
    });

    it('searchMemories 网络异常 → {空,0}（不抛错）', async () => {
      mocks.fetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
      const result = await createPort().searchMemories('q');
      expect(result).toEqual({ content: '', total: 0 });
    });
  });

  describe('baseUrl 归一化', () => {
    it('尾部斜杠被去除，不产生双斜杠', async () => {
      mocks.fetch.mockResolvedValueOnce(
        // biome-ignore lint/style/useNamingConvention: 上游 gateway 协议字段（snake_case）
        respond(200, { context: '', memory_count: 0 }),
      );
      await createPort().recall({ query: 'q' });
      const [url] = mocks.fetch.mock.calls[0] as unknown as [string];
      expect(url).toBe('http://127.0.0.1:43210/recall');
    });
  });
});
