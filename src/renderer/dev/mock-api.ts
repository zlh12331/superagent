// src/renderer/dev/mock-api.ts
// 前端独立开发模式：完整 window.api mock 层
// ──────────────────────────────────────────────────────────────
// 用途：pnpm dev:web（浏览器模式）下无 Electron preload 时注入本 mock，
//       让前端开发者不依赖主进程即可开发/调试全部界面与交互。
// 原则：
// - 仅当 import.meta.env.MODE === 'web' 时由 main.tsx 动态导入注入，
//   生产构建与 electron-vite dev（E2E 模式）绝不加载本文件。
// - 数据全部为内存假数据（标注 MOCK），重启即失。
// - 覆盖核心交互：会话 CRUD、聊天流式输出（按 AI SDK v7 UIMessageChunk
//   格式模拟推送）、模型清单、文件树、Git 状态、用量统计、终端回显等；
//   其余域返回空数据兜底。
// - 参数类型一律从 IpcApi 推导（Parameters<IpcApi['域']['方法']>[0]），
//   保证与 shared 契约同步。
// ──────────────────────────────────────────────────────────────

import { IPC_PROTOCOL_VERSION, type IpcApi, type SessionMeta } from '@code-agent/shared/renderer';

/** IPC 方法入参类型推导（mock 实现标注用） */
type Req<M> = M extends (input: infer P) => unknown ? P : never;

/** 成功响应 */
function ok<T>(data: T): { data: T } {
  return { data };
}

/** 错误响应 */
function fail(code: string, message: string): { error: { code: string; message: string } } {
  return { error: { code, message } };
}

// ── 内存假数据库 ──────────────────────────────────────────────

const now = Date.now();

const mockSessions: SessionMeta[] = [
  {
    id: 'mock-1',
    title: '重构 IPC 定义表',
    workingDir: 'f:\\TraeProjects\\1',
    createdAt: now - 3_600_000,
    updatedAt: now - 3 * 60_000,
    lastMessage: '把 meta 和 definitions 拆开后 handler 自动注册了',
    messageCount: 2,
    pinned: true,
    lastRunStatus: 'running',
  },
  {
    id: 'mock-2',
    title: '修复双折叠态主区崩溃',
    workingDir: 'f:\\TraeProjects\\1',
    createdAt: now - 86_400_000,
    updatedAt: now - 2 * 3_600_000,
    lastMessage: 'grid-column: 3 一行业务修复，CDP 实测 794px',
    messageCount: 0,
    pinned: false,
    lastRunStatus: 'idle',
  },
  {
    id: 'mock-3',
    title: '设计令牌 token 化',
    workingDir: 'f:\\TraeProjects\\2',
    createdAt: now - 2 * 86_400_000,
    updatedAt: now - 26 * 3_600_000,
    lastMessage: '对比度 1.23:1 → 15.86:1',
    messageCount: 0,
    pinned: false,
    lastRunStatus: 'interrupted',
  },
];

interface MockMessage {
  id: string;
  role: 'user' | 'assistant';
  // ModelMessage 形状（与主进程 SQLite 存储一致）：content 为字符串
  content: string;
}

const messagesBySession: Record<string, MockMessage[]> = {
  'mock-1': [
    {
      id: 'm1-1',
      role: 'user',
      content: '帮我把 IPC 定义表拆成 meta 和 definitions 两个文件',
    },
    {
      id: 'm1-2',
      role: 'assistant',
      content:
        '已完成拆分：`meta.ts` 保留纯字符串通道元数据（preload 沙箱安全），`definitions.ts` 合并 zod schema。新增 IPC 方法只需改两行 + handler 一个方法，其余全自动。',
    },
  ],
};

/** 当前会话流式回调（agent.run 后由模拟器推送） */
const streamCallbacks = new Set<(payload: { sessionId: string; part: unknown }) => void>();
const endCallbacks = new Set<
  (payload: { sessionId: string; reason: string; usage: unknown }) => void
>();
const errorCallbacks = new Set<
  (payload: { sessionId: string; code: string; message: string }) => void
>();
const terminalOutputCallbacks = new Set<(payload: { terminalId: string; data: string }) => void>();
const updateStatusCallbacks = new Set<(payload: unknown) => void>();

/** 模拟助手回答：按 AI SDK v7 UIMessageChunk 格式（带 id）分片推送 → end（含 usage） */
function simulateAgentStream(sessionId: string, userText: string): void {
  messagesBySession[sessionId] ??= [];
  messagesBySession[sessionId].push({
    id: `u-${Date.now()}`,
    role: 'user',
    content: userText,
  });

  const answer = [
    '这是模拟回复（MOCK 数据，非真实 LLM）。',
    '',
    '前端独立开发模式下，`agent:run` 由 mock 层模拟：',
    '- 输入框发送后会收到分片推送（text-start + text-delta）',
    '- 回合结束推送 `agent:stream:end`（含 usage，状态条 token 会累加）',
    '- 点停止按钮会触发 `agent:stop` 并结束流',
    '',
    '代码块示例（验证语言标签头栏 + 悬浮复制）：',
    '```ts',
    'export function hello(): string {',
    '  return "world";',
    '}',
    '```',
    '',
    '真实 Electron 环境（`pnpm dev`）下此链路走主进程 AgentService + 真实 LLM。',
  ];
  const total = answer.join('\n');
  const messageId = `mock-msg-${Date.now()}`;
  // AI SDK v7：UIMessageChunk 每个 chunk 必须带 id（text-start 先行）
  for (const cb of streamCallbacks) {
    cb({ sessionId, part: { type: 'text-start', id: messageId } });
  }
  let index = 0;
  const interval = setInterval(() => {
    if (index >= total.length) {
      clearInterval(interval);
      // 助手回复落库（对齐主进程行为：真实环境流式推送过程中持久化消息；
      // 不落库则切走再切回会话时助手回复消失）
      messagesBySession[sessionId]?.push({
        id: messageId,
        role: 'assistant',
        content: total,
      });
      const usage = { inputTokens: 120, outputTokens: 320, totalTokens: 440 };
      for (const cb of endCallbacks) {
        cb({ sessionId, reason: 'completed', usage });
      }
      return;
    }
    const chunk = total.slice(index, index + 8);
    index += 8;
    for (const cb of streamCallbacks) {
      cb({ sessionId, part: { type: 'text-delta', id: messageId, delta: chunk } });
    }
  }, 40);
}

// ── 各域 mock 实现（参数类型从 IpcApi 推导）──────────────────

function createMockApi(): IpcApi {
  return {
    app: {
      getStatus: async () =>
        ok({ protocolVersion: IPC_PROTOCOL_VERSION, status: 'ready' } as never),
      getInfo: async () =>
        ok({
          version: '0.1.0-mock',
          electron: 'mock',
          node: 'mock',
          chromium: 'mock',
          platform: 'web',
          arch: 'x64',
          userDataPath: '（浏览器模式）',
        } as never),
      openExternal: async () => ok({ ok: true }),
      openDataDir: async () => ok({ ok: true }),
    },

    session: {
      list: async ({ limit }: Req<IpcApi['session']['list']>) =>
        ok({ sessions: mockSessions.slice(0, limit), total: mockSessions.length }),
      get: async ({ id }: Req<IpcApi['session']['get']>) => {
        const session = mockSessions.find((s) => s.id === id);
        if (session === undefined) {
          return fail('SESSION_NOT_FOUND', 'mock 会话不存在');
        }
        return ok({ session, messages: messagesBySession[id] ?? [] } as never);
      },
      create: async ({ workingDir }: Req<IpcApi['session']['create']>) => {
        const id = `mock-${Date.now()}`;
        mockSessions.unshift({
          id,
          title: '新会话',
          workingDir,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          lastMessage: undefined,
          messageCount: 0,
          pinned: false,
          lastRunStatus: 'idle',
        });
        return ok({ sessionId: id });
      },
      delete: async ({ id }: Req<IpcApi['session']['delete']>) => {
        const idx = mockSessions.findIndex((s) => s.id === id);
        if (idx >= 0) {
          mockSessions.splice(idx, 1);
        }
        return ok({ ok: true });
      },
      rename: async ({ id, title }: Req<IpcApi['session']['rename']>) => {
        const s = mockSessions.find((x) => x.id === id);
        if (s !== undefined) {
          s.title = title;
        }
        return ok({ ok: true });
      },
      pin: async ({ id, pinned }: Req<IpcApi['session']['pin']>) => {
        const s = mockSessions.find((x) => x.id === id);
        if (s !== undefined) {
          s.pinned = pinned;
        }
        return ok({ ok: true });
      },
      listRecentDirs: async () =>
        ok({
          dirs: [
            { workingDir: 'f:\\TraeProjects\\1', lastUsed: now },
            { workingDir: 'f:\\TraeProjects\\2', lastUsed: now - 86_400_000 },
          ],
        }),
      exportAll: async () => ok({ saved: false }),
      getUsageSummary: async () =>
        ok({
          total: { calls: 12, inputTokens: 12_000, outputTokens: 28_000, totalTokens: 40_000 },
          byModel: [
            {
              modelId: 'deepseek-v4-flash',
              calls: 8,
              inputTokens: 8_000,
              outputTokens: 20_000,
              totalTokens: 28_000,
              reasoningTokens: 3_000,
            },
            {
              modelId: 'gpt-5-codex',
              calls: 4,
              inputTokens: 4_000,
              outputTokens: 8_000,
              totalTokens: 12_000,
              reasoningTokens: 1_000,
            },
          ],
          byDay: Array.from({ length: 90 }, (_, i) => ({
            date: new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10),
            calls: i % 3 === 0 ? 1 : 0,
            totalTokens: i % 3 === 0 ? 400 + i * 13 : 0,
          })),
        } as never),
      getTurns: async () => ok({ turns: [] }),
      getRecentTurns: async () =>
        ok({
          turns: [
            {
              id: 't1',
              sessionId: 'mock-1',
              seq: 3,
              modelId: 'deepseek-v4-flash',
              status: 'completed',
              inputTokens: 120,
              outputTokens: 320,
              totalTokens: 440,
              durationMs: 8_400,
              startedAt: now - 3_600_000,
            },
          ],
        } as never),
      getTurnMessages: async () => ok({ messages: [] }),
    },

    models: {
      list: async () =>
        ok({
          models: [
            {
              id: 'deepseek-v4-flash',
              label: 'DeepSeek V4 Flash',
              providerKind: 'deepseek',
              isRuntime: false,
            },
            { id: 'gpt-5-codex', label: 'GPT-5 Codex', providerKind: 'openai', isRuntime: false },
            { id: 'qwen3-coder', label: 'Qwen3 Coder', providerKind: 'qwen', isRuntime: false },
          ],
        } as never),
    },

    file: {
      list: async ({ path }: Req<IpcApi['file']['list']>) => {
        const entries = [
          {
            path: `${path}\\src`,
            name: 'src',
            type: 'directory' as const,
            size: 0,
            modifiedAt: now,
          },
          {
            path: `${path}\\package.json`,
            name: 'package.json',
            type: 'file' as const,
            size: 1_024,
            modifiedAt: now,
          },
          {
            path: `${path}\\README.md`,
            name: 'README.md',
            type: 'file' as const,
            size: 512,
            modifiedAt: now,
          },
        ];
        return ok({ entries });
      },
      read: async ({ path }: Req<IpcApi['file']['read']>) => {
        const content = path.endsWith('.json')
          ? '{\n  "name": "mock"\n}\n'
          : '// MOCK 文件内容（前端独立开发模式）\nexport const hello = "world";\n';
        return ok({ content, totalLines: content.split('\n').length, encoding: 'utf-8' });
      },
      write: async ({ content }: Req<IpcApi['file']['write']>) =>
        ok({ bytesWritten: content.length }),
      create: async ({ path }: Req<IpcApi['file']['create']>) => ok({ path }),
      createDir: async ({ path }: Req<IpcApi['file']['createDir']>) => ok({ path }),
      delete: async () => ok({ ok: true }),
      rename: async () => ok({ ok: true }),
      watchStart: async () => ok({ watcherId: 'mock-watcher' }),
      watchStop: async () => ok({ ok: true }),
      subscribeWatchEvent: () => () => {},
    },

    git: {
      status: async () =>
        ok({
          branch: 'main',
          ahead: 2,
          behind: 0,
          files: [
            { path: 'src/renderer/dev/mock-api.ts', status: 'untracked' },
            { path: 'docs/design/09-ux-interaction-spec.md', status: 'modified' },
          ],
        } as never),
      diff: async () =>
        ok({
          diff: '--- a/docs/design/09-ux-interaction-spec.md\n+++ b/docs/design/09-ux-interaction-spec.md\n@@ -1 +1 @@\n-旧内容\n+新内容\n',
          additions: 1,
          deletions: 1,
        }),
      add: async () => ok({ ok: true }),
      commit: async () => ok({ ok: true }),
      push: async () => ok({ ok: true }),
    },

    terminal: {
      create: async ({ cwd }: Req<IpcApi['terminal']['create']>) => {
        const terminalId = `mock-term-${Date.now()}`;
        setTimeout(() => {
          for (const cb of terminalOutputCallbacks) {
            cb({ terminalId, data: `MOCK PTY：cwd=${cwd}\r\nPS> ` });
          }
        }, 100);
        return ok({ terminalId });
      },
      input: async ({ terminalId, data }: Req<IpcApi['terminal']['input']>) => {
        // 回显输入（模拟 shell）
        for (const cb of terminalOutputCallbacks) {
          cb({ terminalId, data: `\r\n${data}\r\nPS> ` });
        }
        return ok({ ok: true });
      },
      resize: async () => ok({ ok: true }),
      kill: async () => ok({ ok: true }),
      subscribeCreatedEvent: () => () => {},
      subscribeOutputEvent: (cb: Parameters<IpcApi['terminal']['subscribeOutputEvent']>[0]) => {
        terminalOutputCallbacks.add(cb as (payload: { terminalId: string; data: string }) => void);
        return () => terminalOutputCallbacks.delete(cb as never);
      },
      subscribeExitEvent: () => () => {},
    },

    agent: {
      run: async ({ sessionId, messages }: Req<IpcApi['agent']['run']>) => {
        // convertToModelMessages 后 content 可能是字符串或数组（多 part），兼容两种
        const lastUserText = [...messages].reverse().find((m) => m.role === 'user');
        const rawContent = lastUserText?.content;
        // TS7 对复杂三目+闭包捕获的收窄不稳定：显式标注 text 类型
        const text: string =
          typeof rawContent === 'string'
            ? rawContent
            : Array.isArray(rawContent)
              ? rawContent
                  .map((p) => {
                    if (typeof p === 'string') {
                      return p;
                    }
                    if (typeof p === 'object' && p !== null && 'text' in p) {
                      const t = (p as { text?: unknown }).text;
                      return typeof t === 'string' ? t : '';
                    }
                    return '';
                  })
                  .join('')
              : '（模拟消息）';
        // AgentRunReq.sessionId 为可选类型，运行期 transport 总是传入（chatId）
        setTimeout(() => simulateAgentStream(sessionId ?? 'mock-1', text), 300);
        return ok({ sessionId });
      },
      stop: async () => ok({ stopped: true }),
      approvalResponse: async () => ok({ ok: true }),
      respondAsk: async () => ok({ ok: true }),
      subscribeStreamPart: (cb: Parameters<IpcApi['agent']['subscribeStreamPart']>[0]) => {
        streamCallbacks.add(cb as never);
        return () => streamCallbacks.delete(cb as never);
      },
      subscribeStreamEnd: (cb: Parameters<IpcApi['agent']['subscribeStreamEnd']>[0]) => {
        endCallbacks.add(cb as never);
        return () => endCallbacks.delete(cb as never);
      },
      subscribeStreamError: (cb: Parameters<IpcApi['agent']['subscribeStreamError']>[0]) => {
        errorCallbacks.add(cb as never);
        return () => errorCallbacks.delete(cb as never);
      },
      subscribeToolCall: () => () => {},
      subscribeToolResult: () => () => {},
      subscribeApprovalRequest: () => () => {},
      subscribeAsk: () => () => {},
      subscribeTurnEvent: () => () => {},
    },

    chat: {
      send: async () => ok({ sessionId: 'mock-chat' }),
      stop: async () => ok({ ok: true }),
      subscribePart: () => () => {},
      subscribeEnd: () => () => {},
      subscribeError: () => () => {},
    },

    settings: {
      getApiKey: async () => ok({ apiKey: null }),
      setApiKey: async () => ok({ ok: true }),
      deleteApiKey: async () => ok({ ok: true }),
      getTelemetryLevel: async () => ok({ level: 'off' }),
      setTelemetryLevel: async () => ok({ ok: true }),
      getApprovalMode: async () => ok({ mode: 'ask' }),
      setApprovalMode: async () => ok({ ok: true }),
      addRuntimeModel: async () => ok({ ok: true }),
      removeRuntimeModel: async () => ok({ ok: true }),
      listRuntimeModels: async () => ok({ models: [] }),
    },

    whitelist: {
      list: async () => ok({ rules: [] }),
      add: async () => ok({ ok: true }),
      remove: async () => ok({ ok: true }),
    },

    mcp: {
      list: async () => ok({ servers: [] }),
      start: async () => ok({ ok: true }),
      stop: async () => ok({ ok: true }),
    },
    skill: {
      list: async () => ok({ skills: [] }),
      listLearned: async () => ok({ skills: [] }),
      learn: async () => ok({ ok: true }),
      removeLearned: async () => ok({ ok: true }),
    },
    memory: {
      list: async () => ok({ memories: [] }),
      clear: async () => ok({ ok: true }),
    },
    goal: {
      list: async () => ok({ goals: [] }),
      create: async () => ok({ ok: true }),
      clear: async () => ok({ ok: true }),
    },
    task: {
      list: async () => ok({ tasks: [] }),
    },

    system: {
      getStatus: async () =>
        ok({
          memory: {
            rss: 320_000_000,
            heapUsed: 120_000_000,
            heapTotal: 180_000_000,
            external: 40_000_000,
          },
          cpu: { user: 1_200, system: 300 },
          uptime: 3_600,
          pid: 0,
          appVersion: '0.1.0-mock',
          platform: 'web',
          arch: 'x64',
          isPackaged: false,
          timestamp: Date.now(),
        } as never),
    },

    logs: {
      read: async () =>
        ok({
          filePath: '（浏览器模式无日志文件）',
          total: 3,
          truncated: false,
          lines: ['[info] mock 日志行 1', '[warn] mock 日志行 2', '[error] mock 日志行 3'],
        }),
    },

    devtools: {
      open: async () => ok({ ok: true, mode: 'detach' }),
    },

    dialog: {
      pickDirectory: async () => ok({ canceled: true }),
      pickFiles: async () => ok({ canceled: true, paths: [] }),
    },

    update: {
      check: async () => fail('UPDATE_NOT_AVAILABLE', '浏览器模式无更新服务（预期）'),
      install: async () => ok({ ok: true }),
      subscribeStatus: (cb: Parameters<IpcApi['update']['subscribeStatus']>[0]) => {
        updateStatusCallbacks.add(cb as never);
        return () => updateStatusCallbacks.delete(cb as never);
      },
    },

    im: {
      list: async () => ok({ channels: [] }),
      start: async () => ok({ ok: true }),
      stop: async () => ok({ ok: true }),
    },
    tool: {
      list: async () => ok({ tools: [] }),
    },
    search: {
      grep: async () => ok({ matches: [] }),
      glob: async ({ pattern }: Req<IpcApi['search']['glob']>) => {
        // 模拟文件匹配（@ 文件补全用）：按查询子串过滤假文件清单
        const query = pattern
          .replace(/^\*\*\/\*/, '')
          .replace(/\*$/, '')
          .toLowerCase();
        const files = [
          'src/renderer/App.tsx',
          'src/renderer/main.tsx',
          'src/renderer/index.css',
          'src/renderer/router.tsx',
          'src/renderer/components/chat/ChatInput.tsx',
          'src/renderer/components/chat/ChatPanel.tsx',
          'src/renderer/components/layout/AppShell.tsx',
          'package.json',
          'README.md',
          'electron.vite.config.ts',
        ].filter((f) => f.toLowerCase().includes(query));
        return ok({ files, truncated: false });
      },
    },
    codebase: {
      query: async () => ok({ results: [] }),
      explore: async () => ok({ nodes: [] }),
      node: async () => ok({ node: null }),
      callers: async () => ok({ callers: [] }),
      callees: async () => ok({ callees: [] }),
      impact: async () => ok({ impact: [] }),
    },
    audio: {
      start: async () => ok({ ok: true }),
      append: async () => ok({ ok: true }),
      stop: async () => ok({ ok: true }),
    },
  } as unknown as IpcApi;
}

/** 注入 mock window.api（仅前端独立开发模式调用） */
export function installMockApi(): void {
  const api = createMockApi();
  Object.defineProperty(window, 'api', {
    value: api,
    writable: true,
    configurable: true,
  });
}
