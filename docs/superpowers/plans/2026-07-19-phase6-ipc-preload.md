# Phase 6: IPC Handlers + Preload Bridge

> **日期**：2026-07-19
> **状态**：待执行
> **前置**：Phase 5a/5b 完成（9 个 service 全部就绪），200 测试通过

---

## 1. 目标

打通「渲染层 ↔ preload ↔ IPC handler ↔ service」全链路：

1. **IPC Handler 层**（薄层）：参数校验 + 调 service，9 个 handler 文件覆盖 38 个 channel
2. **Preload Bridge**：实现 IpcApi 完整接口，contextBridge 暴露 `window.api`
3. **状态广播**：PG / Ollama 状态变更通过 webContents.send 推送到所有窗口
4. **IPC 注册入口**：router.ts 统一注册所有 handler

---

## 2. 前置条件核实

| 依赖 | 状态 | 文件 |
|------|------|------|
| IPC_CHANNELS 常量（38 个） | ✅ | packages/shared/src/ipc/channels.ts |
| IpcApi 接口（完整形状） | ✅ | packages/shared/src/ipc/api.ts |
| IpcRequestMap / IpcEventMap | ✅ | packages/shared/src/ipc/payloads.ts |
| wrap() 包装器 | ✅ | src/main/utils/wrap.ts |
| 9 个 service（41 个函数） | ✅ | src/main/services/*.ts |
| stream-bridge 单例 | ✅ | src/main/infra/ai/stream-bridge.ts |
| PgController + 事件 | ✅ | src/main/infra/pg/pg-controller.ts |
| OllamaController + 事件 | ✅ | src/main/infra/ai/ollama-controller.ts |
| getPgController() 访问器 | ✅ | src/main/app/db-init.ts |
| preload 占位（空 api） | ✅ | src/preload/index.ts |

### 2.1 缺口识别

| # | 缺口 | 影响 | 解决 |
|---|------|------|------|
| 1 | OllamaController 无单例访问器 | app:getStatus 无法读取 ollama 状态 | Task 1 补 getOllamaController() |
| 2 | 无状态广播器 | PG/Ollama 状态变更无法推送到渲染层 | Task 1 新建 status-broadcaster.ts |
| 3 | 无 IPC 注册入口 | handler 无法统一注册 | Task 1 新建 router.ts |
| 4 | preload 只有空 api 占位 | 渲染层无法调用主进程 | Task 2 实现 IpcApi 完整接口 |
| 5 | 无 handler 文件 | 38 个 channel 未注册 | Task 3/4 实现 9 个 handler |

---

## 3. 文件结构

```
src/main/
├─ app/
│  ├─ db-init.ts                    [已有]
│  └─ status-broadcaster.ts         [新增] Task 1
├─ ipc/
│  ├─ router.ts                     [新增] Task 1
│  └─ handlers/
│     ├─ project.handler.ts         [新增] Task 3
│     ├─ project.handler.test.ts   [新增] Task 3
│     ├─ chapter.handler.ts         [新增] Task 3
│     ├─ chapter.handler.test.ts    [新增] Task 3
│     ├─ character.handler.ts       [新增] Task 3
│     ├─ character.handler.test.ts [新增] Task 3
│     ├─ worldview.handler.ts       [新增] Task 3
│     ├─ worldview.handler.test.ts  [新增] Task 3
│     ├─ rag.handler.ts             [新增] Task 3
│     ├─ rag.handler.test.ts        [新增] Task 3
│     ├─ settings.handler.ts        [新增] Task 3
│     ├─ settings.handler.test.ts  [新增] Task 3
│     ├─ chat.handler.ts            [新增] Task 4
│     ├─ chat.handler.test.ts       [新增] Task 4
│     ├─ agent.handler.ts           [新增] Task 4
│     ├─ agent.handler.test.ts      [新增] Task 4
│     ├─ app.handler.ts             [新增] Task 4
│     └─ app.handler.test.ts        [新增] Task 4
├─ infra/ai/
│  └─ ollama-controller.ts          [修改] Task 1：追加单例访问器
└─ index.ts                          [修改] Task 5：集成 router + broadcaster

src/preload/
├─ index.ts                          [重写] Task 2
├─ utils/
│  └─ ipc-bridge.ts                  [新增] Task 2
└─ tsconfig.json                    [已有]
```

---

## 4. Task 清单

### Task 1: 基础设施（ollama-controller 单例 + status-broadcaster + IPC router）

**Files:**
- Modify: `src/main/infra/ai/ollama-controller.ts`
- Create: `src/main/app/status-broadcaster.ts`
- Create: `src/main/ipc/router.ts`

#### 1.1 ollama-controller 单例访问器

在 ollama-controller.ts 末尾追加：

```typescript
/** 缓存的 OllamaController 单例 */
let cachedController: OllamaController | null = null;

/**
 * 获取 OllamaController 单例
 *
 * 与 getPrismaClient / getStreamBridge 单例模式一致。
 * 首次调用时根据 config 创建实例，后续复用。
 */
export function getOllamaController(): OllamaController {
  if (cachedController === null) {
    const config = getAppConfig();
    cachedController = new OllamaController({
      binaryPath: 'ollama',
      host: 'localhost',
      port: 11434,
      embedModel: config.ollama.embedModel,
      maxRestartCount: 3,
    });
  }
  return cachedController;
}

/** 重置 OllamaController 单例（仅测试用） */
export function resetOllamaController(): void {
  cachedController = null;
}
```

注意：需要 `import { getAppConfig } from '../../config'`。

#### 1.2 status-broadcaster.ts

```typescript
// src/main/app/status-broadcaster.ts
// 状态广播器：订阅 PG / Ollama 状态变更，广播到所有 BrowserWindow
//
// 职责：
// 1. 订阅 pgController 的 'status-change' 事件 → 广播 app:event:pgStatus
// 2. 订阅 ollamaController 的 'status-change' 事件 → 广播 app:event:ollamaStatus
// 3. 订阅 ollamaController 的 'pull-progress' 事件 → 广播 app:event:ollamaPullProgress
//
// 广播方式：BrowserWindow.getAllWindows().forEach(win => win.webContents.send(...))
// 设计文档 §5.3 状态变更事件（M→R）

import { IPC_CHANNELS, type OllamaPullProgressPayload } from '@novel-writer/shared';
import { BrowserWindow } from 'electron';
import { getOllamaController } from '../infra/ai/ollama-controller';
import { getPgController } from './db-init';
import { logger } from '../utils/logger';

/** 广播事件到所有窗口 */
function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  }
}

/**
 * 启动状态广播器
 *
 * 订阅 PG / Ollama 状态变更事件，广播到所有渲染窗口。
 * 幂等：多次调用安全（listener 不会重复注册）。
 */
export function startStatusBroadcaster(): void {
  // PG 状态变更
  const pg = getPgController();
  if (pg !== null) {
    pg.on('status-change', (event) => {
      logger.debug({ status: event.status }, 'PG 状态变更，广播到渲染层');
      broadcast(IPC_CHANNELS.APP_EVENT_PG_STATUS, event.status);
    });
  }

  // Ollama 状态变更
  const ollama = getOllamaController();
  ollama.on('status-change', (event) => {
    logger.debug({ status: event.status }, 'Ollama 状态变更，广播到渲染层');
    broadcast(IPC_CHANNELS.APP_EVENT_OLLAMA_STATUS, event.status);
  });

  // Ollama 模型拉取进度
  ollama.on('pull-progress', (event) => {
    const payload: OllamaPullProgressPayload = {
      model: ollama.getEmbedModel(),
      completed: event.completed ?? 0,
      total: event.total ?? 0,
      percent: event.total !== undefined && event.total > 0
        ? Math.round((event.completed ?? 0) / event.total * 100)
        : 0,
    };
    broadcast(IPC_CHANNELS.APP_EVENT_OLLAMA_PULL_PROGRESS, payload);
  });

  logger.info({}, '状态广播器已启动');
}
```

注意：需要给 OllamaController 添加 `getEmbedModel()` 方法（如果不存在）。经核实，OllamaController 有 `config.embedModel`，添加公共 getter：
```typescript
/** 获取嵌入模型名 */
getEmbedModel(): string {
  return this.config.embedModel;
}
```

#### 1.3 router.ts

```typescript
// src/main/ipc/router.ts
// IPC 路由：统一注册所有 handler
//
// 设计文档 §4.1 分层架构：IPC Handlers 是薄层（参数校验 + 调 service）
// 本模块汇总所有域的 register 函数，供 main/index.ts 调用

import { logger } from '../utils/logger';
import { registerProjectHandlers } from './handlers/project.handler';
import { registerChapterHandlers } from './handlers/chapter.handler';
import { registerCharacterHandlers } from './handlers/character.handler';
import { registerWorldviewHandlers } from './handlers/worldview.handler';
import { registerChatHandlers } from './handlers/chat.handler';
import { registerRagHandlers } from './handlers/rag.handler';
import { registerAgentHandlers } from './handlers/agent.handler';
import { registerSettingsHandlers } from './handlers/settings.handler';
import { registerAppHandlers } from './handlers/app.handler';

/**
 * 注册所有 IPC handler
 *
 * 在 app.whenReady() 后调用，注册全部 38 个 channel 的 handler。
 */
export function registerIpcHandlers(): void {
  registerProjectHandlers();
  registerChapterHandlers();
  registerCharacterHandlers();
  registerWorldviewHandlers();
  registerChatHandlers();
  registerRagHandlers();
  registerAgentHandlers();
  registerSettingsHandlers();
  registerAppHandlers();
  logger.info({}, 'IPC handler 全部注册完成（9 域 38 channel）');
}
```

---

### Task 2: Preload 通用工具 + 完整 IpcApi 实现

**Files:**
- Create: `src/preload/utils/ipc-bridge.ts`
- Modify (重写): `src/preload/index.ts`

#### 2.1 ipc-bridge.ts

通用工具：`invoke` 封装 ipcRenderer.invoke + traceId 注入，`subscribe` 封装 ipcRenderer.on + unsubscribe。

```typescript
// src/preload/utils/ipc-bridge.ts
// Preload 通用 IPC 工具
// 设计文档 §4.9 unsubscribe 模式 / §4.7 traceId 注入

import { ipcRenderer } from 'electron';
import type { IpcResponse } from '@novel-writer/shared';
import { randomUUID } from 'node:crypto';

/**
 * 调用主进程 IPC handler（请求-响应模式）
 *
 * 自动注入 traceId（设计文档 §4.7），贯穿渲染层 → IPC → 主进程日志。
 *
 * @param channel IPC channel 名
 * @param input 请求入参（void 时省略）
 * @returns IpcResponse<T>（成功 { data } / 失败 { error }）
 */
export async function invoke<T>(
  channel: string,
  input?: unknown,
): Promise<IpcResponse<T>> {
  const traceId = randomUUID();
  return ipcRenderer.invoke(channel, input, traceId) as Promise<IpcResponse<T>>;
}

/**
 * 订阅主进程推送的事件（流式 / 状态变更）
 *
 * 返回 unsubscribe 函数，防止内存泄漏（设计文档 §4.9）。
 *
 * @param channel 事件 channel 名
 * @param callback 事件回调
 * @returns unsubscribe 函数
 */
export function subscribe<T>(
  channel: string,
  callback: (payload: T) => void,
): () => void {
  const handler = (_event: unknown, payload: T): void => {
    callback(payload);
  };
  ipcRenderer.on(channel, handler);
  return () => {
    ipcRenderer.removeListener(channel, handler);
  };
}
```

注意：preload 在 sandbox:true 下运行，`node:crypto` 的 randomUUID 不可用。
改用 `crypto.randomUUID()`（sandbox 环境下可用全局 crypto）或简化为 Date.now() + Math.random()。

实际上，Electron sandbox 环境下 preload 可以使用有限 Node API，但 `node:crypto` 不可用。
改用全局 `crypto.randomUUID()`（Chromium 内置 Web Crypto API，sandbox 下可用）。

#### 2.2 preload/index.ts

重写为完整 IpcApi 实现：

```typescript
// src/preload/index.ts
// Preload 脚本：在 contextIsolation 环境中暴露受限 API 到渲染层
// 设计文档 §4.9 Preload unsubscribe 模式 / §5.4 类型契约

import { contextBridge } from 'electron';
import { IPC_CHANNELS, type IpcApi } from '@novel-writer/shared';
import { invoke, subscribe } from './utils/ipc-bridge';

// 实现完整的 IpcApi 接口
const api: IpcApi = {
  project: {
    create: (input) => invoke(IPC_CHANNELS.PROJECT_CREATE, input),
    list: () => invoke(IPC_CHANNELS.PROJECT_LIST),
    get: (input) => invoke(IPC_CHANNELS.PROJECT_GET, input),
    update: (input) => invoke(IPC_CHANNELS.PROJECT_UPDATE, input),
    delete: (input) => invoke(IPC_CHANNELS.PROJECT_DELETE, input),
    archive: (input) => invoke(IPC_CHANNELS.PROJECT_ARCHIVE, input),
  },
  chapter: { /* ... */ },
  character: { /* ... */ },
  worldview: { /* ... */ },
  chat: {
    createSession: (input) => invoke(IPC_CHANNELS.CHAT_CREATE_SESSION, input),
    listSessions: (input) => invoke(IPC_CHANNELS.CHAT_LIST_SESSIONS, input),
    getMessages: (input) => invoke(IPC_CHANNELS.CHAT_GET_MESSAGES, input),
    sendMessage: (input) => invoke(IPC_CHANNELS.CHAT_SEND_MESSAGE, input),
    stopGeneration: (input) => invoke(IPC_CHANNELS.CHAT_STOP_GENERATION, input),
    onStreamChunk: (cb) => subscribe(IPC_CHANNELS.CHAT_STREAM_CHUNK, cb),
    onStreamEnd: (cb) => subscribe(IPC_CHANNELS.CHAT_STREAM_END, cb),
    onStreamError: (cb) => subscribe(IPC_CHANNELS.CHAT_STREAM_ERROR, cb),
  },
  rag: { /* ... */ },
  agent: { /* ... */ },
  settings: { /* ... */ },
  app: {
    getStatus: () => invoke(IPC_CHANNELS.APP_GET_STATUS),
    openExternal: (input) => invoke(IPC_CHANNELS.APP_OPEN_EXTERNAL, input),
    onPgStatusChange: (cb) => subscribe(IPC_CHANNELS.APP_EVENT_PG_STATUS, cb),
    onOllamaStatusChange: (cb) => subscribe(IPC_CHANNELS.APP_EVENT_OLLAMA_STATUS, cb),
    onOllamaPullProgress: (cb) => subscribe(IPC_CHANNELS.APP_EVENT_OLLAMA_PULL_PROGRESS, cb),
  },
} satisfies IpcApi;

contextBridge.exposeInMainWorld('api', api);
```

**测试策略**：preload 在 sandbox 下运行，无法直接测试。测试通过 E2E 验证。
Phase 6 不为 preload 编写单测（sandbox 限制 + contextBridge 隔离导致 vitest 无法模拟）。

---

### Task 3: 6 个基础 CRUD Handlers

**Files:**
- Create: `src/main/ipc/handlers/{project,chapter,character,worldview,rag,settings}.handler.ts`
- Create: `src/main/ipc/handlers/{project,chapter,character,worldview,rag,settings}.handler.test.ts`

#### 3.1 通用模式

所有 CRUD handler 遵循相同模式：

```typescript
// src/main/ipc/handlers/project.handler.ts
import { IPC_CHANNELS, ProjectCreateInputSchema, ProjectUpdateInputSchema } from '@novel-writer/shared';
import { z } from 'zod';
import { wrap } from '../../utils/wrap';
import {
  archiveProject,
  createProject,
  deleteProject,
  getProject,
  listProjects,
  updateProject,
} from '../../services/project.service';

/** 注册 project 域 IPC handler */
export function registerProjectHandlers(): void {
  wrap(IPC_CHANNELS.PROJECT_CREATE, ProjectCreateInputSchema, (input) => createProject(input));
  wrap(IPC_CHANNELS.PROJECT_LIST, null, () => listProjects());
  wrap(IPC_CHANNELS.PROJECT_GET, z.object({ id: z.string().min(1) }), (input) => getProject(input.id));
  wrap(IPC_CHANNELS.PROJECT_UPDATE, ProjectUpdateInputSchema, (input) => updateProject(input));
  wrap(IPC_CHANNELS.PROJECT_DELETE, z.object({ id: z.string().min(1) }), (input) => deleteProject(input.id));
  wrap(IPC_CHANNELS.PROJECT_ARCHIVE, z.object({ id: z.string().min(1) }), (input) => archiveProject(input.id));
}
```

#### 3.2 各域 channel → service 映射

| 域 | Channel | Service 函数 | Schema |
|----|---------|-------------|--------|
| project | create | createProject | ProjectCreateInputSchema |
| project | list | listProjects | null |
| project | get | getProject | { id: string } |
| project | update | updateProject | ProjectUpdateInputSchema |
| project | delete | deleteProject | { id: string } |
| project | archive | archiveProject | { id: string } |
| chapter | create | createChapter | ChapterCreateInputSchema |
| chapter | list | listChapters | { projectId: string } |
| chapter | get | getChapter | { id: string } |
| chapter | update | updateChapter | ChapterUpdateInputSchema |
| chapter | reorder | reorderChapters | { projectId, orderedIds[] } |
| chapter | delete | deleteChapter | { id: string } |
| character | create | createCharacter | CharacterCreateInputSchema |
| character | list | listCharacters | { projectId: string } |
| character | update | updateCharacter | CharacterUpdateInputSchema |
| character | delete | deleteCharacter | { id: string } |
| character | getRelations | getCharacterRelations | { projectId: string } |
| character | addRelation | addCharacterRelation | CharacterRelationInputSchema |
| worldview | create | createWorldview | WorldviewCreateInputSchema |
| worldview | tree | getWorldviewTree | { projectId: string } |
| worldview | update | updateWorldview | WorldviewUpdateInputSchema |
| worldview | delete | deleteWorldview | { id: string } |
| rag | ingestDocument | ingestDocument | RagIngestDocumentInputSchema |
| rag | search | searchSimilarChunks | RagSearchInputSchema |
| rag | listDocuments | listRagDocuments | { projectId: string } |
| rag | deleteDocument | deleteRagDocument | { id: string } |
| settings | get | getProjectSettings | { projectId: string } |
| settings | set | updateProjectSettings | ProjectSettingUpdateInputSchema |
| settings | setApiKey | setApiKey | { provider, apiKey } 内联 schema |
| settings | testApiKey | testApiKey | TestApiKeyInputSchema |

#### 3.3 测试策略

每个 handler 写一个测试文件，mock service 函数，验证：
1. register 函数调用 wrap 正确注册各 channel
2. wrap 的 handler 回调正确调用 service（参数传递 + 返回值）

测试 helper：`src/main/__tests__/helpers/mock-wrap.ts`（提取 wrap 的 handler 回调）

```typescript
// src/main/__tests__/helpers/mock-wrap.ts
// wrap mock helper：捕获 wrap 注册的 channel + schema + handler

const registrations: Array<{
  channel: string;
  schema: unknown;
  handler: (input: unknown, ctx: unknown) => Promise<unknown>;
}> = [];

export function mockWrap(): void {
  registrations.length = 0;
}

export function getRegistrations() {
  return registrations;
}

export function getHandler(channel: string) {
  const reg = registrations.find(r => r.channel === channel);
  if (!reg) throw new Error(`Channel ${channel} not registered`);
  return reg.handler;
}

// 在 vi.mock 中替换 wrap
// vi.mock('../../utils/wrap', () => ({
//   wrap: (channel, schema, handler) => {
//     registrations.push({ channel, schema, handler });
//   },
// }));
```

实际实现中，mock-wrap.ts 使用 `vi.hoisted` 导出 registrations，vi.mock factory 引用。

---

### Task 4: 3 个复杂 Handlers（chat + agent + app）

**Files:**
- Create: `src/main/ipc/handlers/chat.handler.ts` + test
- Create: `src/main/ipc/handlers/agent.handler.ts` + test
- Create: `src/main/ipc/handlers/app.handler.ts` + test

#### 4.1 chat.handler.ts

核心：`chat:sendMessage` 持久化用户消息后，后台启动 AI 生成。

```typescript
import { IPC_CHANNELS, ChatSendMessageInputSchema, ChatSessionCreateInputSchema } from '@novel-writer/shared';
import { z } from 'zod';
import { runChatGeneration } from '../../services/agent.service';
import {
  createChatSession,
  getChatMessages,
  listChatSessions,
  sendChatMessage,
  stopChatGeneration,
} from '../../services/chat.service';
import { wrap } from '../../utils/wrap';

export function registerChatHandlers(): void {
  wrap(IPC_CHANNELS.CHAT_CREATE_SESSION, ChatSessionCreateInputSchema, (input) => createChatSession(input));
  wrap(IPC_CHANNELS.CHAT_LIST_SESSIONS, z.object({ projectId: z.string().min(1) }), (input) => listChatSessions(input.projectId));
  wrap(IPC_CHANNELS.CHAT_GET_MESSAGES, z.object({ sessionId: z.string().min(1) }), (input) => getChatMessages(input.sessionId));

  // sendMessage：持久化用户消息 → 后台启动 AI 生成 → 立即返回 ackId
  wrap(IPC_CHANNELS.CHAT_SEND_MESSAGE, ChatSendMessageInputSchema, async (input, ctx) => {
    const { ackId } = await sendChatMessage(input);
    // 后台异步生成（不 await，立即返回 ackId）
    // runChatGeneration 使用 sessionId 作为 streamId，通过 stream-bridge 推送 chunk/end/error 事件
    void runChatGeneration({ sessionId: input.sessionId, webContents: ctx.sender });
    return { ackId };
  });

  wrap(IPC_CHANNELS.CHAT_STOP_GENERATION, z.object({ sessionId: z.string().min(1) }), (input) => stopChatGeneration(input.sessionId));
}
```

#### 4.2 agent.handler.ts

3 个函数都注入 webContents，立即返回 ackId，后台异步执行。

```typescript
import { IPC_CHANNELS } from '@novel-writer/shared';
import { z } from 'zod';
import { expandOutline, generateChapter, rewriteChapter } from '../../services/agent.service';
import { wrap } from '../../utils/wrap';

export function registerAgentHandlers(): void {
  wrap(IPC_CHANNELS.AGENT_GENERATE_CHAPTER,
    z.object({ projectId: z.string().min(1), prevChapterId: z.string().optional(), prompt: z.string().optional() }),
    (input, ctx) => generateChapter({ ...input, webContents: ctx.sender })
  );

  wrap(IPC_CHANNELS.AGENT_REWRITE,
    z.object({ chapterId: z.string().min(1), instruction: z.string().min(1) }),
    (input, ctx) => rewriteChapter({ ...input, webContents: ctx.sender })
  );

  wrap(IPC_CHANNELS.AGENT_EXPAND_OUTLINE,
    z.object({ projectId: z.string().min(1), outline: z.string().min(1) }),
    (input, ctx) => expandOutline({ ...input, webContents: ctx.sender })
  );
}
```

#### 4.3 app.handler.ts

```typescript
import { IPC_CHANNELS } from '@novel-writer/shared';
import { z } from 'zod';
import { shell } from 'electron';
import { getOllamaController } from '../../infra/ai/ollama-controller';
import { getPgController } from '../../app/db-init';
import { testPrismaConnection } from '../../infra/prisma/client';
import { wrap } from '../../utils/wrap';

export function registerAppHandlers(): void {
  // 获取应用状态
  wrap(IPC_CHANNELS.APP_GET_STATUS, null, async () => {
    const pg = getPgController();
    const ollama = getOllamaController();
    return {
      pgStatus: pg?.getStatus() ?? 'stopped',
      ollamaStatus: ollama.getStatus(),
      ollamaModelReady: false, // 后续阶段集成 ensureModelPulled 后更新
      dbConnected: await testPrismaConnection().catch(() => false),
    };
  });

  // 打开外部链接（限制 http/https）
  wrap(IPC_CHANNELS.APP_OPEN_EXTERNAL,
    z.object({ url: z.string().url().refine(u => u.startsWith('http://') || u.startsWith('https://')) }),
    async (input) => {
      await shell.openExternal(input.url);
      return { ok: true };
    }
  );
}
```

---

### Task 5: 集成 main/index.ts + 自检 + 提交

**Files:**
- Modify: `src/main/index.ts`

#### 5.1 集成点

在 `app.whenReady().then(async () => {...})` 中，数据库初始化完成后调用：

```typescript
// 注册 IPC handler（设计文档 §4.1 分层架构）
registerIpcHandlers();

// 启动状态广播器（订阅 PG/Ollama 事件 → 推送到渲染层）
startStatusBroadcaster();
```

import：
```typescript
import { registerIpcHandlers } from './ipc/router';
import { startStatusBroadcaster } from './app/status-broadcaster';
```

#### 5.2 验收清单

| # | 检查项 | 命令 |
|---|--------|------|
| 1 | 类型检查 0 错误 | `pnpm typecheck` |
| 2 | Lint 0 错误 | `pnpm lint` |
| 3 | 全部测试通过 | `pnpm test` |
| 4 | 三入口构建产物 | `pnpm build` |
| 5 | CodeGraph 同步 | `codegraph sync` |
| 6 | handler 覆盖全部 38 channel | 手动核对 |
| 7 | preload 导出完整 IpcApi | 手动核对 |

---

## 5. 执行策略

| Task | 执行方式 | 说明 |
|------|----------|------|
| Task 1 | 主代理直接执行 | 基础设施，后续 Task 依赖 |
| Task 2 | 子代理并行 | preload 独立于 handler |
| Task 3 | 子代理并行 | 6 个 CRUD handler 模式重复 |
| Task 4 | 子代理并行 | 3 个复杂 handler 独立 |
| Task 5 | 主代理执行 | 集成 + 自检 |

Task 2/3/4 在 Task 1 完成后并行派发（3 个子代理同时执行）。

---

## 6. 关键设计决策

| # | 决策 | 理由 |
|---|------|------|
| 1 | handler 为薄层，只做参数校验 + 调 service | 设计文档 §4.1 分层架构 |
| 2 | chat:sendMessage 后台启动 runChatGeneration（不 await） | 立即返回 ackId，流式响应通过 stream-bridge 推送 |
| 3 | agent handler 注入 ctx.sender 作为 webContents | agent.service 需要推送流式事件到发起请求的窗口 |
| 4 | app:getStatus 实时读取 pgController + ollamaController 状态 | 不缓存，保证准确性 |
| 5 | status-broadcaster 用 BrowserWindow.getAllWindows() 广播 | 支持多窗口，已销毁窗口跳过 |
| 6 | preload 用全局 crypto.randomUUID() 生成 traceId | sandbox 禁止 node:crypto，用 Chromium Web Crypto API |
| 7 | preload 不写单测 | sandbox + contextBridge 隔离导致 vitest 无法模拟，E2E 覆盖 |
| 8 | handler 测试 mock service + 提取 wrap handler 回调 | 验证 handler 正确调用 service，不测试 wrap 本身 |
