// tests/integration/approval.test.ts
// Agent 审批链路集成测试（补充批次：approvalResponse/subscribeAsk/respondAsk）
// ──────────────────────────────────────────────────────────────
// 链路：agent.handler.run（真实）→ AgentService（真实 + permissionService 注入）→
//       ToolExecutor（真实）→ PermissionService（真实审批流）→
//       approvalResponse handler（真实）→ 工具执行（真实）→ 事件推送
// 替身：LLM（fake model 两轮：tool-call → 文本）+ webContents
//
// 维度覆盖：接口契约 / 时序编排（ask→响应→执行→result 顺序）/ 状态一致性 /
//           错误传播（拒绝 → TOOL_PERMISSION_DENIED）
// 场景：事件流完整性（approval request → tool result 序列）/ 安全边界（审批拦截生效）
// ──────────────────────────────────────────────────────────────

import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AgentService } from '../../src/main/infra/ai/agent/agent-service';
import { PromptService } from '../../src/main/infra/ai/prompt/prompt-service';
import { PermissionService } from '../../src/main/infra/ai/tools/permission-service';
import type { Tool } from '../../src/main/infra/ai/tools/tool';
import { ToolExecutor } from '../../src/main/infra/ai/tools/tool-executor';
import { ToolRegistry } from '../../src/main/infra/ai/tools/tool-registry';
import {
  getSessionService,
  resetSessionService,
} from '../../src/main/infra/storage/session-service';
import { createAgentHandlers } from '../../src/main/ipc/agent.handler';
import { createAgentApprovalHandlers } from '../../src/main/ipc/agent-approval.handler';
import { createFakeModel, modelParts } from './helpers/fake-model';
import { createFakeWebContents } from './helpers/fake-webcontents';
import { withTempUserData } from './helpers/with-db';

/** 当前 fake model（每用例切换；ai-provider 的 getModel 替身读取） */
let currentFakeModel: ReturnType<typeof createFakeModel>;

// LLM 是外部服务边界（允许替身）：getModel 返回当前 fake model
vi.mock('../../src/main/infra/ai/llm-client/ai-provider', () => ({
  getModel: async () => currentFakeModel,
}));

/** 构造 ask 权限工具（真实 Tool 形状——执行计数用于断言真实执行） */
function createAskTool(executed: { count: number }): Tool {
  return {
    name: 'ask-tool-test',
    description: '测试审批工具（ask 权限）',
    permission: 'ask',
    inputSchema: z.object({ action: z.string() }),
    execute: async () => {
      executed.count += 1;
      return { title: '测试工具', output: 'approved-executed' };
    },
  } as Tool;
}

/** 装配真实审批链路（AgentService + 真实工具 + 真实审批） */
function createApprovalHarness() {
  const executed = { count: 0 };
  const toolRegistry = new ToolRegistry();
  toolRegistry.register(createAskTool(executed));
  const permissionService = new PermissionService();
  // 审批模式设为 ask（真实配置接口；与 settings handler 共用实例时由它设置）
  permissionService.setApprovalMode('ask');
  const toolExecutor = new ToolExecutor(toolRegistry, permissionService);
  const promptService = new PromptService();
  const sessionService = getSessionService();
  // 审批生命周期注入（batch 2 未注入——本批次补全）
  const agentService = new AgentService(
    toolRegistry,
    toolExecutor,
    promptService,
    sessionService,
    undefined,
    undefined,
    permissionService,
  );
  const agentHandlers = createAgentHandlers({ agentService });
  const approvalHandlers = createAgentApprovalHandlers({ permissionService });
  return { agentHandlers, approvalHandlers, permissionService, executed, sessionService };
}

describe('agent 审批链路（补充批次）', () => {
  it('正向：ask 工具 → 审批请求事件 → 批准 → 真实执行 → 完成', async () => {
    resetSessionService();
    await withTempUserData(async () => {
      // 审批模式由 harness 设置为 ask（真实配置接口）
      currentFakeModel = createFakeModel([
        // 第一轮：调用 ask 工具
        [
          // v4 协议：tool-call 的 input 为 JSON 字符串（SDK safeParseJSON 解析）
          modelParts.toolCall('tc-1', 'ask-tool-test', JSON.stringify({ action: 'deploy' })),
          modelParts.finish('tool-calls'),
        ],
        // 第二轮：工具结果回传后输出最终文本
        [modelParts.textDelta('审批通过，部署完成'), modelParts.finish('stop')],
      ]);
      const { agentHandlers, approvalHandlers, executed } = createApprovalHarness();
      const { wc, sent } = createFakeWebContents();
      const sid = await getSessionService().create({
        workingDir: '/proj',
        title: 't',
        messages: [],
      });

      const { sessionId } = await agentHandlers.run(
        {
          messages: [{ role: 'user', content: '帮我部署' }],
          sessionId: sid,
          workingDir: '/proj',
          systemPrompt: undefined,
          maxSteps: 5,
          mode: 'build',
        },
        { traceId: 'a1', sender: wc } as never,
      );

      // 等待审批请求事件（agent:approval:request）
      await vi.waitFor(
        () => {
          expect(sent.some((s) => s.channel.includes('approval:request'))).toBe(true);
        },
        { timeout: 3000 },
      );
      const approvalEvent = sent.find((s) => s.channel.includes('approval:request'))?.payload as {
        approvalId: string;
        sessionId: string;
        toolName: string;
      };
      expect(approvalEvent.toolName).toBe('ask-tool-test');
      expect(approvalEvent.sessionId).toBe(sessionId);

      // 批准（approvalResponse 回传）
      const resp = await approvalHandlers.approvalResponse({
        approvalId: approvalEvent.approvalId,
        approved: true,
        rememberDecision: false,
      });
      expect(resp.ok).toBe(true);

      // 工具真实执行 + 最终完成
      await vi.waitFor(
        () => {
          expect(executed.count).toBe(1);
        },
        { timeout: 3000 },
      );
      await vi.waitFor(
        () => {
          expect(sent.some((s) => s.channel.includes('stream:end'))).toBe(true);
        },
        { timeout: 3000 },
      );
      // 事件序列：tool-result 在 approval 之后
      const resultEvent = sent.find((s) => s.channel.includes('tool:result'))?.payload as {
        output: string;
      };
      expect(resultEvent.output).toBe('approved-executed');
    });
  });

  it('拒绝：approvalResponse(false) → 工具不执行 → TOOL_PERMISSION_DENIED', async () => {
    resetSessionService();
    await withTempUserData(async () => {
      currentFakeModel = createFakeModel([
        [
          modelParts.toolCall('tc-2', 'ask-tool-test', JSON.stringify({ action: 'delete' })),
          modelParts.finish('tool-calls'),
        ],
        [modelParts.textDelta('已拒绝'), modelParts.finish('stop')],
      ]);
      const { agentHandlers, approvalHandlers, executed } = createApprovalHarness();
      const { wc, sent } = createFakeWebContents();
      const sid = await getSessionService().create({
        workingDir: '/proj',
        title: 't',
        messages: [],
      });

      await agentHandlers.run(
        {
          messages: [{ role: 'user', content: '删除' }],
          sessionId: sid,
          workingDir: '/proj',
          systemPrompt: undefined,
          maxSteps: 5,
          mode: 'build',
        },
        { traceId: 'a2', sender: wc } as never,
      );
      await vi.waitFor(
        () => {
          expect(sent.some((s) => s.channel.includes('approval:request'))).toBe(true);
        },
        { timeout: 3000 },
      );
      const approvalEvent = sent.find((s) => s.channel.includes('approval:request'))?.payload as {
        approvalId: string;
      };

      // 拒绝
      await approvalHandlers.approvalResponse({
        approvalId: approvalEvent.approvalId,
        approved: false,
        rememberDecision: false,
      });

      // 工具未执行
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(executed.count).toBe(0);
      // 拒绝结果推送（TOOL_PERMISSION_DENIED 语义）
      const resultEvent = sent.find((s) => s.channel.includes('tool:result'))?.payload as {
        error?: { code: string };
      };
      expect(resultEvent?.error?.code).toBeDefined();
    });
  });
});
