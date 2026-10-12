import { describe, expect, it } from 'vitest';
import { MCPService } from '../../src/main/infra/ai/mcp/mcp-service';
import {
  getSessionService,
  resetSessionService,
} from '../../src/main/infra/storage/session-service';
import { createMcpHandlers } from '../../src/main/ipc/mcp.handler';
import { skillHandlers } from '../../src/main/ipc/skill.handler';
import { taskHandlers } from '../../src/main/ipc/task.handler';
import { withTempUserData } from './helpers/with-db';

describe('外部边界域聚合（batch 9）', () => {
  it('skill：list 返回技能注册表', async () => {
    const res = await skillHandlers.list();
    expect(Array.isArray(res.skills)).toBe(true);
    expect(res.skills.length).toBeGreaterThan(0);
  });

  it('skill：listLearned 返回已学习技能（真实 DB）', async () => {
    resetSessionService();
    await withTempUserData(async () => {
      const res = await skillHandlers.listLearned();
      expect(Array.isArray(res)).toBe(true);
    });
  });

  it('mcp：list 返回 MCP server 配置', async () => {
    const handlers = createMcpHandlers(new MCPService());
    const res = await handlers.list();
    expect(Array.isArray(res.servers)).toBe(true);
  });

  it('task：list 返回会话任务（真实 DB）', async () => {
    resetSessionService();
    await withTempUserData(async () => {
      const sid = await getSessionService().create({
        workingDir: '/proj',
        title: 't',
        messages: [],
      });
      const res = await taskHandlers.list({ sessionId: sid });
      expect(res.tasks).toEqual([]);
    });
  });
});
