// tests/integration/external-domains.test.ts
// 外部边界域聚合集成测试（batch 9/9：skill/mcp/task）
// ──────────────────────────────────────────────────────────────
// 链路：IPC handler（真实）→ 注册表/服务（真实）→ DB（临时 userData）
//
// 豁免记录（13 链路——客观不可达，快通道复核通过）：
// - audio start/append/stop：真实硬件（麦克风）采集——需真实设备
// - im start/stop：真实 IM 平台账号/凭据（企业微信/钉钉/QQ 应用）
// - mcp start/stop：真实 MCP server 外部服务
// - update check/install/subscribeStatus：electron-updater 运行时（测试环境无应用壳）
// - skill learn/removeLearned：learn 需真实 LLM 提炼；removeLearned 单测已覆盖
// 证据：全部为"需真实外部环境"类（硬件/平台账号/外部服务/SDK 运行时）
// ──────────────────────────────────────────────────────────────

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
    // 内置技能（Code Agent 提示词等）非空
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
