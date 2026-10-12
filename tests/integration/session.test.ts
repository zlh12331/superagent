import { readFileSync } from 'node:fs';
import type { ChatMessage } from '@code-agent/shared/main';
import { describe, expect, it } from 'vitest';
import {
  getSessionService,
  resetSessionService,
  type SessionService,
} from '../../src/main/infra/storage/session-service';
import { createSessionHandlers } from '../../src/main/ipc/session.handler';
import { setDialogResult, withTempUserData } from './helpers/with-db';

/** 构造 ChatMessage（最小字段） */
function makeMessage(content: string): ChatMessage {
  return { id: `m-${content.length}`, role: 'user', content } as unknown as ChatMessage;
}

describe('session 域集成链路（batch 1）', () => {
  it('正向生命周期：create → list → get 完整往返', async () => {
    resetSessionService();
    await withTempUserData(async () => {
      const svc = getSessionService() as SessionService;
      const handlers = createSessionHandlers({ sessionService: svc });

      const { sessionId } = await handlers.create({ workingDir: '/proj', title: undefined });
      const list = await handlers.list({ limit: 50, offset: 0 });
      expect(list.total).toBe(1);
      expect(list.sessions[0]?.id).toBe(sessionId);
      expect(list.sessions[0]?.title).toBe('新会话');

      const detail = await handlers.get({ id: sessionId });
      expect(detail.session.id).toBe(sessionId);
      expect(detail.messages).toEqual([]);
    });
  });

  it('正向：create 带初始消息 → get 消息完整（序列化往返）', async () => {
    resetSessionService();
    await withTempUserData(async () => {
      const svc = getSessionService() as SessionService;
      const handlers = createSessionHandlers({ sessionService: svc });

      const msgs = [makeMessage('你好，帮我看看这个项目'), makeMessage('好的，正在分析')];
      const sessionId = await svc.create({ workingDir: '/proj', title: undefined, messages: msgs });
      const detail = await handlers.get({ id: sessionId, includeMessages: true });
      expect(detail.messages).toHaveLength(2);
      expect(detail.session.title).toBe('你好，帮我看看这个项目');
      expect(detail.session.messageCount).toBe(2);
    });
  });

  it('正向：rename + pin 反映到 get', async () => {
    resetSessionService();
    await withTempUserData(async () => {
      const svc = getSessionService() as SessionService;
      const handlers = createSessionHandlers({ sessionService: svc });

      const { sessionId } = await handlers.create({ workingDir: '/proj', title: '原名' });
      await handlers.rename({ id: sessionId, title: '新名' });
      await handlers.pin({ id: sessionId, pinned: true });

      const detail = await handlers.get({ id: sessionId });
      expect(detail.session.title).toBe('新名');
      expect(detail.session.pinned).toBe(true);

      const { sessionId: sid2 } = await handlers.create({ workingDir: '/proj2', title: '普通' });
      await handlers.pin({ id: sessionId, pinned: true });
      const list = await handlers.list({ limit: 50, offset: 0 });
      expect(list.sessions[0]?.id).toBe(sessionId);
      expect(list.sessions[0]?.pinned).toBe(true);
      expect(list.sessions[1]?.id).toBe(sid2);
    });
  });

  it('正向：delete 级联删除消息（get 后 SESSION_NOT_FOUND）', async () => {
    resetSessionService();
    await withTempUserData(async () => {
      const svc = getSessionService() as SessionService;
      const handlers = createSessionHandlers({ sessionService: svc });

      const { sessionId } = await handlers.create({
        workingDir: '/proj',
        title: undefined,
        messages: [makeMessage('内容')],
      });
      const res = await handlers.delete({ id: sessionId });
      expect(res.ok).toBe(true);
      await expect(handlers.get({ id: sessionId })).rejects.toMatchObject({
        code: 'SESSION_NOT_FOUND',
      });
    });
  });

  it('正向：appendMessage 追加后 messageCount 递增且消息完整', async () => {
    resetSessionService();
    await withTempUserData(async () => {
      const svc = getSessionService() as SessionService;
      const handlers = createSessionHandlers({ sessionService: svc });

      const { sessionId } = await handlers.create({ workingDir: '/proj', title: 't' });
      await svc.appendMessage({ sessionId, messages: [makeMessage('第一轮')] });
      const appendRes = await svc.appendMessage({ sessionId, messages: [makeMessage('第二轮')] });
      void appendRes;

      const detail = await handlers.get({ id: sessionId, includeMessages: true });
      expect(detail.messages).toHaveLength(2);
      expect(detail.session.messageCount).toBe(2);
    });
  });

  it('正向：listRecentDirs 去重 + 按最后使用倒序', async () => {
    resetSessionService();
    await withTempUserData(async () => {
      const svc = getSessionService() as SessionService;
      const handlers = createSessionHandlers({ sessionService: svc });

      await handlers.create({ workingDir: '/a', title: '1' });
      await new Promise((resolve) => setTimeout(resolve, 2));
      await handlers.create({ workingDir: '/b', title: '2' });
      await new Promise((resolve) => setTimeout(resolve, 2));
      await handlers.create({ workingDir: '/a', title: '3' });

      const { dirs } = await handlers.listRecentDirs({ limit: 10 });
      expect(dirs).toHaveLength(2);
      expect(dirs[0]?.workingDir).toBe('/a');
      expect(dirs[1]?.workingDir).toBe('/b');
    });
  });

  it('正向：exportAll 写文件（dialog 保存路径 → 文件内容含会话）', async () => {
    resetSessionService();
    await withTempUserData(async () => {
      const { mkdtempSync, rmSync } = await import('node:fs');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const exportDir = mkdtempSync(join(tmpdir(), 'code-agent-export-'));
      try {
        const svc = getSessionService() as SessionService;
        const handlers = createSessionHandlers({ sessionService: svc });
        await svc.create({ workingDir: '/proj', title: '导出我', messages: [makeMessage('数据')] });

        const exportPath = join(exportDir, 'sessions.json');
        setDialogResult({ canceled: false, filePath: exportPath });
        const res = await handlers.exportAll();
        expect(res.saved).toBe(true);
        expect(res.path).toBe(exportPath);

        const payload = JSON.parse(readFileSync(exportPath, 'utf-8')) as {
          app: string;
          sessions: Array<{ meta: { title: string }; messages: unknown[] }>;
        };
        expect(payload.app).toBe('code-agent-desktop');
        expect(payload.sessions).toHaveLength(1);
        expect(payload.sessions[0]?.meta.title).toBe('导出我');
        expect(payload.sessions[0]?.messages).toHaveLength(1);
      } finally {
        setDialogResult({ canceled: true });
        rmSync(exportDir, { recursive: true, maxRetries: 5 });
      }
    });
  });

  it('边界：list 分页（limit=1 + offset 翻页）', async () => {
    resetSessionService();
    await withTempUserData(async () => {
      const svc = getSessionService() as SessionService;
      const handlers = createSessionHandlers({ sessionService: svc });

      await handlers.create({ workingDir: '/a', title: '1' });
      await handlers.create({ workingDir: '/b', title: '2' });
      await handlers.create({ workingDir: '/c', title: '3' });

      const page1 = await handlers.list({ limit: 1, offset: 0 });
      expect(page1.sessions).toHaveLength(1);
      expect(page1.total).toBe(3);
      const page2 = await handlers.list({ limit: 1, offset: 1 });
      expect(page2.sessions[0]?.id).not.toBe(page1.sessions[0]?.id);
    });
  });

  it('边界：空列表 total=0', async () => {
    resetSessionService();
    await withTempUserData(async () => {
      const svc = getSessionService() as SessionService;
      const handlers = createSessionHandlers({ sessionService: svc });
      const list = await handlers.list({ limit: 50, offset: 0 });
      expect(list.total).toBe(0);
      expect(list.sessions).toEqual([]);
    });
  });

  it('边界：超大标题截断到 100 字符', async () => {
    resetSessionService();
    await withTempUserData(async () => {
      const svc = getSessionService() as SessionService;
      const handlers = createSessionHandlers({ sessionService: svc });

      const longTitle = '长'.repeat(200);
      const { sessionId } = await handlers.create({ workingDir: '/proj', title: longTitle });
      const detail = await handlers.get({ id: sessionId });
      expect(detail.session.title.length).toBe(100);
    });
  });

  it('边界：listRecentDirs 空 workingDir 过滤（旧会话兼容）', async () => {
    resetSessionService();
    await withTempUserData(async () => {
      const svc = getSessionService() as SessionService;
      const handlers = createSessionHandlers({ sessionService: svc });

      await handlers.create({ workingDir: '', title: '旧' });
      await handlers.create({ workingDir: '/real', title: '新' });
      const { dirs } = await handlers.listRecentDirs({ limit: 10 });
      expect(dirs).toHaveLength(1);
      expect(dirs[0]?.workingDir).toBe('/real');
    });
  });

  it('异常：get 不存在 → SESSION_NOT_FOUND', async () => {
    resetSessionService();
    await withTempUserData(async () => {
      const svc = getSessionService() as SessionService;
      const handlers = createSessionHandlers({ sessionService: svc });
      await expect(handlers.get({ id: 'ghost' })).rejects.toMatchObject({
        code: 'SESSION_NOT_FOUND',
      });
    });
  });

  it('异常：rename 不存在 → SESSION_NOT_FOUND', async () => {
    resetSessionService();
    await withTempUserData(async () => {
      const svc = getSessionService() as SessionService;
      const handlers = createSessionHandlers({ sessionService: svc });
      await expect(handlers.rename({ id: 'ghost', title: 'x' })).rejects.toMatchObject({
        code: 'SESSION_NOT_FOUND',
      });
    });
  });

  it('异常+幂等：delete/pin 不存在会话不抛错', async () => {
    resetSessionService();
    await withTempUserData(async () => {
      const svc = getSessionService() as SessionService;
      const handlers = createSessionHandlers({ sessionService: svc });

      expect((await handlers.delete({ id: 'ghost' })).ok).toBe(true);
      expect((await handlers.pin({ id: 'ghost', pinned: true })).ok).toBe(false);
      const { sessionId } = await handlers.create({ workingDir: '/proj', title: 't' });
      await handlers.delete({ id: sessionId });
      expect((await handlers.delete({ id: sessionId })).ok).toBe(true);
    });
  });

  it('持久化往返：create 后重开 DB → 数据完整', async () => {
    resetSessionService();
    await withTempUserData(async () => {
      const { closeDb, initDb } = await import('../../src/main/infra/storage/db');
      const svc = getSessionService() as SessionService;

      const sessionId = await svc.create({
        workingDir: '/proj',
        title: '持久',
        messages: [makeMessage('第一')],
      });

      await closeDb();
      initDb();
      const svc2 = getSessionService() as SessionService;
      const handlers2 = createSessionHandlers({ sessionService: svc2 });
      const detail = await handlers2.get({ id: sessionId, includeMessages: true });
      expect(detail.session.title).toBe('持久');
      expect(detail.messages).toHaveLength(1);
    });
  });

  it('并发：并行 create 互不干扰', async () => {
    resetSessionService();
    await withTempUserData(async () => {
      const svc = getSessionService() as SessionService;
      const handlers = createSessionHandlers({ sessionService: svc });

      await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          handlers.create({ workingDir: `/proj-${i}`, title: `会话${i}` }),
        ),
      );
      const list = await handlers.list({ limit: 50, offset: 0 });
      expect(list.total).toBe(10);
    });
  });

  it('事务原子性：create 带 messages → get 无孤立（消息与会话同批落库）', async () => {
    resetSessionService();
    await withTempUserData(async () => {
      const svc = getSessionService() as SessionService;
      const handlers = createSessionHandlers({ sessionService: svc });

      const sessionId = await svc.create({
        workingDir: '/proj',
        title: '原子',
        messages: [makeMessage('m1'), makeMessage('m2'), makeMessage('m3')],
      });
      const detail = await handlers.get({ id: sessionId, includeMessages: true });
      expect(detail.messages).toHaveLength(3);
      expect((detail.messages[0] as { content: string }).content).toBe('m1');
      expect((detail.messages[2] as { content: string }).content).toBe('m3');
    });
  });
});
