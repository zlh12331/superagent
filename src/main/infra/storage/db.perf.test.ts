// src/main/infra/storage/db.perf.test.ts
// SQLite 存储基准：真实 better-sqlite3 + Drizzle 全链路（对齐长会话桌面端场景）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 写入吞吐：appendMessage 批量追加（100 条/次，长会话增量写入）
// - 读取延迟：会话列表分页 / 单会话全量消息读取（含 JSON 反序列化）
// - 索引验证：EXPLAIN QUERY PLAN 断言 messages 查询走索引（防全表扫描回归）
//
// 数据规模（对齐 12-performance-spec §三：500 条/会话为消息列表决策阈值）：
//   - 读取基准：10 会话 × 1000 条消息 = 10000 条（超阈值规模，虚拟化决策参考数据）
//
// 运行：pnpm test:perf:main（独立脚本，不阻塞常规 test:main——CI 机器波动可校准）
// 阈值策略：多轮采样取中位数（抗抖动）+ 宽松基线（防明显回退，随优化渐进收紧）
// ──────────────────────────────────────────────────────────────

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatMessage } from '@code-agent/shared/main';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const { mockApp } = vi.hoisted(() => ({
  mockApp: { getPath: vi.fn(() => '/tmp/db-perf') },
}));

vi.mock('electron', () => ({ app: mockApp }));

import { closeDb, getDb, initDb, resetDb } from './db';
import { SessionService } from './session-service';

let tempDir: string;
let service: SessionService;

/** 生成一条真实结构消息（与 agent 持久化格式一致） */
function makeMessage(i: number, role: 'user' | 'assistant' = 'user'): ChatMessage {
  return {
    role,
    content:
      role === 'user'
        ? `基准消息 ${i}：模拟用户问题，包含一定长度的上下文文本用于撑起 JSON 体积`
        : `基准回复 ${i}：模拟 agent 流式结果，含代码片段与解释文字，用于测量反序列化成本`,
  };
}

/** 批量消息 */
function makeBatch(count: number): ChatMessage[] {
  return Array.from({ length: count }, (_, i) => makeMessage(i));
}

/** 多次采样取中位数（抗 GC/系统抖动） */
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

  afterAll(() => {
    closeDb();
    try {
      rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // Windows 句柄延迟释放时跳过清理
    }
  });

  // ── 写入基准（每轮独立会话，避免跨轮依赖） ────────────────

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

  // ── 读取基准（固定 10000 条数据，只读） ──────────────────

  describe('读取基准（10000 条消息规模）', () => {
    let bigSessionId: string;

    beforeAll(async () => {
      // 造 10 会话 × 1000 条消息（超消息列表虚拟化决策阈值）
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

  // ── 索引验证（防全表扫描回归） ─────────────────────────────

  describe('索引命中验证', () => {
    it('messages 按 session_id 查询走 idx_messages_session_seq 索引', () => {
      const db = getDb();
      const plan = db.all<{ detail: string }>(sql`EXPLAIN QUERY PLAN
        SELECT * FROM messages WHERE session_id = 'perf-nonexistent'`);
      const detail = plan.map((r) => r.detail).join(' | ');
      console.log(`[perf] EXPLAIN QUERY PLAN: ${detail}`);
      expect(detail, 'session_id 查询必须走索引（SEARCH messages USING INDEX）').toContain(
        'USING INDEX',
      );
    });
  });
});
