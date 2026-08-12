// packages/shared/src/__tests__/shared-gaps.test.ts
// shared 层契约补测：运行时产物正确性 + 单一真源一致性 + 核心 schema 拦截能力
//
// 测试要点：
// 1. request/event 元数据构造器
// 2. deriveChannels 通道派生（camelCase/多段 channel/空表）
// 3. IPC_DEFINITIONS ↔ IPC_META 双向一致性（无孤儿/无缺失/kind 不漂移）
// 4. 核心 schema parse 抽查（file read/write、session list）：正向 + 非法拦截

import { describe, expect, it } from 'vitest';
import { IPC_CHANNELS } from '../ipc/channels';
import { IPC_DEFINITIONS } from '../ipc/definitions';
import { deriveChannels } from '../ipc/derive';
import { event, IPC_META, request } from '../ipc/meta';
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

    it('全量派生：deriveChannels(IPC_META) 与 IPC_CHANNELS 完全一致', () => {
      // IPC_CHANNELS 由 deriveChannels(IPC_META) 生成（同源），此用例守护派生器回归
      expect(deriveChannels(IPC_META)).toEqual(IPC_CHANNELS);
    });

    it('definitions 真源派生：与 meta 派生通道集一致（无孤儿 channel）', () => {
      // definitions 含 schema 的完整真源，channel 必须与 meta 完全同步（无新增/无遗漏）
      const fromDefs = deriveChannels(IPC_DEFINITIONS as never);
      const fromMeta = deriveChannels(IPC_META);
      expect(fromDefs).toEqual(fromMeta);
    });
  });

  describe('单一真源一致性（meta ↔ definitions）', () => {
    it('meta 的每个 domain/method 在 definitions 中存在（无孤儿）', () => {
      const defs = IPC_DEFINITIONS as unknown as Record<string, Record<string, { kind?: string }>>;
      for (const [domain, methods] of Object.entries(IPC_META)) {
        for (const method of Object.keys(methods)) {
          expect(defs[domain]?.[method]).toBeDefined();
        }
      }
    });

    it('definitions 的每个 domain/method 在 meta 中存在（无缺失）', () => {
      for (const [domain, methods] of Object.entries(IPC_DEFINITIONS)) {
        for (const method of Object.keys(methods)) {
          expect(IPC_META[domain as keyof typeof IPC_META]).toBeDefined();
          expect(
            (IPC_META[domain as keyof typeof IPC_META] as Record<string, unknown>)[method],
          ).toBeDefined();
        }
      }
    });

    it('kind 不漂移：definitions 与 meta 的 request/event 分类一致', () => {
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

    it('SessionListReqSchema：limit 越界拦截（0 违反 positive、101 违反 max）', () => {
      expect(SessionListReqSchema.safeParse({ limit: 0 }).success).toBe(false);
      expect(SessionListReqSchema.safeParse({ limit: 101 }).success).toBe(false);
      expect(SessionListReqSchema.safeParse({ limit: 1.5 }).success).toBe(false);
    });
  });
});
