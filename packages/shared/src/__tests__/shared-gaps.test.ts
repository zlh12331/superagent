// packages/shared/src/__tests__/shared-gaps.test.ts
// shared 层契约补测：运行时产物正确性 + 单一真源一致性 + 核心 schema 拦截能力
//
// 测试要点：
// 1. request/event 元数据构造器
// 2. deriveChannels 通道派生（camelCase/多段 channel/空表）
// 3. IPC_DEFINITIONS ↔ IPC_META 双向一致性（无孤儿/无缺失/kind 不漂移）
// 4. 核心 schema parse 抽查（file read/write、session list）：正向 + 非法拦截

import { describe, expect, it } from 'vitest';
import { IPC_DEFINITIONS } from '../ipc/definitions';
import { deriveChannels } from '../ipc/derive';
import { event, IPC_META, request } from '../ipc/meta';
import { AgentRunReqSchema } from '../schemas/agent';
import { FileReadReqSchema, FileWriteReqSchema } from '../schemas/file';
import { SessionListReqSchema } from '../schemas/session';

describe('shared 层契约补测', () => {
  describe('元数据构造器', () => {
    it('request：kind=request + channel 透传', () => {
      expect(request('app:getStatus')).toEqual({ kind: 'request', channel: 'app:getStatus' });
    });

    it('event：kind=event + channel 透传', () => {
      expect(event('agent:stream:part')).toEqual({ kind: 'event', channel: 'agent:stream:part' });
    });
  });

  describe('deriveChannels 通道派生', () => {
    it('camelCase 方法 → SCREAMING_SNAKE_CASE（含多段 channel）', () => {
      const derived = deriveChannels({
        app: { getStatus: request('app:getStatus') },
        session: { listRecentDirs: request('session:listRecentDirs') },
        chat: { streamPart: event('chat:stream:part') },
      });
      expect(derived).toEqual({
        ['APP_GET_STATUS']: 'app:getStatus',
        ['SESSION_LIST_RECENT_DIRS']: 'session:listRecentDirs',
        ['CHAT_STREAM_PART']: 'chat:stream:part',
      });
    });

    it('空定义表 → 空对象', () => {
      expect(deriveChannels({})).toEqual({});
    });

    it('definitions 真源派生：与 meta 派生通道集一致（无孤儿 channel）', () => {
      // definitions 含 schema 的完整真源，channel 必须与 meta 完全同步（无新增/无遗漏）
      // 注意：不能依赖 IPC_CHANNELS 自比（其自身就是 deriveChannels(IPC_META) 的同源产物）
      const fromDefs = deriveChannels(IPC_DEFINITIONS);
      const fromMeta = deriveChannels(IPC_META);
      expect(fromDefs).toEqual(fromMeta);
      // key 与 value 一一对应（toConstantKey 冲突会静默覆盖，防止 channel 丢失）
      expect(Object.keys(fromMeta)).toHaveLength(Object.values(fromMeta).length);
    });
  });

  describe('单一真源一致性（meta ↔ definitions）', () => {
    it('双向覆盖：meta 与 definitions 的 domain/method 完全对齐（无孤儿/无缺失）', () => {
      const defs = IPC_DEFINITIONS as unknown as Record<string, Record<string, { kind?: string }>>;
      const meta = IPC_META as unknown as Record<string, Record<string, { kind?: string }>>;
      // meta ⊆ definitions：meta 条目在 definitions 必须存在（防手写孤儿）
      for (const [domain, methods] of Object.entries(meta)) {
        for (const method of Object.keys(methods)) {
          expect(defs[domain]?.[method]).toBeDefined();
        }
      }
      // definitions ⊆ meta：definitions 条目在 meta 必须存在（防新增遗漏）
      for (const [domain, methods] of Object.entries(defs)) {
        for (const method of Object.keys(methods)) {
          expect(meta[domain]?.[method]).toBeDefined();
        }
      }
    });

    it('kind 不漂移：definitions 与 meta 的 request/event 分类一致', () => {
      // 编译期已由 withSchema/withPayload 的泛型约束保证（运行时为防御手写条目）
      const defs = IPC_DEFINITIONS as unknown as Record<string, Record<string, { kind?: string }>>;
      const meta = IPC_META as unknown as Record<string, Record<string, { kind?: string }>>;
      for (const [domain, methods] of Object.entries(defs)) {
        for (const [method, def] of Object.entries(methods)) {
          expect(def.kind).toBe(meta[domain]?.[method]?.kind);
        }
      }
    });
  });

  describe('核心 schema parse 抽查（契约拦截能力）', () => {
    it('FileReadReqSchema：正向解析', () => {
      const result = FileReadReqSchema.safeParse({ path: '/a.txt', offset: 0, limit: 100 });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.path).toBe('/a.txt');
      }
    });

    it('FileReadReqSchema：缺必填 path → 拦截', () => {
      expect(FileReadReqSchema.safeParse({}).success).toBe(false);
    });

    it('FileReadReqSchema：path 空串（min(1)）→ 拦截；非字符串 → 拦截', () => {
      expect(FileReadReqSchema.safeParse({ path: '' }).success).toBe(false);
      expect(FileReadReqSchema.safeParse({ path: 42 }).success).toBe(false);
    });

    it('FileWriteReqSchema：正向解析（path + content）', () => {
      const result = FileWriteReqSchema.safeParse({ path: '/a.txt', content: 'hello' });
      expect(result.success).toBe(true);
    });

    it('FileWriteReqSchema：缺 content → 拦截', () => {
      expect(FileWriteReqSchema.safeParse({ path: '/a.txt' }).success).toBe(false);
    });

    it('SessionListReqSchema：空入参 → 默认值生效（limit=50/offset=0）', () => {
      const result = SessionListReqSchema.safeParse({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.limit).toBe(50);
        expect(result.data.offset).toBe(0);
      }
    });

    it('SessionListReqSchema：limit 越界拦截（0 违反 positive、101 违反 max、1.5 违反 int）', () => {
      expect(SessionListReqSchema.safeParse({ limit: 0 }).success).toBe(false);
      expect(SessionListReqSchema.safeParse({ limit: 101 }).success).toBe(false);
      expect(SessionListReqSchema.safeParse({ limit: 1.5 }).success).toBe(false);
    });

    it('AgentRunReqSchema：temperature 缺省 → undefined；0-2 正向解析', () => {
      const base = {
        messages: [{ role: 'user', content: 'hi' }],
        sessionId: 's1',
        workingDir: '/tmp/proj',
        maxSteps: 5,
      };
      const omitted = AgentRunReqSchema.safeParse(base);
      expect(omitted.success).toBe(true);
      if (omitted.success) {
        expect(omitted.data.temperature).toBeUndefined();
      }
      const parsed = AgentRunReqSchema.safeParse({ ...base, temperature: 0.3 });
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.temperature).toBe(0.3);
      }
    });

    it('AgentRunReqSchema：temperature 越界/非法类型 → 拦截', () => {
      const base = {
        messages: [{ role: 'user', content: 'hi' }],
        workingDir: '/tmp/proj',
      };
      expect(AgentRunReqSchema.safeParse({ ...base, temperature: -0.1 }).success).toBe(false);
      expect(AgentRunReqSchema.safeParse({ ...base, temperature: 2.1 }).success).toBe(false);
      expect(AgentRunReqSchema.safeParse({ ...base, temperature: 'hot' }).success).toBe(false);
    });
  });
});
