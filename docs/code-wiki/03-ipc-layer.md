# 03 · IPC 通信层与类型契约

> 覆盖：`packages/shared` 契约单一真源、channel 命名、preload 桥、handler 注册器、wrap 中间件、错误协议。

## 1. 设计哲学：类型契约单一真源

`packages/shared/src/ipc/` 是 IPC 的**唯一真相**，任何新增域/方法都必须改这里，三端（main/preload/renderer）自动同步。

数据来源链（依赖方向）：

```
meta.ts（纯字符串 channel+kind，零 zod，preload 沙箱安全）
   ↓  withSchema / withPayload 合并
definitions.ts（+ 入参 zod schema + res 响应契约）          ← 完整单一真源
   ↓  TS 类型推导（derive.ts：InferIpcApi / InferRequestMap / InferEventMap）
payloads.ts / api.ts（IpcRequestMap / IpcEventMap / IpcApi）
   ↓  preload 返回类型断言 IpcApi + renderer 类型 import
channels.ts（IPC_CHANNELS 常量由 deriveChannels(meta) 生成，as const 字面量）
```

**双向 parity 编译期检查**（`definitions.ts` 底部）：`type _MissingMethods` 保证 `meta ⊆ definitions ⊆ meta`，任何一侧多写会编译失败。`api.ts` / `channels.ts` 均**不再手写**——由定义表推导，新增方法零改动自动同步。

## 2. channel 命名约定

| 模式 | 语义 | 例子 |
|---|---|---|
| `{domain}:{action}` | 请求-响应（`ipcRenderer.invoke`） | `agent:run`、`session:list`、`file:read` |
| `{domain}:stream:{event}` | 流式事件（主进程 `send`） | `agent:stream:part`、`chat:stream:end`、`agent:stream:error` |
| `{domain}:event:{name}` | 状态事件推送 | `file:event:watch`、`terminal:event:output` |

域清单（`IPC_META` / `registerIpcHandlers` 中，2026-09-30 实测 28 个）：
`app / window / backup / agent / session / file / search / browser / terminal / git / tool / settings / proxy / system / models / memory / task / skill / whitelist / goal / im / remote / logs / devtools / dialog / mcp / invalidation / update`。
共 115 个 request 通道 + 19 个 event 通道；方法数以 meta.ts 为唯一真源。

## 3. Preload 桥（`src/preload/`）

- `index.ts`：`createIpcApi(IPC_META)` 自动生成 `window.api`，`contextBridge.exposeInMainWorld('api', api)`。
- `utils/create-api.ts`：遍历定义表，`request` → `ipcRenderer.invoke`（经 ipc-bridge 注入 traceId）；`event` → `subscribe` 返回 unsubscribe 函数（防泄漏）。返回值断言为 `IpcApi`——形状由 definitions.ts 的类型推导保证（type-only 导入，编译期移除，不触发运行时求值）。
- **导入策略**：通过子路径 `@code-agent/shared/ipc/meta` 纯字符串导入，避免把 zod（纯 ESM）拖进 preload CJS 构建；`sandbox:true` 下 preload 必须是 CJS（`.cjs`）。

## 4. Handler 注册器（`src/main/ipc/register.ts`）

- `registerIpcHandlers(handlers)` 遍历 `IPC_DEFINITIONS` 的 request 方法，逐个 `wrap(channel, schema, handler, resSchema)`。
- handlers 对象形状受 `InferHandlers<typeof IPC_DEFINITIONS, IpcHandlerContext>` 约束：**缺任一方法 → 编译期报错**。
- 运行时兜底（启动期注册循环内，P2 加固）：`handler === undefined` 抛错（防 `as any` 绕过）；**`resSchema` 缺失同样启动即抛错**（响应契约必填——此前实质可选，新方法漏配会让「响应防漂移」静默失效）。
- 事件方法无需注册（主进程 `webContents.send` 主动推送）。

## 5. wrap 中间件（`src/main/utils/wrap.ts`）

每个 IPC request 都经过统一 wrap，职责：
- **sender 校验**：校验 `event.sender` 合法来源（P2 加固：来源 URL 白名单，防跨窗口越权）。
- **traceId 贯穿**：从 `ctx` 读取或生成 traceId（形状校验：8-64 位字母数字/连字符/下划线），随事件带出（可追踪性）。
- **zod 入参校验**（`def.schema`）+ **响应契约校验**（`resSchema` 存在时校验 handler 返回，防手写 Res 接口漂移）。
- **错误分类**：把异常映射为 `AppError` / 错误码（见 §6）。
- **错误上报**：经 error-report 单一出口落本地结构化日志（fire-and-forget，不阻塞响应；2026-09-13 移除 Sentry）。

`IpcHandlerContext` 提供给 handler 统一的 `{ event, traceId, ... }` 运行上下文。

## 6. 错误协议（`packages/shared/src/constants/`）

- `errors.ts`：`ErrorCode` 枚举、`AppError` 类（含 `code` / `details` / `cause`），`AppError.from()`。
- `protocol.ts`：协议版本常量、`IpcResponse<T>` 统一封装（`{ ok: true, data } | { ok: false, error }`）。

`ErrorCodes` 按域分组（如 `API_KEY_MISSING`、`FILE_NOT_FOUND`、`AI_TIMEOUT`、`TOOL_PERMISSION_DENIED`、`SESSION_NOT_FOUND` 等），`useErrorMessage` hook（renderer）按 code 映射 i18n 文案，兜底 `ERROR_META.userMessage`。

## 7. 请求/响应 schema（`packages/shared/src/schemas/`）

按域拆分 zod schema，主进程 handler 用于校验入参、推导响应类型。清单（2026-09-30 实测 `packages/shared/src/schemas/`）：
`agent / agent-ask / agent-events / app / backup / browser / chat / codebase / devtools / dialog / file / git / goal / im / invalidation / mcp / memory / models / proxy / remote / search / session / settings / skill / system / task / terminal / thinking / tool / update / whitelist / window`。

## 8. 典型调用链（以 `agent:run` 为例）

```
renderer:  useAgentBridge → window.api.agent.run({ mode, sessionId, prompt })
  → preload: ipc-bridge.invoke('agent:run', input)   // 自动注入 traceId
  → main:   wrap(channel, schema, handler)             // zod 校验 + traceId + 错误分类
  → agent.handler.run → serviceContainer.getAgentService().startAgent()
  → 主进程持续 webContents.send('agent:stream:part' / 'agent:tool:call' ...)
  → preload: api.agent.subscribeStreamPart(cb) → 返回 unsubscribe
  → renderer: useAgentBridge 订阅 → Zustand store 更新 UI
```

## 9. 扩展：新增一个 IPC 域

1. `packages/shared/src/ipc/meta.ts` 加 `{ domain, method, channel, kind }`。
2. `packages/shared/src/ipc/definitions.ts` 用 `withSchema`/`withPayload` 合并 schema。
3. `src/main/ipc/{domain}.handler.ts` 新建并实现该域全部方法。
4. `src/main/index.ts` 的 `registerIpcHandlers` 注册该域。
5. `packages/shared/src/schemas/{domain}.ts` 定义 req/res/payload schema。
6. preload 与 renderer 类型自动同步（`satisfies IpcApi`）。

## 10. 关键文件

| 文件 | 职责 |
|---|---|
| [definitions.ts](file:///packages/shared/src/ipc/definitions.ts) | IPC 定义表（完整单一真源；底部 meta↔definitions parity 检查） |
| [meta.ts](file:///packages/shared/src/ipc/meta.ts) | 纯 channel 元数据（零 zod，preload 安全导入） |
| [derive.ts](file:///packages/shared/src/ipc/derive.ts) | 类型推导引擎（InferIpcApi / InferRequestMap / InferEventMap / deriveChannels） |
| [api.ts](file:///packages/shared/src/ipc/api.ts) | `IpcApi` 接口（由定义表推导，不手写） |
| [payloads.ts](file:///packages/shared/src/ipc/payloads.ts) | 请求/响应/事件 payload 类型映射 |
| [channels.ts](file:///packages/shared/src/ipc/channels.ts) | channel 常量（deriveChannels(meta) 生成，as const） |
| [response.ts](file:///packages/shared/src/ipc/response.ts) | `IpcResponse<T>` 统一响应封装 |
| [register.ts](file:///src/main/ipc/register.ts) | 定义表驱动 handler 注册（缺 handler/缺 resSchema 启动即抛错） |
| [wrap.ts](file:///src/main/utils/wrap.ts) | sender 校验/traceId/schema/错误分类与上报（error-report）中间件 |
| [create-api.ts](file:///src/preload/utils/create-api.ts) | preload 自动生成 window.api（CJS 沙箱安全） |