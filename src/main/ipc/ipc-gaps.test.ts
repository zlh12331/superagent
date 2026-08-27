// src/main/ipc/ipc-gaps.test.ts
// IPC 薄层 8 缺口补全：app/dialog handler 全路径、agent/chat thinking 省略、
// tool handler deny 过滤（electron 全局 mock + service DI fake）

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IAgentService } from '../infra/ai/agent/agent-service';
import type { IToolRegistry } from '../infra/ai/tools/tool-registry';
import type { IpcHandlerContext } from '../utils/wrap';
import { createAgentHandlers } from './agent.handler';
import { appHandlers } from './app.handler';
import { dialogHandlers } from './dialog.handler';
import { createToolHandlers } from './tool.handler';

const mocks = vi.hoisted(() => {
  const mockGetVersion = vi.fn(() => '1.0.0');
  const mockGetPath = vi.fn(() => 'C:\\user-data');
  const mockOpenExternal = vi.fn(async () => {});
  const mockOpenPath = vi.fn(async () => '');
  const mockShowOpenDialog = vi.fn();
  return {
    mockGetVersion,
    mockGetPath,
    mockOpenExternal,
    mockOpenPath,
    mockShowOpenDialog,
  };
});

vi.mock('electron', () => ({
  app: {
    getVersion: mocks.mockGetVersion,
    getPath: mocks.mockGetPath,
    isPackaged: true,
  },
  shell: {
    openExternal: mocks.mockOpenExternal,
    openPath: mocks.mockOpenPath,
  },
  dialog: {
    showOpenDialog: mocks.mockShowOpenDialog,
  },
}));

/** 构造 handler 上下文（sender 为最小 webContents 形状） */
function createCtx(): IpcHandlerContext {
  return { sender: {} as never, traceId: 'trace-gap' };
}

describe('IPC 薄层批次8 缺口补全', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('app handler', () => {
    it('getStatus：返回就绪标记与协议版本', async () => {
      const result = await appHandlers.getStatus({} as never, createCtx());
      expect(result.ready).toBe(true);
      expect(typeof result.protocolVersion).toBe('number');
    });

    it('getInfo：版本与环境信息（electron/node/chrome 兜底 unknown）', async () => {
      const result = await appHandlers.getInfo({} as never, createCtx());
      expect(result.version).toBe('1.0.0');
      expect(result.electron).toBe('unknown');
      expect(result.node).toBeDefined();
      expect(result.userDataPath).toBe('C:\\user-data');
    });

    it('openExternal：http 协议放行', async () => {
      const result = await appHandlers.openExternal({ url: 'http://example.com' }, {} as never);
      expect(result.ok).toBe(true);
      expect(mocks.mockOpenExternal).toHaveBeenCalledWith('http://example.com');
    });

    it('openExternal：https 协议放行', async () => {
      const result = await appHandlers.openExternal({ url: 'https://example.com' }, {} as never);
      expect(result.ok).toBe(true);
    });

    it('openExternal：非 http(s) 协议拒绝（file/javascript）', async () => {
      await expect(
        appHandlers.openExternal({ url: 'file:///etc/passwd' }, {} as never),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      await expect(
        appHandlers.openExternal({ url: 'javascript:alert(1)' }, {} as never),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      expect(mocks.mockOpenExternal).not.toHaveBeenCalled();
    });

    it('openDataDir：打开成功返回 ok=true', async () => {
      mocks.mockOpenPath.mockResolvedValueOnce('');
      const result = await appHandlers.openDataDir({} as never, createCtx());
      expect(result.ok).toBe(true);
    });

    it('openDataDir：打开失败（返回错误信息）ok=false', async () => {
      mocks.mockOpenPath.mockResolvedValueOnce('open failed');
      const result = await appHandlers.openDataDir({} as never, createCtx());
      expect(result.ok).toBe(false);
    });
  });

  describe('dialog handler', () => {
    it('pickDirectory：用户取消 → canceled=true', async () => {
      mocks.mockShowOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] });
      const result = await dialogHandlers.pickDirectory({} as never, createCtx());
      expect(result).toEqual({ canceled: true });
    });

    it('pickDirectory：取消但 filePaths 非空兜底 → canceled=true', async () => {
      mocks.mockShowOpenDialog.mockResolvedValueOnce({
        canceled: true,
        filePaths: ['C:\\x'],
      });
      const result = await dialogHandlers.pickDirectory({} as never, createCtx());
      expect(result).toEqual({ canceled: true });
    });

    it('pickDirectory：选中目录 → 返回第一个路径', async () => {
      mocks.mockShowOpenDialog.mockResolvedValueOnce({
        canceled: false,
        filePaths: ['C:\\proj'],
      });
      const result = await dialogHandlers.pickDirectory({} as never, createCtx());
      expect(result).toEqual({ canceled: false, path: 'C:\\proj' });
    });

    it('pickFiles：取消 → canceled=true；多选返回全部路径', async () => {
      mocks.mockShowOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] });
      const canceled = await dialogHandlers.pickFiles({ multiple: true }, {} as never);
      expect(canceled).toEqual({ canceled: true });

      mocks.mockShowOpenDialog.mockResolvedValueOnce({
        canceled: false,
        filePaths: ['C:\\a.ts', 'C:\\b.ts'],
      });
      const picked = await dialogHandlers.pickFiles({ multiple: true }, {} as never);
      expect(picked).toEqual({ canceled: false, paths: ['C:\\a.ts', 'C:\\b.ts'] });
    });
  });

  describe('agent handler', () => {
    it('thinking 省略：startAgent 不传 thinking（条件展开）', async () => {
      const agentService = {
        startAgent: vi.fn(async () => 'sess-1'),
      } as unknown as IAgentService;
      const handlers = createAgentHandlers({ agentService });

      const result = await handlers.run(
        {
          messages: [{ role: 'user', content: 'hi' }],
          sessionId: 'sess-1',
          workingDir: 'C:\\proj',
          systemPrompt: undefined,
          maxSteps: 10,
          mode: 'build',
          thinking: undefined,
          temperature: undefined,
        },
        createCtx(),
      );

      expect(result.sessionId).toBe('sess-1');
      const args = (agentService as unknown as { startAgent: ReturnType<typeof vi.fn> }).startAgent
        .mock.calls[0]?.[0] as Record<string, unknown> | undefined;
      expect(args?.['thinking']).toBeUndefined();
    });

    it('stop：转发 abort 结果', async () => {
      const agentService = {
        abort: vi.fn(() => true),
      } as unknown as IAgentService;
      const handlers = createAgentHandlers({ agentService });

      const result = await handlers.stop({ sessionId: 'sess-1' }, {} as never);

      expect(result.stopped).toBe(true);
      expect(
        (agentService as unknown as { abort: ReturnType<typeof vi.fn> }).abort,
      ).toHaveBeenCalledWith('sess-1');
    });

    it('thinking 传入：条件展开到 startAgent', async () => {
      const agentService = {
        startAgent: vi.fn(async () => 'sess-1'),
      } as unknown as IAgentService;
      const handlers = createAgentHandlers({ agentService });

      await handlers.run(
        {
          messages: [{ role: 'user', content: 'hi' }],
          sessionId: 'sess-1',
          workingDir: 'C:\\proj',
          systemPrompt: undefined,
          maxSteps: 10,
          mode: 'build',
          thinking: 'high',
          temperature: 0.5,
        },
        createCtx(),
      );

      const args = (agentService as unknown as { startAgent: ReturnType<typeof vi.fn> }).startAgent
        .mock.calls[0]?.[0] as Record<string, unknown> | undefined;
      expect(args?.['thinking']).toBe('high');
    });
  });

  describe('tool handler', () => {
    it("permission='deny'：list 传 undefined（deny 是决策结果非静态属性）", async () => {
      const toolRegistry = {
        list: vi.fn(() => []),
      } as unknown as IToolRegistry;
      const handlers = createToolHandlers({ toolRegistry });

      const result = await handlers.list({ permission: 'deny' }, {} as never);

      expect(result.tools).toEqual([]);
      const listMock = toolRegistry as unknown as { list: ReturnType<typeof vi.fn> };
      expect(listMock.list).toHaveBeenCalledWith(undefined);
    });
  });
});
