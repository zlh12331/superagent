// src/main/infra/ai/tool-executor.test.ts
// ToolExecutor 单测：统一工具执行入口（权限检查 + 审批流 + plan 模式只读约束）
//
// 测试要点：
// 1. 工具不存在 → TOOL_NOT_FOUND 错误结果
// 2. permission='auto'：直接执行
// 3. permission='ask' + 批准 → 执行；拒绝 → TOOL_PERMISSION_DENIED
// 4. plan 模式 + ask 工具 → 直接拒绝（不请求审批，零副作用）★ 核心新特性
// 5. plan 模式 + auto 工具 → 正常执行
// 6. 执行前 abort → TOOL_ABORTED
// 7. 执行抛错 → TOOL_EXECUTION_FAILED
// 8. AGENT_TOOL_CALL / AGENT_TOOL_RESULT 事件推送

import { ErrorCode, IPC_CHANNELS } from '@code-agent/shared/main';
import type { WebContents } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Tool, ToolContext, ToolResult } from './tool';
import { ToolExecutor } from './tool-executor';
import type { IToolRegistry } from './tool-registry';

const mocks = vi.hoisted(() => ({
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  // otel withSpan：直接透传回调（不依赖真实 OTel）
  mockWithSpan: vi.fn(async (_name: string, _attrs: unknown, fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../../utils/logger', () => ({ logger: mocks.mockLogger }));
vi.mock('../../telemetry/otel', () => ({ withSpan: mocks.mockWithSpan }));

/** 创建 mock 工具 */
function createMockTool(
  permission: 'auto' | 'ask' = 'ask',
  execute: (input: unknown, ctx: ToolContext) => Promise<ToolResult> = async () => ({
    title: 'Mock 结果',
    output: 'ok',
  }),
): Tool {
  return {
    name: 'mock_tool',
    description: 'Mock 工具',
    inputSchema: undefined as unknown as Tool['inputSchema'],
    permission,
    execute,
  } as unknown as Tool;
}

/** 创建 mock 注册表 */
function createMockRegistry(tool: Tool | undefined): IToolRegistry {
  return {
    get: vi.fn(() => tool),
    register: vi.fn(),
    unregister: vi.fn(() => false),
    list: vi.fn(() => (tool === undefined ? [] : [tool])),
    toAISDKTools: vi.fn(),
  } as unknown as IToolRegistry;
}

/** 创建 mock WebContents（记录 send 调用） */
function createMockWebContents() {
  return {
    isDestroyed: vi.fn(() => false),
    send: vi.fn(),
  } as unknown as WebContents & { send: ReturnType<typeof vi.fn> };
}

/** 创建基础 ToolContext */
function createBaseCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    workingDir: '/tmp/project',
    sessionId: 'session-1',
    messageId: 'msg-1',
    callId: 'call-1',
    abortSignal: new AbortController().signal,
    webContents: createMockWebContents(),
    mode: 'build',
    ...overrides,
  };
}

describe('ToolExecutor', () => {
  let executor: ToolExecutor;
  let permissionService: {
    decide: ReturnType<typeof vi.fn>;
    requestApproval: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    permissionService = {
      decide: vi.fn((tool: Tool) => ({
        permission: tool.permission,
        description: tool.description,
      })),
      requestApproval: vi.fn(async () => true),
    };
  });

  function createExecutor(tool: Tool | undefined) {
    executor = new ToolExecutor(
      createMockRegistry(tool),
      permissionService as unknown as ConstructorParameters<typeof ToolExecutor>[1],
    );
  }

  describe('工具不存在', () => {
    it('返回 TOOL_NOT_FOUND 错误结果，并推送 TOOL_RESULT', async () => {
      createExecutor(undefined);
      const wc = createMockWebContents();
      const result = await executor.execute(
        'missing_tool',
        'call-1',
        {},
        createBaseCtx({ webContents: wc }),
        wc,
      );

      expect(result.error?.code).toBe(ErrorCode.TOOL_NOT_FOUND);
      expect(wc.send).toHaveBeenCalledWith(
        IPC_CHANNELS.AGENT_TOOL_RESULT,
        expect.objectContaining({ toolName: 'missing_tool' }),
      );
    });
  });

  describe('build 模式（默认）', () => {
    it('permission=auto：直接执行，不请求审批', async () => {
      const tool = createMockTool('auto');
      createExecutor(tool);
      const wc = createMockWebContents();

      const result = await executor.execute(
        'mock_tool',
        'call-1',
        {},
        createBaseCtx({ webContents: wc }),
        wc,
      );

      expect(permissionService.requestApproval).not.toHaveBeenCalled();
      expect(result.output).toBe('ok');
      expect(result.error).toBeUndefined();
    });

    it('permission=ask + 用户批准：执行成功', async () => {
      const tool = createMockTool('ask');
      createExecutor(tool);
      const wc = createMockWebContents();
      permissionService.requestApproval.mockResolvedValue(true);

      const result = await executor.execute(
        'mock_tool',
        'call-1',
        { path: '/a.ts' },
        createBaseCtx({ webContents: wc }),
        wc,
      );

      expect(permissionService.requestApproval).toHaveBeenCalledTimes(1);
      expect(result.output).toBe('ok');
    });

    it('permission=ask + 用户拒绝：返回 TOOL_PERMISSION_DENIED，不执行工具', async () => {
      const execute = vi.fn(async () => ({ title: 'x', output: 'x' }));
      createExecutor(createMockTool('ask', execute));
      const wc = createMockWebContents();
      permissionService.requestApproval.mockResolvedValue(false);

      const result = await executor.execute(
        'mock_tool',
        'call-1',
        {},
        createBaseCtx({ webContents: wc }),
        wc,
      );

      expect(result.error?.code).toBe(ErrorCode.TOOL_PERMISSION_DENIED);
      expect(execute).not.toHaveBeenCalled();
    });

    it('审批抛错（超时/中断）：返回对应错误结果', async () => {
      createExecutor(createMockTool('ask'));
      const wc = createMockWebContents();
      permissionService.requestApproval.mockRejectedValue(new Error('审批超时'));

      const result = await executor.execute(
        'mock_tool',
        'call-1',
        {},
        createBaseCtx({ webContents: wc }),
        wc,
      );

      expect(result.error?.code).toBe(ErrorCode.TOOL_PERMISSION_DENIED);
    });

    it('执行抛错：返回 TOOL_EXECUTION_FAILED', async () => {
      const failingTool = createMockTool('auto', async () => {
        throw new Error('boom');
      });
      createExecutor(failingTool);
      const wc = createMockWebContents();

      const result = await executor.execute(
        'mock_tool',
        'call-1',
        {},
        createBaseCtx({ webContents: wc }),
        wc,
      );

      expect(result.error?.code).toBe(ErrorCode.TOOL_EXECUTION_FAILED);
      expect(result.error?.message).toContain('boom');
    });
  });

  describe('plan 模式（只读约束）★', () => {
    it('ask 工具：直接拒绝，不请求审批（零副作用）', async () => {
      const execute = vi.fn(async () => ({ title: 'x', output: 'x' }));
      createExecutor(createMockTool('ask', execute));
      const wc = createMockWebContents();
      const ctx = createBaseCtx({ webContents: wc, mode: 'plan' });

      const result = await executor.execute('mock_tool', 'call-1', {}, ctx, wc);

      // 不请求审批
      expect(permissionService.requestApproval).not.toHaveBeenCalled();
      // 不执行工具
      expect(execute).not.toHaveBeenCalled();
      // 返回 TOOL_PERMISSION_DENIED
      expect(result.error?.code).toBe(ErrorCode.TOOL_PERMISSION_DENIED);
      expect(result.error?.message).toContain('plan 模式禁止写操作');
    });

    it('auto 工具：正常执行（只读探索仍可读文件/搜索）', async () => {
      createExecutor(createMockTool('auto'));
      const wc = createMockWebContents();
      const ctx = createBaseCtx({ webContents: wc, mode: 'plan' });

      const result = await executor.execute('mock_tool', 'call-1', {}, ctx, wc);

      expect(result.output).toBe('ok');
      expect(result.error).toBeUndefined();
      expect(permissionService.requestApproval).not.toHaveBeenCalled();
    });
  });

  describe('中断处理', () => {
    it('审批通过后、执行前检测到 abort：返回 TOOL_ABORTED', async () => {
      createExecutor(createMockTool('ask'));
      const wc = createMockWebContents();
      const controller = new AbortController();
      controller.abort();
      const ctx = createBaseCtx({ webContents: wc, abortSignal: controller.signal });

      const result = await executor.execute('mock_tool', 'call-1', {}, ctx, wc);

      expect(result.error?.code).toBe(ErrorCode.TOOL_ABORTED);
    });
  });

  describe('事件推送', () => {
    it('执行前推送 AGENT_TOOL_CALL，执行后推送 AGENT_TOOL_RESULT', async () => {
      createExecutor(createMockTool('auto'));
      const wc = createMockWebContents();

      await executor.execute(
        'mock_tool',
        'call-1',
        { path: '/a.ts' },
        createBaseCtx({ webContents: wc }),
        wc,
      );

      const sentChannels = wc.send.mock.calls.map(([ch]) => ch);
      expect(sentChannels).toContain(IPC_CHANNELS.AGENT_TOOL_CALL);
      expect(sentChannels).toContain(IPC_CHANNELS.AGENT_TOOL_RESULT);

      // TOOL_CALL payload 含权限级别
      const callPayload = wc.send.mock.calls.find(
        ([ch]) => ch === IPC_CHANNELS.AGENT_TOOL_CALL,
      )?.[1];
      expect(callPayload).toMatchObject({ toolCallId: 'call-1', permission: 'auto' });
    });

    it('webContents 已销毁：不推送事件（不抛错）', async () => {
      createExecutor(createMockTool('auto'));
      const destroyedWc = {
        isDestroyed: vi.fn(() => true),
        send: vi.fn(),
      } as unknown as WebContents & { send: ReturnType<typeof vi.fn> };

      const result = await executor.execute(
        'mock_tool',
        'call-1',
        {},
        createBaseCtx({ webContents: destroyedWc }),
        destroyedWc,
      );

      expect(destroyedWc.send).not.toHaveBeenCalled();
      expect(result.output).toBe('ok');
    });
  });
});
