// src/main/infra/ai/permission-service.test.ts
// PermissionService 单测：权限决策 + 审批流（安全关键模块）
//
// 测试要点：
// 1. decide：默认返回 tool.permission；记忆命中（approved→auto / denied→ask）；过期记忆惰性清理
// 2. requestApproval：推送 AGENT_APPROVAL_REQUEST；abortSignal 中断立即 reject；超时 reject；webContents 销毁 reject
// 3. handleApprovalResponse：resolve 对应 Promise；rememberDecision 缓存决策
// 4. dispose：reject 所有 pending，清理记忆
// 5. stableStringify：键顺序不影响记忆 key

import { ErrorCode, IPC_CHANNELS } from '@code-agent/shared';
import type { WebContents } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { generateApprovalId, PermissionService } from './permission-service';
import type { Tool } from './tool';

const mocks = vi.hoisted(() => ({
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../utils/logger', () => ({ logger: mocks.mockLogger }));

/** 创建 mock 工具 */
function createMockTool(permission: 'auto' | 'ask' = 'ask'): Tool {
  return {
    name: 'mock_tool',
    description: 'Mock 工具',
    inputSchema: undefined as unknown as Tool['inputSchema'],
    permission,
    execute: vi.fn(),
  } as unknown as Tool;
}

/** 创建 mock WebContents */
function createMockWebContents(): WebContents {
  return {
    isDestroyed: vi.fn(() => false),
    send: vi.fn(),
  } as unknown as WebContents;
}

/** 创建审批请求 payload */
function createApprovalPayload(
  overrides: Partial<Parameters<PermissionService['requestApproval']>[0]> = {},
) {
  return {
    sessionId: 'session-1',
    approvalId: 'approval-1',
    toolCallId: 'call-1',
    toolName: 'mock_tool',
    input: { path: '/tmp/a.ts' },
    description: '写入文件 /tmp/a.ts',
    ...overrides,
  };
}

describe('PermissionService', () => {
  let service: PermissionService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new PermissionService();
  });

  describe('decide', () => {
    it('默认：返回 tool.permission（auto 工具直接执行）', () => {
      const tool = createMockTool('auto');
      const decision = service.decide(tool, { path: '/tmp/a.ts' });
      expect(decision).toEqual({ permission: 'auto', description: 'Mock 工具' });
    });

    it('默认：返回 tool.permission（ask 工具需审批）', () => {
      const tool = createMockTool('ask');
      const decision = service.decide(tool, { path: '/tmp/a.ts' });
      expect(decision.permission).toBe('ask');
    });

    it('记忆命中（approved）：返回 auto（不再询问）', () => {
      const tool = createMockTool('ask');
      service.rememberDecision(tool, { path: '/tmp/a.ts' }, true);
      const decision = service.decide(tool, { path: '/tmp/a.ts' });
      expect(decision.permission).toBe('auto');
    });

    it('记忆命中（denied）：返回 ask（重新询问，避免锁死）', () => {
      const tool = createMockTool('ask');
      service.rememberDecision(tool, { path: '/tmp/a.ts' }, false);
      const decision = service.decide(tool, { path: '/tmp/a.ts' });
      expect(decision.permission).toBe('ask');
    });

    it('输入不同（路径不同）：不命中记忆', () => {
      const tool = createMockTool('ask');
      service.rememberDecision(tool, { path: '/tmp/a.ts' }, true);
      const decision = service.decide(tool, { path: '/tmp/b.ts' });
      expect(decision.permission).toBe('ask');
    });

    it('对象键顺序不同：记忆 key 相同（stable stringify）', () => {
      const tool = createMockTool('ask');
      service.rememberDecision(tool, { path: '/tmp/a.ts', mode: 'write' }, true);
      const decision = service.decide(tool, { mode: 'write', path: '/tmp/a.ts' });
      expect(decision.permission).toBe('auto');
    });
  });

  describe('requestApproval + handleApprovalResponse', () => {
    it('推送审批请求并等待响应；响应后 resolve true', async () => {
      const wc = createMockWebContents();
      const promise = service.requestApproval(
        createApprovalPayload(),
        createMockTool(),
        { path: '/tmp/a.ts' },
        wc,
      );

      // 推送事件
      expect(wc.send).toHaveBeenCalledWith(
        IPC_CHANNELS.AGENT_APPROVAL_REQUEST,
        expect.objectContaining({ approvalId: 'approval-1' }),
      );

      // 用户批准
      service.handleApprovalResponse('approval-1', true, false);
      await expect(promise).resolves.toBe(true);
    });

    it('用户拒绝：resolve false', async () => {
      const wc = createMockWebContents();
      const promise = service.requestApproval(
        createApprovalPayload(),
        createMockTool(),
        { path: '/tmp/a.ts' },
        wc,
      );

      service.handleApprovalResponse('approval-1', false, false);
      await expect(promise).resolves.toBe(false);
    });

    it('rememberDecision=true：缓存决策，下次 decide 返回 auto', async () => {
      const wc = createMockWebContents();
      const tool = createMockTool('ask');
      const promise = service.requestApproval(
        createApprovalPayload(),
        tool,
        { path: '/tmp/a.ts' },
        wc,
      );
      service.handleApprovalResponse('approval-1', true, true);
      await promise;

      const decision = service.decide(tool, { path: '/tmp/a.ts' });
      expect(decision.permission).toBe('auto');
    });

    it('未知 approvalId：忽略（已超时或不存在）', () => {
      expect(() => service.handleApprovalResponse('nonexistent', true, false)).not.toThrow();
    });

    it('webContents 已销毁：立即 reject', async () => {
      const wc = { isDestroyed: vi.fn(() => true), send: vi.fn() } as unknown as WebContents;
      await expect(
        service.requestApproval(
          createApprovalPayload(),
          createMockTool(),
          { path: '/tmp/a.ts' },
          wc,
        ),
      ).rejects.toMatchObject({ code: ErrorCode.TOOL_PERMISSION_DENIED });
    });

    it('abortSignal 已中断：立即 reject（TOOL_ABORTED）', async () => {
      const wc = createMockWebContents();
      const controller = new AbortController();
      controller.abort();
      await expect(
        service.requestApproval(
          createApprovalPayload(),
          createMockTool(),
          { path: '/tmp/a.ts' },
          wc,
          controller.signal,
        ),
      ).rejects.toMatchObject({ code: ErrorCode.TOOL_ABORTED });
    });

    it('审批等待期间 abort：reject（TOOL_ABORTED）', async () => {
      const wc = createMockWebContents();
      const controller = new AbortController();
      const promise = service.requestApproval(
        createApprovalPayload(),
        createMockTool(),
        { path: '/tmp/a.ts' },
        wc,
        controller.signal,
      );
      controller.abort();
      await expect(promise).rejects.toMatchObject({ code: ErrorCode.TOOL_ABORTED });
    });
  });

  describe('dispose', () => {
    it('reject 所有 pending 审批', async () => {
      const wc = createMockWebContents();
      const promise1 = service.requestApproval(
        createApprovalPayload({ approvalId: 'a1' }),
        createMockTool(),
        {},
        wc,
      );
      const promise2 = service.requestApproval(
        createApprovalPayload({ approvalId: 'a2' }),
        createMockTool(),
        {},
        wc,
      );

      service.dispose();

      await expect(promise1).rejects.toMatchObject({ code: ErrorCode.TOOL_ABORTED });
      await expect(promise2).rejects.toMatchObject({ code: ErrorCode.TOOL_ABORTED });
    });

    it('清空记忆决策', () => {
      const tool = createMockTool('ask');
      service.rememberDecision(tool, { path: '/tmp/a.ts' }, true);
      service.dispose();
      const decision = service.decide(tool, { path: '/tmp/a.ts' });
      expect(decision.permission).toBe('ask');
    });
  });

  describe('generateApprovalId', () => {
    it('生成 UUID v4 格式 id', () => {
      const id = generateApprovalId();
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    });
  });
});
