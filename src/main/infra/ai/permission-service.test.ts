// src/main/infra/ai/permission-service.test.ts
// PermissionService 单测：权限决策 + 审批流（安全关键模块）
//
// 测试要点：
// 1. decide：默认返回 tool.permission；记忆命中（approved→auto / denied→ask）；过期记忆惰性清理
// 2. requestApproval：推送 AGENT_APPROVAL_REQUEST；abortSignal 中断立即 reject；超时 reject；webContents 销毁 reject
// 3. handleApprovalResponse：resolve 对应 Promise；rememberDecision 缓存决策
// 4. dispose：reject 所有 pending，清理记忆
// 5. stableStringify：键顺序不影响记忆 key

import { ErrorCode, IPC_CHANNELS } from '@code-agent/shared/main';
import type { WebContents } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { generateApprovalId, PermissionService } from './tools/permission-service';
import type { Tool } from './tools/tool';

const mocks = vi.hoisted(() => ({
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../utils/logger', () => ({ logger: mocks.mockLogger }));

// 白名单持久化：测试环境隔离（内存假实现，避免依赖 electron app.getPath）
const whitelistMocks = vi.hoisted(() => ({
  entries: [] as Array<{ toolName: string; pattern: string }>,
  readWhitelistSync: vi.fn((): Array<{ toolName: string; pattern: string }> => []),
  writeWhitelist: vi.fn(async () => {}),
}));

vi.mock('../storage/whitelist-pref', () => ({
  readWhitelistSync: whitelistMocks.readWhitelistSync,
  writeWhitelist: whitelistMocks.writeWhitelist,
}));

/** 创建 mock 工具 */
function createMockTool(
  permission: 'auto' | 'ask' = 'ask',
  category: 'read' | 'edit' | 'exec' = 'edit',
): Tool {
  return {
    name: 'mock_tool',
    description: 'Mock 工具',
    inputSchema: undefined as unknown as Tool['inputSchema'],
    permission,
    category,
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
    whitelistMocks.entries = [];
    whitelistMocks.readWhitelistSync.mockReturnValue([]);
    service = new PermissionService();
  });

  describe('approval lifecycle', () => {
    it('订阅后：审批请求推送 → onRequested（带 sessionId/approvalId/toolName）', async () => {
      const wc = createMockWebContents();
      const onRequested = vi.fn();
      const onResolved = vi.fn();
      const unsubscribe = service.onApprovalLifecycle({ onRequested, onResolved });

      const tool = createMockTool('ask');
      const requestPromise = service.requestApproval(
        createApprovalPayload({
          sessionId: 'session-1',
          approvalId: 'ap-1',
          toolName: 'mock_tool',
        }),
        tool,
        { path: '/tmp/a.ts' },
        wc,
      );
      expect(onRequested).toHaveBeenCalledWith({
        sessionId: 'session-1',
        approvalId: 'ap-1',
        toolName: 'mock_tool',
      });

      // 决议 → onResolved
      service.handleApprovalResponse('ap-1', true, false);
      await expect(requestPromise).resolves.toBe(true);
      expect(onResolved).toHaveBeenCalledWith({ sessionId: 'session-1', approvalId: 'ap-1' });
      unsubscribe();
    });

    it('注销后不再通知', async () => {
      const wc = createMockWebContents();
      const onRequested = vi.fn();
      const unsubscribe = service.onApprovalLifecycle({ onRequested, onResolved: vi.fn() });
      unsubscribe();

      const tool = createMockTool('ask');
      const requestPromise = service.requestApproval(
        createApprovalPayload({ approvalId: 'ap-2' }),
        tool,
        { path: '/tmp/a.ts' },
        wc,
      );
      expect(onRequested).not.toHaveBeenCalled();
      service.handleApprovalResponse('ap-2', false, false);
      await expect(requestPromise).resolves.toBe(false);
    });
  });

  describe('whitelist', () => {
    it('listWhitelist：返回当前条目（初始为空）', () => {
      expect(service.listWhitelist()).toEqual([]);
    });

    it('addWhitelistEntry：添加并持久化（幂等）', async () => {
      await service.addWhitelistEntry({ toolName: 'run_command', pattern: 'npm test' });
      await service.addWhitelistEntry({ toolName: 'run_command', pattern: 'npm test' });
      expect(service.listWhitelist()).toEqual([{ toolName: 'run_command', pattern: 'npm test' }]);
      expect(whitelistMocks.writeWhitelist).toHaveBeenCalledOnce();
    });

    it('removeWhitelistEntry：移除并持久化（幂等）', async () => {
      await service.addWhitelistEntry({ toolName: 'run_command', pattern: 'npm test' });
      await service.removeWhitelistEntry({ toolName: 'run_command', pattern: 'npm test' });
      await service.removeWhitelistEntry({ toolName: 'run_command', pattern: 'npm test' });
      expect(service.listWhitelist()).toEqual([]);
      expect(whitelistMocks.writeWhitelist).toHaveBeenCalledTimes(2);
    });
  });

  describe('decide', () => {
    it('默认：返回 tool.permission（auto 工具直接执行）', async () => {
      const tool = createMockTool('auto');
      const decision = await service.decide(tool, { path: '/tmp/a.ts' });
      expect(decision).toEqual({ permission: 'auto', description: 'Mock 工具' });
    });

    it('默认：返回 tool.permission（ask 工具需审批）', async () => {
      const tool = createMockTool('ask');
      const decision = await service.decide(tool, { path: '/tmp/a.ts' });
      expect(decision.permission).toBe('ask');
    });

    it('用户白名单（空 pattern）：该工具全部自动放行', async () => {
      const tool = createMockTool('ask');
      whitelistMocks.readWhitelistSync.mockReturnValue([{ toolName: 'mock_tool', pattern: '' }]);
      service = new PermissionService();
      const decision = await service.decide(tool, { path: '/tmp/a.ts' });
      expect(decision.permission).toBe('auto');
    });

    it('用户白名单（命令模式）：命令包含 pattern 时自动放行', async () => {
      const tool = createMockTool('ask', 'exec');
      whitelistMocks.readWhitelistSync.mockReturnValue([
        { toolName: 'mock_tool', pattern: 'npm test' },
      ]);
      service = new PermissionService();
      const decision = await service.decide(tool, { command: 'npm test -- --watch' });
      expect(decision.permission).toBe('auto');
    });

    it('用户白名单（命令模式）：不匹配时仍按审批模式决策', async () => {
      const tool = createMockTool('ask', 'exec');
      whitelistMocks.readWhitelistSync.mockReturnValue([
        { toolName: 'mock_tool', pattern: 'npm test' },
      ]);
      service = new PermissionService();
      const decision = await service.decide(tool, { command: 'rm -rf dist' });
      expect(decision.permission).toBe('ask');
    });

    it('P0：白名单命中但命令为复合结构 → 不短路，Layer-0 拦截后继破坏段', async () => {
      whitelistMocks.readWhitelistSync.mockReturnValue([
        { toolName: 'mock_tool', pattern: 'git status' },
      ]);
      service = new PermissionService();
      service.setApprovalMode('auto');
      const decision = await service.decide(createMockTool('ask', 'exec'), {
        command: 'git status && git reset --hard HEAD~1',
      });
      expect(decision.permission).toBe('ask');
      expect(decision.description).toContain('破坏性');
    });

    it('P2 路径边界：auto 模式只读命令引用边界外绝对路径 → ask（IM 外泄向量封堵）', async () => {
      service = new PermissionService();
      service.setApprovalMode('auto');
      const decision = await service.decide(
        createMockTool('ask', 'exec'),
        { command: 'cat ~/.ssh/id_rsa' },
        undefined,
        { pathBoundary: 'F:\\TraeProjects\\1' },
      );
      expect(decision.permission).toBe('ask');
    });

    it('P2 路径边界：边界内相对路径保持 auto；盘符越界同样降级', async () => {
      service = new PermissionService();
      service.setApprovalMode('auto');
      const inside = await service.decide(
        createMockTool('ask', 'exec'),
        { command: 'cat docs/README.md' },
        undefined,
        { pathBoundary: 'F:\\TraeProjects\\1' },
      );
      expect(inside.permission).toBe('auto');

      const outside = await service.decide(
        createMockTool('ask', 'exec'),
        { command: 'type C:\\Windows\\win.ini' },
        undefined,
        { pathBoundary: 'F:\\TraeProjects\\1' },
      );
      expect(outside.permission).toBe('ask');
    });

    it('P2 路径边界：未传边界时行为不变（向后兼容）', async () => {
      service = new PermissionService();
      service.setApprovalMode('auto');
      const decision = await service.decide(createMockTool('ask', 'exec'), {
        command: 'cat ~/.ssh/id_rsa',
      });
      expect(decision.permission).toBe('auto');
    });
    it('P0：白名单命中的复合命令即使第二段看似只读也不自动放行', async () => {
      whitelistMocks.readWhitelistSync.mockReturnValue([
        { toolName: 'mock_tool', pattern: 'git status' },
      ]);
      service = new PermissionService();
      service.setApprovalMode('auto');
      const decision = await service.decide(createMockTool('ask', 'exec'), {
        command: 'git status && cat package.json',
      });
      // 复合命令跳过 SAFE_READ_ONLY 快速路径，无分类器时保守 ask
      expect(decision.permission).toBe('ask');
    });

    it('P0：token 边界——前缀伪装与无词边界均不命中白名单', async () => {
      whitelistMocks.readWhitelistSync.mockReturnValue([
        { toolName: 'mock_tool', pattern: 'git status' },
      ]);
      service = new PermissionService();
      const disguised = await service.decide(createMockTool('ask', 'exec'), {
        command: 'git status-helper --do-things',
      });
      expect(disguised.permission).toBe('ask');
      const exact = await service.decide(createMockTool('ask', 'exec'), {
        command: 'git status',
      });
      expect(exact.permission).toBe('auto');
    });

    it('P0：auto 模式下安全命令串联后继段落不受只读快速路径保护', async () => {
      service.setApprovalMode('auto');
      const decision = await service.decide(createMockTool('ask', 'exec'), {
        command: 'git diff && git reset --hard',
      });
      expect(decision.permission).toBe('ask');
    });

    it('setApprovalMode(plan)：edit/exec 工具 deny，read 工具 auto（只读探索零副作用）', async () => {
      service.setApprovalMode('plan');
      expect((await service.decide(createMockTool('ask', 'edit'), {})).permission).toBe('deny');
      expect((await service.decide(createMockTool('ask', 'exec'), {})).permission).toBe('deny');
      expect((await service.decide(createMockTool('auto', 'read'), {})).permission).toBe('auto');
    });

    it('setApprovalMode(auto)：edit 自动放行（工作区编辑快速路径），exec 仍审批（危险命令）', async () => {
      service.setApprovalMode('auto');
      expect((await service.decide(createMockTool('ask', 'edit'), {})).permission).toBe('auto');
      expect((await service.decide(createMockTool('ask', 'exec'), {})).permission).toBe('ask');
    });

    it('setApprovalMode(yolo)：全部自动放行（无审批）', async () => {
      service.setApprovalMode('yolo');
      expect((await service.decide(createMockTool('ask', 'edit'), {})).permission).toBe('auto');
      expect((await service.decide(createMockTool('ask', 'exec'), {})).permission).toBe('auto');
    });

    it('getApprovalMode：返回当前模式（默认 ask）', async () => {
      expect(service.getApprovalMode()).toBe('ask');
      service.setApprovalMode('auto');
      expect(service.getApprovalMode()).toBe('auto');
    });

    it('setApprovalMode(auto)：exec 命令分层（破坏性强制 ask / 只读自动 / 其余保守 ask）', async () => {
      service.setApprovalMode('auto');
      // 破坏性命令：强制 ask + 危险标注
      const dangerous = await service.decide(createMockTool('ask', 'exec'), {
        command: 'git reset --hard HEAD',
      });
      expect(dangerous.permission).toBe('ask');
      expect(dangerous.description).toContain('破坏性');
      // 只读安全命令：自动放行
      expect(
        (await service.decide(createMockTool('ask', 'exec'), { command: 'git status' })).permission,
      ).toBe('auto');
      // 其他命令：保守 ask（无分类器时）
      expect(
        (await service.decide(createMockTool('ask', 'exec'), { command: 'pnpm install' }))
          .permission,
      ).toBe('ask');
    });

    it('setApprovalMode(auto)：userPrompt 意图豁免破坏性拦截（意图优先，无意图时标注危险）', async () => {
      service.setApprovalMode('auto');
      // 用户显式说 discard → 破坏性拦截豁免（命令非只读 → 保守 ask）
      expect(
        (
          await service.decide(
            createMockTool('ask', 'exec'),
            { command: 'git reset --hard HEAD' },
            '请 discard 所有更改',
          )
        ).permission,
      ).toBe('ask');
      // 无意图：危险标注出现在描述中
      const withoutIntent = await service.decide(createMockTool('ask', 'exec'), {
        command: 'git reset --hard HEAD',
      });
      expect(withoutIntent.description).toContain('破坏性');
    });

    it('拒绝跟踪：连续拒绝 3 次后 auto 模式降级手动确认', async () => {
      service.setApprovalMode('auto');
      service.recordUserDenial();
      service.recordUserDenial();
      service.recordUserDenial();
      const decision = await service.decide(createMockTool('ask', 'exec'), {
        command: 'git status',
      });
      expect(decision.permission).toBe('ask');
      expect(decision.description).toContain('拒绝频繁');
    });

    it('拒绝跟踪：用户放行重置连续计数', async () => {
      service.setApprovalMode('auto');
      service.recordUserDenial();
      service.recordUserDenial();
      service.recordUserAllowance();
      expect(
        (await service.decide(createMockTool('ask', 'exec'), { command: 'git status' })).permission,
      ).toBe('auto');
    });

    it('拒绝跟踪：切换审批模式重置计数', async () => {
      service.setApprovalMode('auto');
      service.recordUserDenial();
      service.recordUserDenial();
      service.recordUserDenial();
      service.setApprovalMode('auto');
      expect(
        (await service.decide(createMockTool('ask', 'exec'), { command: 'git status' })).permission,
      ).toBe('auto');
    });

    it('记忆命中（approved）：返回 auto（不再询问）', async () => {
      const tool = createMockTool('ask');
      service.rememberDecision(tool, { path: '/tmp/a.ts' }, true);
      const decision = await service.decide(tool, { path: '/tmp/a.ts' });
      expect(decision.permission).toBe('auto');
    });

    it('记忆命中（denied）：返回 ask（重新询问，避免锁死）', async () => {
      const tool = createMockTool('ask');
      service.rememberDecision(tool, { path: '/tmp/a.ts' }, false);
      const decision = await service.decide(tool, { path: '/tmp/a.ts' });
      expect(decision.permission).toBe('ask');
    });

    it('输入不同（路径不同）：不命中记忆', async () => {
      const tool = createMockTool('ask');
      service.rememberDecision(tool, { path: '/tmp/a.ts' }, true);
      const decision = await service.decide(tool, { path: '/tmp/b.ts' });
      expect(decision.permission).toBe('ask');
    });

    it('对象键顺序不同：记忆 key 相同（stable stringify）', async () => {
      const tool = createMockTool('ask');
      service.rememberDecision(tool, { path: '/tmp/a.ts', mode: 'write' }, true);
      const decision = await service.decide(tool, { mode: 'write', path: '/tmp/a.ts' });
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

      const decision = await service.decide(tool, { path: '/tmp/a.ts' });
      expect(decision.permission).toBe('auto');
    });

    it('未知 approvalId：忽略（已超时或不存在）', async () => {
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

    it('清空记忆决策', async () => {
      const tool = createMockTool('ask');
      service.rememberDecision(tool, { path: '/tmp/a.ts' }, true);
      service.dispose();
      const decision = await service.decide(tool, { path: '/tmp/a.ts' });
      expect(decision.permission).toBe('ask');
    });
  });

  describe('generateApprovalId', () => {
    it('生成 UUID v4 格式 id', async () => {
      const id = generateApprovalId();
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    });
  });
});
