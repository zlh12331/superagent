import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatMessage } from '@code-agent/shared/main';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const { mockApp } = vi.hoisted(() => ({
  mockApp: { getPath: vi.fn(() => '/tmp/db-perf') },
}));

vi.mock('electron', () => ({
  app: {
    ...mockApp,
    getAppPath: () => process.cwd(),
    isPackaged: false,
  },
}));

import { closeDb, getDb, initDb, resetDb } from './db';
import { SessionService } from './session-service';

let tempDir: string;
let service: SessionService;

function makeMessage(i: number, role: 'user' | 'assistant' = 'user'): ChatMessage {
  return {
    role,
    content:
      role === 'user'
        ? `基准消息 ${i}：模拟用户问题，包含一定长度的上下文文本用于撑起 JSON 体积`
        : `基准回复 ${i}：模拟 agent 流式结果，含代码片段与解释文字，用于测量反序列化成本`,
  };
}

function makeBatch(count: number): ChatMessage[] {
  return Array.from({ length: count }, (_, i) => makeMessage(i));
}

async function sampleMedian(run: () => Promise<void>, rounds = 5): Promise<number> {
  const timings: number[] = [];
  for (let round = 0; round < rounds; round += 1) {
    const start = performance.now();
    await run();
    timings.push(performance.now() - start);
  }
  timings.sort((a, b) => a - b);
  return timings[Math.floor(timings.length / 2)] ?? 0;
}

describe('SQLite 存储基准（perf）', () => {
  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'code-agent-db-perf-'));
    mockApp.getPath.mockReturnValue(tempDir);
    resetDb();
    initDb();
    service = new SessionService();
  });

  afterAll(async () => {
    await closeDb();
    try {
      rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {}
  });

  describe('写入基准（appendMessage 批量追加）', () => {
    it('追加 100 条消息中位数 < 100ms', async () => {
      const median = await sampleMedian(async () => {
        const sessionId = await service.create({
          workingDir: '/bench',
          title: undefined,
          messages: undefined,
        });
        await service.appendMessage({ sessionId, messages: makeBatch(100) });
      });
      console.log(`[perf] appendMessage 100 条中位数: ${median.toFixed(2)}ms`);
      expect(median, '批量追加 100 条消息应 < 100ms（基线，渐进收紧）').toBeLessThan(100);
    });

    it('创建会话 + 批量追加 10000 条总耗时 < 10s（迁移/导入场景）', async () => {
      const sessionId = await service.create({
        workingDir: '/bench',
        title: undefined,
        messages: undefined,
      });
      const start = performance.now();
      for (let batch = 0; batch < 100; batch += 1) {
        await service.appendMessage({ sessionId, messages: makeBatch(100) });
      }
      const total = performance.now() - start;
      console.log(`[perf] 10000 条追加总耗时: ${total.toFixed(0)}ms`);
      expect(total, '10000 条消息批量追加应 < 10s（基线，渐进收紧）').toBeLessThan(10_000);
    });
  });

  describe('读取基准（10000 条消息规模）', () => {
    let bigSessionId: string;

    beforeAll(async () => {
      for (let s = 0; s < 10; s += 1) {
        const sessionId = await service.create({
          workingDir: '/bench',
          title: `基准会话 ${s}`,
          messages: undefined,
        });
        for (let batch = 0; batch < 10; batch += 1) {
          await service.appendMessage({ sessionId, messages: makeBatch(100) });
        }
        if (s === 0) bigSessionId = sessionId;
      }
    });

    it('会话列表首屏 list(50, 0) 中位数 < 5ms', async () => {
      const median = await sampleMedian(async () => {
        await service.list(50, 0);
      });
      console.log(`[perf] list(50, 0) 中位数: ${median.toFixed(2)}ms`);
      expect(median, '会话列表首屏查询应 < 5ms（基线，渐进收紧）').toBeLessThan(5);
    });

    it('会话列表深分页 list(50, 5000) 中位数 < 50ms', async () => {
      const median = await sampleMedian(async () => {
        await service.list(50, 5000);
      });
      console.log(`[perf] list(50, 5000) 中位数: ${median.toFixed(2)}ms`);
      expect(median, '深分页查询应 < 50ms（基线；offset 深翻页成本高于首屏）').toBeLessThan(50);
    });

    it('单会话全量读取 get（1000 条含反序列化）中位数 < 100ms', async () => {
      const median = await sampleMedian(async () => {
        await service.get(bigSessionId);
      });
      console.log(`[perf] get(1000 条) 中位数: ${median.toFixed(2)}ms`);
      expect(median, '单会话全量读取（1000 条）应 < 100ms（基线，渐进收紧）').toBeLessThan(100);
    });
  });

  describe('并发基准（10 路并行）', () => {
    it('并发 10 会话 × 100 条追加：总数无丢失且总耗时 < 2000ms', async () => {
      const start = performance.now();
      const results = await Promise.all(
        Array.from({ length: 10 }, async () => {
          const sessionId = await service.create({
            workingDir: '/bench',
            title: undefined,
            messages: undefined,
          });
          return service.appendMessage({ sessionId, messages: makeBatch(100) });
        }),
      );
      const total = performance.now() - start;

      console.log(`[perf] 并发 10 路追加（10×100 条）总耗时: ${total.toFixed(0)}ms`);
      expect(results, '每路消息总数必须为 100（并发写入无丢失）').toEqual(Array(10).fill(100));
      expect(total, '并发 10 路 × 100 条应 < 2000ms（基线，渐进收紧）').toBeLessThan(2000);
    });

    it('并发 10 路 list(50, 0) 中位数 < 20ms（争用下查询延迟）', async () => {
      const timings: number[] = [];
      for (let round = 0; round < 5; round += 1) {
        const start = performance.now();
        await Promise.all(Array.from({ length: 10 }, () => service.list(50, 0)));
        timings.push((performance.now() - start) / 10);
      }
      const median = [...timings].sort((a, b) => a - b)[Math.floor(timings.length / 2)] ?? 0;
      console.log(`[perf] 并发 10 路 list 单路均摊中位数: ${median.toFixed(2)}ms`);
      expect(median, '并发争用下单路查询应 < 20ms（基线，渐进收紧）').toBeLessThan(20);
    });
  });

  describe('索引命中验证', () => {
    it('messages 按 session_id 查询走 uq_messages_session_seq 索引', () => {
      const db = getDb();
      const plan = db.all<{ detail: string }>(sql`EXPLAIN QUERY PLAN
        SELECT * FROM messages WHERE session_id = 'perf-nonexistent'`);
      const detail = plan.map((r) => r.detail).join(' | ');
      console.log(`[perf] EXPLAIN QUERY PLAN: ${detail}`);
      expect(detail, 'session_id 查询必须走具名 UNIQUE 索引（最左前缀）').toContain(
        'uq_messages_session_seq',
      );
    });
  });
});
