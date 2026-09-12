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

import {
  type AgentApprovalRequestPayload,
  type AgentStreamEndPayload,
  type AgentStreamPartPayload,
  type AskEventPayload,
  type GoalInfo,
  IPC_PROTOCOL_VERSION,
  type IpcApi,
  type RemoteStatusRes,
  type SessionMeta,
  type UpdateStatusPayload,
} from '@code-agent/shared/renderer';
import type { ModelMessage } from 'ai';

import { ipcOk } from '@/lib/ipc-factories';
import { mockGitStatus, mockModels, mockSystemStatus, mockUsageSummary } from './mock-data';

/** IPC 方法入参类型推导（mock 实现标注用） */
type Req<M> = M extends (input: infer P) => unknown ? P : never;

/** 运行时模型类型（从 listRuntimeModels 响应契约推导；避免依赖 renderer 单独导出） */
type MockRuntimeModel = Extract<
  Awaited<ReturnType<IpcApi['settings']['listRuntimeModels']>>,
  { data: unknown }
>['data'] extends { models: infer M }
  ? M extends readonly (infer E)[]
    ? E
    : never
  : never;

// ── 内存假数据库 ──────────────────────────────────────────────

const now = Date.now();

// 运行时模型（可变状态：list/update/remove 联动，Web 预览下开关/删除实时生效）
let mockRuntimeModels: MockRuntimeModel[] = [
  {
    modelId: 'my-coder',
    providerKind: 'deepseek',
    baseUrl: undefined,
    displayName: '我的编码器',
    isEnabled: true,
    createdAt: 1,
  },
  {
    modelId: 'local-gemma',
    providerKind: 'ollama',
    baseUrl: 'http://localhost:11434',
    displayName: undefined,
    isEnabled: false,
    createdAt: 2,
  },
];

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
    messageCount: 2,
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
    // 连续 assistant 消息（验证 isContinuation：第二条隐藏头像与角色标签，对齐参考项目）
    {
      id: 'm1-3',
      role: 'assistant',
      content:
        '补充：`derive.ts` 负责类型推导（IpcApi / RequestMap / EventMap / InferHandlers），`register.ts` 统一注册 handler——定义表驱动全链路自动生成是核心资产。',
    },
  ],
  // mock-2 预置消息（多会话切换 E2E 用：切换后聊天区显示本会话历史，不串 mock-1）
  'mock-2': [
    {
      id: 'm2-1',
      role: 'user',
      content: '修复双折叠态主区崩溃',
    },
    {
      id: 'm2-2',
      role: 'assistant',
      content:
        '问题定位：侧栏 + 右面板同时折叠的 `sb-collapsed`/`crp-collapsed` 组合态，grid 五列塌缩为 1 列时主区宽度计算越界。修复后 CDP 实测 794px 正常。',
    },
  ],
};

/** 当前会话流式回调（agent.run 后由模拟器推送；类型对齐 shared 契约 payload） */
const streamCallbacks = new Set<(payload: AgentStreamPartPayload) => void>();
const endCallbacks = new Set<(payload: AgentStreamEndPayload) => void>();
const errorCallbacks = new Set<
  (payload: { sessionId: string; code: string; message: string }) => void
>();
const terminalOutputCallbacks = new Set<(payload: { terminalId: string; data: string }) => void>();
const updateStatusCallbacks = new Set<(payload: UpdateStatusPayload) => void>();
/** 审批请求回调（agent:approval:request 模拟推送，验证内联审批卡） */
const approvalCallbacks = new Set<(payload: AgentApprovalRequestPayload) => void>();
/** Agent 提问回调（agent:event:ask 模拟推送，验证 AskDialog） */
const askCallbacks = new Set<(payload: AskEventPayload) => void>();

/** 模拟流定时器（sessionId → interval，agent.stop 据此真正中断模拟流） */
const streamIntervals = new Map<string, ReturnType<typeof setInterval>>();

/** mock 会话目标存储（浏览器模式持久化：goal:create → list 闭环，对齐主进程每会话一目标语义） */
const mockGoals: Array<{ sessionId: string; condition: string }> = [];

/** 远程控制模拟状态（可变：开启后返回假令牌/端点，Web 预览可联调配对面板） */
let mockRemoteRunning = false;

/** 远程控制状态快照（对齐真实 handler：停止时令牌与端点置空） */
function mockRemoteStatus(): RemoteStatusRes {
  return mockRemoteRunning
    ? {
        running: true,
        port: 4173,
        token: 'mock-remote-token-0123456789abcdef',
        instanceName: 'web-preview',
        addresses: ['http://192.168.1.10:4173'],
        activeCommands: 0,
        lastCommandAt: null,
      }
    : {
        running: false,
        port: null,
        token: null,
        instanceName: 'web-preview',
        addresses: [],
        activeCommands: 0,
        lastCommandAt: null,
      };
}

/** 模拟助手回答：按 AI SDK v7 UIMessageChunk 格式（带 id）分片推送 → end（含 usage） */
function simulateAgentStream(sessionId: string, userText: string): void {
  // 限流模拟（前端开发专用）：发送 "/limit" 触发 AI_RATE_LIMITED 错误流
  // → use-agent-bridge 触发 rate-limit-store → 顶部限流横幅（pill 形态）显示
  if (userText.trim() === '/limit') {
    for (const cb of errorCallbacks) {
      cb({ sessionId, code: 'AI_RATE_LIMITED', message: '请求过于频繁，请稍后重试' });
    }
    return;
  }
  // 全类型演示（前端开发专用）：发送 "/demo" 推送 step-start/reasoning/text/通用工具/edit_file/dynamic-tool/file 全部 part
  if (userText.trim() === '/demo') {
    simulateAllPartsDemo(sessionId);
    return;
  }
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
  // 模拟审批请求（对齐真实链路：命令工具执行前推送 approval:request，验证内联审批卡）
  const approvalId = `mock-approval-${Date.now()}`;
  for (const cb of approvalCallbacks) {
    cb({
      sessionId,
      approvalId,
      toolCallId: `mock-tool-${Date.now()}`,
      toolName: 'exec_command',
      input: { command: 'npm install axios', cwd: 'f:\\TraeProjects\\1', timeout: 60_000 },
      description: '执行命令: npm install axios',
    });
  }
  // 模拟工具调用（AI SDK v7 协议：tool-input-start → input-available → output-available，
  // 先于文本推送，验证工具卡渲染；start 与 available 间隔 400ms 保留 running 态时间窗）
  const toolCallId = `mock-tool-${Date.now()}`;
  for (const cb of streamCallbacks) {
    cb({
      sessionId,
      part: {
        type: 'tool-input-start',
        toolCallId,
        toolName: 'exec_command',
        title: 'exec_command',
      },
    });
  }
  setTimeout(() => {
    for (const cb of streamCallbacks) {
      cb({
        sessionId,
        part: {
          type: 'tool-input-available',
          toolCallId,
          toolName: 'exec_command',
          input: { command: 'ls -la' },
        },
      });
    }
    for (const cb of streamCallbacks) {
      cb({
        sessionId,
        part: {
          type: 'tool-output-available',
          toolCallId,
          output: { command: 'ls -la', exitCode: 0 },
        },
      });
    }
  }, 400);
  // AI SDK v7：UIMessageChunk 每个 chunk 必须带 id（text-start 先行）
  for (const cb of streamCallbacks) {
    cb({ sessionId, part: { type: 'text-start', id: messageId } });
  }
  let index = 0;
  const interval = setInterval(() => {
    if (index >= total.length) {
      clearInterval(interval);
      streamIntervals.delete(sessionId);
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
  streamIntervals.set(sessionId, interval);
}

/**
 * 全类型 part 演示（前端开发专用）：发送 "/demo" 触发
 * 覆盖 AI SDK v7 全部消息 part 类型：step-start / reasoning / text / 通用工具 /
 * edit_file（FileChangeCard）/ dynamic-tool / file 附件，验证各类展示组件
 */
function simulateAllPartsDemo(sessionId: string): void {
  messagesBySession[sessionId] ??= [];
  messagesBySession[sessionId].push({
    id: `u-${Date.now()}`,
    role: 'user',
    content: '/demo',
  });
  const demoMessageId = `demo-msg-${Date.now()}`;
  const push = (part: unknown, delay = 0): void => {
    setTimeout(() => {
      for (const cb of streamCallbacks) {
        cb({ sessionId, part });
      }
    }, delay);
  };
  // 1. reasoning：折叠式推理块（流式协议：reasoning-start → delta → end；
  //    start-step 已按用户要求移除（不再演示步骤分隔线））
  push({ type: 'reasoning-start', id: demoMessageId }, 150);
  push(
    {
      type: 'reasoning-delta',
      id: demoMessageId,
      delta: '正在分析用户需求：先拆分问题，再规划执行步骤，最后验证结果。',
    },
    250,
  );
  push({ type: 'reasoning-end', id: demoMessageId }, 350);
  // 3. text：Markdown（标题/列表/行内代码/代码块）
  const demoText =
    '### 全类型演示\n\n' +
    '这是一条包含**全部 part 类型**的模拟回复：\n\n' +
    '- step-start：步骤分隔线\n' +
    '- reasoning：折叠推理块\n' +
    '- tool：通用工具卡片 + `edit_file` diff 卡片\n' +
    '- dynamic-tool：动态工具\n' +
    '- file：附件卡片\n\n' +
    '```ts\nexport function demo(): string {\n  return "all parts";\n}\n```';
  push({ type: 'text-start', id: demoMessageId }, 400);
  push({ type: 'text-delta', id: demoMessageId, delta: demoText.slice(0, 60) }, 500);
  push({ type: 'text-delta', id: demoMessageId, delta: demoText.slice(60, 140) }, 700);
  push({ type: 'text-delta', id: demoMessageId, delta: demoText.slice(140) }, 900);
  // 4. 通用工具：exec_command（input-start → input-available → output-available）
  const toolId = `demo-tool-${Date.now()}`;
  push(
    {
      type: 'tool-input-start',
      toolCallId: toolId,
      toolName: 'exec_command',
      title: 'exec_command',
    },
    900,
  );
  push(
    {
      type: 'tool-input-available',
      toolCallId: toolId,
      toolName: 'exec_command',
      input: { command: 'pnpm test', cwd: 'f:\\TraeProjects\\1', timeout: 60_000 },
    },
    1100,
  );
  push(
    {
      type: 'tool-output-available',
      toolCallId: toolId,
      output: { command: 'pnpm test', exitCode: 0, stdout: 'Test Files  1 passed (1)' },
    },
    1300,
  );
  // 5. edit_file：FileChangeCard（diff 卡片）
  const editId = `demo-edit-${Date.now()}`;
  push(
    { type: 'tool-input-start', toolCallId: editId, toolName: 'edit_file', title: 'edit_file' },
    1500,
  );
  push(
    {
      type: 'tool-input-available',
      toolCallId: editId,
      toolName: 'edit_file',
      input: {
        path: 'src/renderer/components/chat/ChatPanel.tsx',
        oldString: '旧代码',
        newString: '新代码',
      },
    },
    1700,
  );
  push(
    {
      type: 'tool-output-available',
      toolCallId: editId,
      output: { ok: true, path: 'src/renderer/components/chat/ChatPanel.tsx' },
    },
    1900,
  );
  // 6. dynamic-tool：动态工具（dynamic-tool-input-start → input-available → output-available）
  const dynId = `demo-dyn-${Date.now()}`;
  push({ type: 'dynamic-tool-input-start', toolCallId: dynId, toolName: 'search_snippets' }, 2100);
  push(
    {
      type: 'tool-input-available',
      toolCallId: dynId,
      toolName: 'search_snippets',
      input: { query: 'IPC 定义表' },
    },
    2300,
  );
  push(
    {
      type: 'tool-output-available',
      toolCallId: dynId,
      output: { results: [{ path: 'packages/shared/src/ipc/meta.ts', snippet: 'goal: { ... }' }] },
    },
    2500,
  );
  // 7. 工具错误态：tool-output-error（红色错误卡）
  const errId = `demo-err-${Date.now()}`;
  push(
    { type: 'tool-input-start', toolCallId: errId, toolName: 'read_file', title: 'read_file' },
    2900,
  );
  push(
    {
      type: 'tool-input-available',
      toolCallId: errId,
      toolName: 'read_file',
      input: { path: 'src/nonexistent.ts' },
    },
    3100,
  );
  push(
    { type: 'tool-output-error', toolCallId: errId, errorText: '文件不存在: src/nonexistent.ts' },
    3300,
  );
  // 8. file：附件卡片
  push(
    {
      type: 'file',
      id: demoMessageId,
      file: {
        type: 'image',
        mediaType: 'image/svg+xml',
        data: '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"/>',
      },
    },
    3500,
  );
  // 9. 结束：end（含 usage）
  setTimeout(() => {
    messagesBySession[sessionId]?.push({
      id: demoMessageId,
      role: 'assistant',
      content: demoText,
    });
    const usage = { inputTokens: 260, outputTokens: 640, totalTokens: 900 };
    for (const cb of endCallbacks) {
      cb({ sessionId, reason: 'completed', usage });
    }
  }, 3900);
}

// ── 各域 mock 实现（参数类型从 IpcApi 推导）──────────────────

function createMockApi(): IpcApi {
  return {
    app: {
      getStatus: async () => ipcOk({ ready: true, protocolVersion: IPC_PROTOCOL_VERSION }),
      getInfo: async () =>
        ipcOk({
          version: '0.1.0-mock',
          electron: 'mock',
          node: 'mock',
          chrome: 'mock',
          platform: 'web',
          arch: 'x64',
          userDataPath: '（浏览器模式）',
        }),
      openExternal: async () => ipcOk({ ok: true }),
      openDataDir: async () => ipcOk({ ok: true }),
      // 诊断包导出：浏览器模式无真实打包，模拟用户取消（saved=false）
      exportDiagnostics: async () => ipcOk({ saved: false }),
      // 深度链接：浏览器模式无协议注册，订阅即返回 no-op unsubscribe
      subscribeDeepLink: () => () => {},
    },

    session: {
      list: async ({ limit }: Req<IpcApi['session']['list']>) => {
        // 对齐主进程排序：置顶优先，同置顶内 updatedAt 倒序
        const sorted = [...mockSessions].sort((a, b) => {
          if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
          return b.updatedAt - a.updatedAt;
        });
        return ipcOk({ sessions: sorted.slice(0, limit), total: sorted.length });
      },
      get: async ({ id }: Req<IpcApi['session']['get']>) => {
        const session = mockSessions.find((s) => s.id === id);
        if (session === undefined) {
          // 宽松兜底：任意 id 返回默认会话（dev mock——首页 DRAFT 场景需 workingDir 供 agent 发送）
          return ipcOk({
            session: {
              id,
              title: '新对话',
              workingDir: '/tmp',
              createdAt: Date.now(),
              updatedAt: Date.now(),
              lastMessage: undefined,
              messageCount: 0,
              lastRunStatus: 'idle',
              pinned: false,
            },
            messages: messagesBySession[id] ?? [],
          });
        }
        return ipcOk({ session, messages: messagesBySession[id] ?? [] });
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
        return ipcOk({ sessionId: id });
      },
      delete: async ({ id }: Req<IpcApi['session']['delete']>) => {
        const idx = mockSessions.findIndex((s) => s.id === id);
        if (idx >= 0) {
          mockSessions.splice(idx, 1);
        }
        return ipcOk({ ok: true });
      },
      rename: async ({ id, title }: Req<IpcApi['session']['rename']>) => {
        const s = mockSessions.find((x) => x.id === id);
        if (s !== undefined) {
          s.title = title;
        }
        return ipcOk({ ok: true });
      },
      pin: async ({ id, pinned }: Req<IpcApi['session']['pin']>) => {
        const s = mockSessions.find((x) => x.id === id);
        if (s !== undefined) {
          s.pinned = pinned;
          // 对齐主进程：pin 操作刷新 updatedAt（置顶排序依据）
          s.updatedAt = Date.now();
        }
        return ipcOk({ ok: true });
      },
      listRecentDirs: async () =>
        ipcOk({
          dirs: [
            { workingDir: 'f:\\TraeProjects\\1', lastUsed: now },
            { workingDir: 'f:\\TraeProjects\\2', lastUsed: now - 86_400_000 },
          ],
        }),
      exportAll: async () => ipcOk({ saved: false }),
      compact: async () => ipcOk({ removed: 0, remaining: 0, reclaimedTokens: 0, messages: [] }),
      getUsageSummary: async () => ipcOk(mockUsageSummary()),
      getTurns: async () => ipcOk({ sessionId: 'mock-1', turns: [] }),
      getRecentTurns: async () =>
        ipcOk({
          turns: [
            {
              turnId: 't1',
              sessionId: 'mock-1',
              seq: 3,
              modelId: 'deepseek-v4-flash',
              status: 'completed',
              inputTokens: 120,
              outputTokens: 320,
              totalTokens: 440,
              durationMs: 8_400,
              createdAt: now - 3_600_000,
            },
          ],
        }),
      getTurnMessages: async () => ipcOk({ messages: [] }),
    },

    models: {
      list: async () => ipcOk(mockModels()),
      listBuiltin: async () => ipcOk({ models: [] }),
      test: async () => ipcOk({ ok: true }),
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
        return ipcOk({ entries });
      },
      read: async ({ path }: Req<IpcApi['file']['read']>) => {
        const content = path.endsWith('.json')
          ? '{\n  "name": "mock"\n}\n'
          : '// MOCK 文件内容（前端独立开发模式）\nexport const hello = "world";\n';
        return ipcOk({ content, totalLines: content.split('\n').length, encoding: 'utf-8' });
      },
      write: async ({ content }: Req<IpcApi['file']['write']>) =>
        ipcOk({ bytesWritten: content.length }),
      create: async ({ path }: Req<IpcApi['file']['create']>) => ipcOk({ path }),
      createDir: async ({ path }: Req<IpcApi['file']['createDir']>) => ipcOk({ path }),
      delete: async () => ipcOk({ deleted: true }),
      rename: async ({ newPath }: Req<IpcApi['file']['rename']>) => ipcOk({ path: newPath }),
      watchStart: async () => ipcOk({ watcherId: 'mock-watcher' }),
      watchStop: async () => ipcOk({ stopped: true }),
      subscribeWatchEvent: () => () => {},
    },

    git: {
      status: async () => ipcOk(mockGitStatus()),
      diff: async () =>
        ipcOk({
          diff: '--- a/docs/design/09-ux-interaction-spec.md\n+++ b/docs/design/09-ux-interaction-spec.md\n@@ -1 +1 @@\n-旧内容\n+新内容\n',
          additions: 1,
          deletions: 1,
          filesChanged: 1,
        }),
      add: async () => ipcOk({ stagedCount: 2, stdout: '' }),
      commit: async () =>
        ipcOk({
          sha: 'a'.repeat(40),
          shortSha: 'aaaaaaa',
          branch: 'main',
          filesChanged: 2,
          additions: 1,
          deletions: 1,
          stdout: '',
        }),
      push: async () =>
        ipcOk({
          ok: true,
          pushedCount: 1,
          remote: 'origin',
          refspec: 'main',
          stdout: '',
          stderr: '',
        }),
    },

    terminal: {
      create: async ({ cwd }: Req<IpcApi['terminal']['create']>) => {
        const terminalId = `mock-term-${Date.now()}`;
        setTimeout(() => {
          for (const cb of terminalOutputCallbacks) {
            cb({ terminalId, data: `MOCK PTY：cwd=${cwd}\r\nPS> ` });
          }
        }, 100);
        return ipcOk({ terminalId, pid: 0 });
      },
      input: async ({ terminalId, data }: Req<IpcApi['terminal']['input']>) => {
        // 回显输入（模拟 shell）
        for (const cb of terminalOutputCallbacks) {
          cb({ terminalId, data: `\r\n${data}\r\nPS> ` });
        }
        return ipcOk({ ok: true });
      },
      resize: async () => ipcOk({ ok: true }),
      kill: async () => ipcOk({ ok: true }),
      subscribeCreatedEvent: () => () => {},
      subscribeOutputEvent: (cb: Parameters<IpcApi['terminal']['subscribeOutputEvent']>[0]) => {
        terminalOutputCallbacks.add(cb as (payload: { terminalId: string; data: string }) => void);
        return () => terminalOutputCallbacks.delete(cb);
      },
      subscribeExitEvent: () => () => {},
    },

    agent: {
      run: async ({ sessionId, messages }: Req<IpcApi['agent']['run']>) => {
        // ChatMessageSchema 是 z.custom<ModelMessage>（宽松校验），z.input 为 unknown——
        // mock 层显式收窄回 ModelMessage（真实运行链路经主进程校验后即为此类型）
        const msgs = messages as ModelMessage[];
        // convertToModelMessages 后 content 可能是字符串或数组（多 part），兼容两种
        const lastUserText = [...msgs].reverse().find((m) => m.role === 'user');
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
        // 模拟 Agent 提问（AskDialog E2E 用）：输入以 /ask 开头时，流式期间推送一条提问事件
        if (text.startsWith('/ask')) {
          setTimeout(() => {
            const askPayload = {
              sessionId: sessionId ?? 'mock-1',
              askId: `mock-ask-${Date.now()}`,
              questions: [
                {
                  question: '是否确认执行此操作？',
                  options: [
                    { label: '确认执行', value: 'yes' },
                    { label: '取消', value: 'no' },
                  ],
                },
              ],
            };
            for (const cb of askCallbacks) {
              cb(askPayload);
            }
          }, 600);
        }
        // P0 修复：与真实 IPC 信封一致返回 { data: { sessionId } }。
        // 此前返回裸 { sessionId } 与 IpcResponse 契约相悖（真实链路经 wrap 包装为 { data }），
        // transport 按 response.data.sessionId 解包，裸对象导致 currentSessionId 恒为 undefined、
        // 流式事件按 sessionId 过滤后全部丢失（浏览器模式 agent 流式即坏）
        return ipcOk({ sessionId: sessionId ?? 'mock-1' });
      },
      stop: async ({ sessionId }: Req<IpcApi['agent']['stop']>) => {
        // 真正中断模拟流（对齐主进程行为：清除定时器 + 推送 interrupted end）
        const interval = streamIntervals.get(sessionId);
        if (interval !== undefined) {
          clearInterval(interval);
          streamIntervals.delete(sessionId);
          const usage = { inputTokens: 60, outputTokens: 120, totalTokens: 180 };
          for (const cb of endCallbacks) {
            cb({ sessionId, reason: 'aborted', usage });
          }
        }
        return ipcOk({ stopped: true });
      },
      approvalResponse: async () => ipcOk({ ok: true }),
      respondAsk: async () => ipcOk({ ok: true }),
      subscribeStreamPart: (cb: Parameters<IpcApi['agent']['subscribeStreamPart']>[0]) => {
        streamCallbacks.add(cb);
        return () => streamCallbacks.delete(cb);
      },
      subscribeStreamEnd: (cb: Parameters<IpcApi['agent']['subscribeStreamEnd']>[0]) => {
        endCallbacks.add(cb);
        return () => endCallbacks.delete(cb);
      },
      subscribeStreamError: (cb: Parameters<IpcApi['agent']['subscribeStreamError']>[0]) => {
        errorCallbacks.add(cb);
        return () => errorCallbacks.delete(cb);
      },
      subscribeToolCall: () => () => {},
      subscribeToolResult: () => () => {},
      subscribeApprovalRequest: (
        cb: Parameters<IpcApi['agent']['subscribeApprovalRequest']>[0],
      ) => {
        approvalCallbacks.add(cb);
        return () => approvalCallbacks.delete(cb);
      },
      subscribeAsk: (cb: Parameters<IpcApi['agent']['subscribeAsk']>[0]) => {
        askCallbacks.add(cb);
        return () => askCallbacks.delete(cb);
      },
    },

    settings: {
      // S1：settings 下沉 SQLite 的 mock 实现（浏览器模式持久化到 localStorage）
      getAll: async () => {
        const raw = localStorage.getItem('mock-settings');
        return ipcOk({
          settings: raw === null ? {} : (JSON.parse(raw) as Record<string, unknown>),
        });
      },
      set: async (input: Req<IpcApi['settings']['set']>) => {
        const raw = localStorage.getItem('mock-settings');
        const cur: Record<string, unknown> =
          raw === null ? {} : (JSON.parse(raw) as Record<string, unknown>);
        cur[input.key] = input.value;
        localStorage.setItem('mock-settings', JSON.stringify(cur));
        return ipcOk({ ok: true });
      },
      getApiKey: async () => {
        // localStorage 持久化（模拟真实 keychain 跨重启保留——E2E 前置配置后 reload 仍生效）
        // P0 安全对齐：与真实 handler 一致只返回配置状态布尔，不回传明文
        const key = localStorage.getItem('mock-api-key');
        return ipcOk({ configured: key !== null && key !== '' });
      },
      setApiKey: async (input: Req<IpcApi['settings']['setApiKey']>) => {
        localStorage.setItem('mock-api-key', input.apiKey);
        return ipcOk({ ok: true });
      },
      deleteApiKey: async () => ipcOk({ ok: true }),
      getTelemetryLevel: async () => ipcOk({ level: 'off' }),
      setTelemetryLevel: async () => ipcOk({ ok: true, level: 'off' }),
      getApprovalMode: async () => ipcOk({ mode: 'ask' }),
      setApprovalMode: async () => ipcOk({ ok: true, mode: 'ask' }),
      addRuntimeModel: async () => ipcOk({ ok: true }),
      updateRuntimeModel: async (input: Req<IpcApi['settings']['updateRuntimeModel']>) => {
        const model = mockRuntimeModels.find((m) => m.modelId === input.modelId);
        if (model !== undefined) Object.assign(model, { isEnabled: input.isEnabled });
        return ipcOk({ ok: true });
      },
      removeRuntimeModel: async (input: Req<IpcApi['settings']['removeRuntimeModel']>) => {
        mockRuntimeModels = mockRuntimeModels.filter((m) => m.modelId !== input.modelId);
        return ipcOk({ ok: true });
      },
      // 运行时模型：返回模块级可变状态（开关/删除在 Web 预览实时生效）
      listRuntimeModels: async () => ipcOk({ models: mockRuntimeModels }),
    },

    whitelist: {
      list: async () => ipcOk({ entries: [] }),
      add: async () => ipcOk({ ok: true }),
      remove: async () => ipcOk({ ok: true }),
    },

    mcp: {
      list: async () => ipcOk({ servers: [] }),
      start: async () => ipcOk({ ok: true }),
      stop: async () => ipcOk({ ok: true }),
    },
    skill: {
      list: async () => ipcOk({ skills: [] }),
      listLearned: async () => ipcOk([]),
      learn: async () => ipcOk({ name: '', description: '', prompt: '', replaced: false }),
      removeLearned: async () => ipcOk({ removed: true }),
    },
    memory: {
      list: async () => ipcOk({ memories: [] }),
      clear: async () => ipcOk({ ok: true }),
    },
    goal: {
      list: async ({ sessionId }: Req<IpcApi['goal']['list']>) => {
        const goals: GoalInfo[] = mockGoals
          .filter((g) => sessionId === undefined || g.sessionId === sessionId)
          .map((g) => ({
            sessionId: g.sessionId,
            condition: g.condition,
            status: 'active',
            iterations: 0,
            lastReason: null,
            createdAt: Date.now(),
            finishedAt: null,
          }));
        return ipcOk({ goals });
      },
      create: async ({ sessionId, condition }: Req<IpcApi['goal']['create']>) => {
        // 对齐主进程语义：新建覆盖旧目标
        const idx = mockGoals.findIndex((g) => g.sessionId === sessionId);
        if (idx >= 0) {
          mockGoals.splice(idx, 1);
        }
        mockGoals.push({ sessionId, condition });
        return ipcOk({ ok: true });
      },
      clear: async ({ sessionId }: Req<IpcApi['goal']['clear']>) => {
        const idx = mockGoals.findIndex((g) => g.sessionId === sessionId);
        if (idx >= 0) {
          mockGoals.splice(idx, 1);
        }
        return ipcOk({ ok: true });
      },
    },
    task: {
      list: async () =>
        ipcOk({
          tasks: [
            {
              id: 'task-1',
              sessionId: 'mock-1',
              kind: 'agent-child',
              description: '拆分 IPC 定义表：meta.ts + definitions.ts',
              status: 'completed',
              startTime: Date.now() - 60_000,
              endTime: Date.now() - 30_000,
            },
            {
              id: 'task-2',
              sessionId: 'mock-1',
              kind: 'agent-child',
              description: '补充 derive.ts 类型推导 + register.ts 统一注册',
              status: 'running',
              startTime: Date.now() - 20_000,
              endTime: null,
            },
          ],
        }),
    },

    system: {
      getStatus: async () => ipcOk(mockSystemStatus()),
    },

    logs: {
      read: async () =>
        ipcOk({
          filePath: '（浏览器模式无日志文件）',
          total: 3,
          truncated: false,
          lines: ['[info] mock 日志行 1', '[warn] mock 日志行 2', '[error] mock 日志行 3'],
        }),
    },

    devtools: {
      open: async () => ipcOk({ ok: true, mode: 'detach' }),
    },

    dialog: {
      pickDirectory: async () => ipcOk({ canceled: true }),
      pickFiles: async () => ipcOk({ canceled: true, paths: [] }),
    },

    update: {
      check: async () => ipcOk({ status: 'up-to-date' }),
      install: async () => ipcOk({ ok: true }),
      subscribeStatus: (cb: Parameters<IpcApi['update']['subscribeStatus']>[0]) => {
        updateStatusCallbacks.add(cb);
        return () => updateStatusCallbacks.delete(cb);
      },
    },

    im: {
      list: async () => ipcOk({ channels: [] }),
      start: async () => ipcOk({ ok: true }),
      stop: async () => ipcOk({ ok: true }),
    },
    remote: {
      getStatus: async () => ipcOk(mockRemoteStatus()),
      start: async () => {
        mockRemoteRunning = true;
        return ipcOk(mockRemoteStatus());
      },
      stop: async () => {
        mockRemoteRunning = false;
        return ipcOk(mockRemoteStatus());
      },
    },
    tool: {
      list: async () => ipcOk({ tools: [] }),
    },
    search: {
      grep: async () => ipcOk({ matches: [], truncated: false }),
      glob: async ({ pattern }: Req<IpcApi['search']['glob']>) => {
        // 模拟文件匹配（模糊搜索用）：解析 `**/*[aA]pp*` → 'app'（字符类取首字符）
        const query = pattern
          .replace(/^\*\*\/\*/, '')
          .replace(/\*$/, '')
          .replace(/\[(.)(.)\]/g, '$1')
          .toLowerCase();
        const files = DEMO_FILES.filter((f) => f.toLowerCase().includes(query));
        return ipcOk({ files, truncated: false });
      },
    },
    browser: createBrowserMock(),
  } satisfies IpcApi;
}

/** browser 域 mock：浏览器模式无主进程 WebContentsView，导航 no-op，状态恒空 */
function createBrowserMock(): IpcApi['browser'] {
  return {
    navigate: async () => ipcOk({ ok: true }),
    back: async () => ipcOk({ ok: true }),
    forward: async () => ipcOk({ ok: true }),
    reload: async () => ipcOk({ ok: true }),
    setViewport: async () => ipcOk({ ok: true }),
    configure: async () => ipcOk({ ok: true }),
    getState: async () =>
      ipcOk({ url: null, title: null, isLoading: false, canGoBack: false, canGoForward: false }),
    subscribeState: () => () => {},
    subscribeLoadFailed: () => () => {},
  };
}

/** search:glob 模拟文件清单（模糊搜索用） */
const DEMO_FILES: readonly string[] = [
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
];

/** 注入 mock window.api（仅前端独立开发模式调用） */
export function installMockApi(): void {
  const api = createMockApi();
  Object.defineProperty(window, 'api', {
    value: api,
    writable: true,
    configurable: true,
  });
}
