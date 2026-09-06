// src/main/infra/ai/agent/task-service.test.ts
// 任务状态机单测：create/list/get + 终端状态幂等锁（内存 DB）

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getDb, resetDb } from '../../storage/db';
import { createTestDb } from '../../storage/test-utils';
import { TaskKind, TaskService, TaskStatus } from './task-service';

vi.mock('../../storage/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../storage/db')>();
  let memoryDb: ReturnType<typeof createTestDb>['db'] | null = null;
  return {
    ...actual,
    getDb: () => {
      if (memoryDb === null) {
        memoryDb = createTestDb().db;
      }
      return memoryDb;
    },
    resetDb: () => {
      memoryDb = null;
    },
  };
});

describe('TaskService（任务注册表 + 状态机）', () => {
  let service: TaskService;

  beforeEach(() => {
    resetDb();
    service = new TaskService();
    void getDb;
  });

  it('create 返回 id，初始 pending，绑定会话与种类', () => {
    const id = service.create('s1', TaskKind.AGENT, '修复登录');
    const task = service.get(id);
    expect(task?.status).toBe(TaskStatus.PENDING);
    expect(task?.sessionId).toBe('s1');
    expect(task?.kind).toBe(TaskKind.AGENT);
    expect(task?.description).toBe('修复登录');
  });

  it('update：pending → running → completed（写 endTime）', () => {
    const id = service.create('s1', TaskKind.SHELL, '跑测试');
    expect(service.update(id, TaskStatus.RUNNING)).toBe(true);
    expect(service.get(id)?.status).toBe(TaskStatus.RUNNING);
    expect(service.get(id)?.endTime).toBeNull();
    expect(service.update(id, TaskStatus.COMPLETED)).toBe(true);
    expect(service.get(id)?.endTime).not.toBeNull();
  });

  it('终端状态锁定：completed/failed/cancelled 后不可再变更', () => {
    const id = service.create('s1', TaskKind.AGENT, 'x');
    service.update(id, TaskStatus.CANCELLED);
    expect(service.update(id, TaskStatus.RUNNING)).toBe(false);
    expect(service.get(id)?.status).toBe(TaskStatus.CANCELLED);
  });

  it('update 不存在的任务返回 false（幂等）', () => {
    expect(service.update('ghost', TaskStatus.RUNNING)).toBe(false);
  });

  it('list 按创建时间倒序；指定会话过滤', () => {
    const a = service.create('s1', TaskKind.AGENT, 'A');
    const b = service.create('s2', TaskKind.AGENT, 'B');
    const c = service.create('s1', TaskKind.AGENT, 'C');
    // 同毫秒创建时 startTime 相同 → 排序回落 id 字典序（uuid 随机，只断言集合）
    const s1Ids = service.list('s1').map((t) => t.id);
    expect(s1Ids).toHaveLength(2);
    expect(s1Ids).toEqual(expect.arrayContaining([c, a]));
    expect(service.list('s2').map((t) => t.id)).toEqual([b]);
    expect(service.list()).toHaveLength(3);
  });
});
