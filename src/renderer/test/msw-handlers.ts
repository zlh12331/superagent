// src/renderer/test/msw-handlers.ts
// 统一 IPC mock 响应工厂
// ──────────────────────────────────────────────────────────────
// 职责：
// - 集中管理所有 window.api 方法的默认 mock 响应
// - 替代每个测试文件手写 vi.mock('@/hooks/...') 的样板代码
// - 提供 createMockApi() 工厂，按需覆盖特定方法
//
// 设计：
// - 项目 IPC 不走 HTTP（走 ipcMain.handle），MSW v2 无法直接拦截
// - 改为封装 mock 工厂模式：集中 IPC 响应数据 + 按 domain 分桶
// - 每个测试文件仍按需 vi.mock 具体方法，但响应数据从此处导入
//
// 与 MSW 的关系：
// - 当前阶段保留 IPC mock 工厂模式（务实）
// - 未来若引入 HTTP 后端（如远程模型代理），可启用 MSW 拦截 HTTP
// - MSW 已安装，预留扩展空间
// ──────────────────────────────────────────────────────────────

import type { IpcResponse } from '@code-agent/shared';
import { vi } from 'vitest';

/**
 * 构造成功响应（{ data: T }）
 *
 * 用于 mock window.api.*.method 的返回值
 */
export function ok<T>(data: T): IpcResponse<T> {
  return { data } as IpcResponse<T>;
}

/**
 * 构造错误响应（{ error: { code, message } }）
 */
export function err(code: string, message: string): IpcResponse<never> {
  return { error: { code, message } } as IpcResponse<never>;
}

/** Mock 方法类型：返回 Promise 的函数（避免引用 vi.fn Procedure 类型） */
type MockFn<T = unknown> = (input: unknown) => Promise<IpcResponse<T>>;

/** 事件订阅方法类型 */
type SubscribeFn = (callback: (payload: unknown) => void) => () => void;

/** window.api mock 形状（简化版，仅用于测试 mock 工厂） */
interface MockApi {
  readonly app: { getStatus: MockFn; openExternal: MockFn };
  readonly chat: {
    send: MockFn;
    stop: MockFn;
    subscribePart: SubscribeFn;
    subscribeEnd: SubscribeFn;
    subscribeError: SubscribeFn;
  };
  readonly agent: {
    run: MockFn;
    stop: MockFn;
    approvalResponse: MockFn;
    subscribeStreamPart: SubscribeFn;
    subscribeStreamEnd: SubscribeFn;
    subscribeStreamError: SubscribeFn;
    subscribeToolCall: SubscribeFn;
    subscribeToolResult: SubscribeFn;
    subscribeApprovalRequest: SubscribeFn;
  };
  readonly session: {
    list: MockFn;
    get: MockFn;
    delete: MockFn;
    rename: MockFn;
  };
  readonly file: {
    read: MockFn;
    write: MockFn;
    list: MockFn;
    watchStart: MockFn;
    watchStop: MockFn;
    subscribeWatchEvent: SubscribeFn;
  };
  readonly search: { grep: MockFn; glob: MockFn };
  readonly terminal: {
    create: MockFn;
    input: MockFn;
    resize: MockFn;
    kill: MockFn;
    subscribeOutputEvent: SubscribeFn;
    subscribeExitEvent: SubscribeFn;
  };
  readonly git: { status: MockFn; diff: MockFn };
  readonly codebase: {
    query: MockFn;
    explore: MockFn;
    node: MockFn;
    callers: MockFn;
    callees: MockFn;
    impact: MockFn;
  };
  readonly tool: { list: MockFn };
  readonly settings: {
    getApiKey: MockFn;
    setApiKey: MockFn;
    deleteApiKey: MockFn;
    getTelemetryLevel: MockFn;
    setTelemetryLevel: MockFn;
  };
  readonly system: { getStatus: MockFn };
  readonly logs: { read: MockFn };
  readonly devtools: { open: MockFn };
}

/**
 * System 域默认 mock 响应
 */
export const systemMocks = {
  getStatus: () =>
    ok({
      ready: true,
      version: '0.1.0-test',
      uptime: 12345,
      memory: { used: 100 * 1024 * 1024, total: 512 * 1024 * 1024 },
      cpu: { usage: 0.15 },
      platform: 'win32' as const,
      isPackaged: false,
    }),
};

/**
 * Session 域默认 mock 响应
 */
export const sessionMocks = {
  list: () =>
    ok({
      sessions: [
        {
          id: 'test-session-1',
          title: '测试会话',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      total: 1,
    }),
  get: () => ok({ session: { id: 'test-session-1', messages: [] } }),
  delete: () => ok({ ok: true }),
  rename: () => ok({ ok: true }),
};

/**
 * Git 域默认 mock 响应
 */
export const gitMocks = {
  status: () =>
    ok({
      branch: 'main',
      ahead: 0,
      behind: 0,
      files: [],
    }),
  diff: () => ok({ diff: '' }),
};

/**
 * Settings 域默认 mock 响应
 */
export const settingsMocks = {
  getApiKey: () => ok({ apiKey: null }),
  setApiKey: () => ok({ ok: true }),
  deleteApiKey: () => ok({ ok: true }),
  getTelemetryLevel: () => ok({ level: 'full' as const }),
  setTelemetryLevel: () => ok({ ok: true, level: 'full' as const }),
};

/**
 * Logs 域默认 mock 响应
 */
export const logsMocks = {
  read: () => ok({ lines: [] }),
};

/**
 * DevTools 域默认 mock 响应
 */
export const devtoolsMocks = {
  open: () => ok({ ok: true }),
};

/**
 * Terminal 域默认 mock 响应
 */
export const terminalMocks = {
  create: () => ok({ terminalId: 'test-terminal-1' }),
  input: () => ok({ ok: true }),
  resize: () => ok({ ok: true }),
  kill: () => ok({ ok: true }),
};

/**
 * 创建完整的 window.api mock 对象
 *
 * 替代 test/setup.ts 中的空骨架，提供每个方法的默认响应。
 * 测试文件可按需覆盖特定方法：
 * ```ts
 * const api = createMockApi();
 * api.session.list = vi.fn().mockResolvedValue(ok({ sessions: [], total: 0 }));
 * Object.defineProperty(window, 'api', { value: api });
 * ```
 *
 * 返回类型为 MockApi（强类型）：
 * - 避免 TS 推断引用 @vitest/spy 的 Procedure 类型（不可移植）
 * - 测试文件可点号访问各域方法
 */
export function createMockApi(): MockApi {
  return {
    app: {
      getStatus: vi.fn().mockResolvedValue(ok({ ready: true })),
      openExternal: vi.fn().mockResolvedValue(ok({ ok: true })),
    },
    chat: {
      send: vi.fn().mockResolvedValue(ok({ sessionId: 'test-chat-1' })),
      stop: vi.fn().mockResolvedValue(ok({ stopped: true })),
      subscribePart: () => () => {},
      subscribeEnd: () => () => {},
      subscribeError: () => () => {},
    },
    agent: {
      run: vi.fn().mockResolvedValue(ok({ sessionId: 'test-agent-1' })),
      stop: vi.fn().mockResolvedValue(ok({ stopped: true })),
      approvalResponse: vi.fn().mockResolvedValue(ok({ ok: true })),
      subscribeStreamPart: () => () => {},
      subscribeStreamEnd: () => () => {},
      subscribeStreamError: () => () => {},
      subscribeToolCall: () => () => {},
      subscribeToolResult: () => () => {},
      subscribeApprovalRequest: () => () => {},
    },
    session: {
      list: vi.fn().mockResolvedValue(sessionMocks.list()),
      get: vi.fn().mockResolvedValue(sessionMocks.get()),
      delete: vi.fn().mockResolvedValue(sessionMocks.delete()),
      rename: vi.fn().mockResolvedValue(sessionMocks.rename()),
    },
    file: {
      read: vi.fn().mockResolvedValue(ok({ content: '', size: 0 })),
      write: vi.fn().mockResolvedValue(ok({ ok: true })),
      list: vi.fn().mockResolvedValue(ok({ entries: [] })),
      watchStart: vi.fn().mockResolvedValue(ok({ watcherId: 'test-watcher' })),
      watchStop: vi.fn().mockResolvedValue(ok({ ok: true })),
      subscribeWatchEvent: () => () => {},
    },
    search: {
      grep: vi.fn().mockResolvedValue(ok({ matches: [] })),
      glob: vi.fn().mockResolvedValue(ok({ files: [] })),
    },
    terminal: {
      create: vi.fn().mockResolvedValue(terminalMocks.create()),
      input: vi.fn().mockResolvedValue(terminalMocks.input()),
      resize: vi.fn().mockResolvedValue(terminalMocks.resize()),
      kill: vi.fn().mockResolvedValue(terminalMocks.kill()),
      subscribeOutputEvent: () => () => {},
      subscribeExitEvent: () => () => {},
    },
    git: {
      status: vi.fn().mockResolvedValue(gitMocks.status()),
      diff: vi.fn().mockResolvedValue(gitMocks.diff()),
    },
    codebase: {
      query: vi.fn().mockResolvedValue(ok({ symbols: [] })),
      explore: vi.fn().mockResolvedValue(ok({ markdown: '' })),
      node: vi.fn().mockResolvedValue(ok({ node: null })),
      callers: vi.fn().mockResolvedValue(ok({ callers: [] })),
      callees: vi.fn().mockResolvedValue(ok({ callees: [] })),
      impact: vi.fn().mockResolvedValue(ok({ impacted: [] })),
    },
    tool: {
      list: vi.fn().mockResolvedValue(ok({ tools: [] })),
    },
    settings: {
      getApiKey: vi.fn().mockResolvedValue(settingsMocks.getApiKey()),
      setApiKey: vi.fn().mockResolvedValue(settingsMocks.setApiKey()),
      deleteApiKey: vi.fn().mockResolvedValue(settingsMocks.deleteApiKey()),
      getTelemetryLevel: vi.fn().mockResolvedValue(settingsMocks.getTelemetryLevel()),
      setTelemetryLevel: vi.fn().mockResolvedValue(settingsMocks.setTelemetryLevel()),
    },
    system: {
      getStatus: vi.fn().mockResolvedValue(systemMocks.getStatus()),
    },
    logs: {
      read: vi.fn().mockResolvedValue(logsMocks.read()),
    },
    devtools: {
      open: vi.fn().mockResolvedValue(devtoolsMocks.open()),
    },
  };
}
