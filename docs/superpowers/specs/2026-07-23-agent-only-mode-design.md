# Agent-Only 模式设计 v1.0

> **状态**: 设计完成,待实现
> **范围**: 完整版(含会话级 workingDir 持久化 + 最近目录列表)
> **预估工作量**: 约 290 行改动(含测试代码可能略多)
> **日期**: 2026-07-23

## 1. 背景与目标

### 1.1 问题陈述

当前应用存在两套对话模式:

- **Chat 模式**(走 `chat:send` IPC):单轮文本问答,无工具调用能力
- **Agent 模式**(走 `agent:run` IPC):多轮工具调用,能读写文件/跑命令

两套模式并行存在,但实际场景下用户需要的是"按需调用工具的对话" — 即 Agent 模式。Chat 模式的存在是历史遗留,其能力被 Agent 模式完全覆盖。

当前 Agent 模式的后端能力已全部实现(`AgentService` / `IpcAgentTransport` / `useAgentWithIpc` / `ToolRegistry` / `PermissionService`),但渲染层缺少入口,用户无法从 UI 触发 Agent 对话。

### 1.2 设计目标

1. **砍掉 Chat 模式** — 应用只保留 Agent 一种对话模式(按需调用工具)
2. **提供 Agent 入口** — 用户能从 UI 开始一个新的 Agent 会话
3. **会话级 workingDir** — 每个 Agent 会话绑定自己的项目工作目录,支持多项目并行
4. **最小化改动** — 复用现有 ChatMessageList / ChatInput / ApprovalDialog / ToolPanel 等组件,不重构架构

### 1.3 非目标

- 不做 inline ToolCard / ApprovalCard(原型愿景,v2 迭代)
- 不做 Sidebar folder 分组(原型愿景,v2 迭代)
- 不做 Aurora 样式美化(纯 CSS 工作,后续单独迭代)
- 不删 Chat 域代码(保留作为死代码,后续单独 PR 清理)
- 不做会话 fork / resume 历史(参考项目的完整能力,v2 迭代)

## 2. 需求验证

### 2.1 已验证的现状

| 验证项 | 结论 | 依据 |
|--------|------|------|
| ChatMessageList 能否渲染 agent 消息 | **能** | `PartView` 已支持 `isStaticToolUIPart` / `isDynamicToolUIPart` / `isReasoningUIPart` / `step-start`,工具调用已 inline 渲染(`ToolCallView`) |
| sessionId 修复工作量 | **一行** | 主进程 `agent.handler.ts:71` 已透传 `input.sessionId`,渲染层 `ipc-agent-transport.ts:174` 传 `undefined` 是 bug |
| chat:send IPC 是否还有依赖 | **无** | 仅 `ChatPanel.tsx` 通过 `useChatWithIpc` 间接调用,无摘要/标题生成等内部消费 |
| sessions 表能否复用 | **能** | `schema.ts:25` 注释明确:"一个会话对应一次 agent:run(或 chat:send)的完整对话历史" |
| workingDir 是否必填 | **必填** | `agent-service.ts:64` + `tool.ts:35` 均为非可选;所有工具靠 `resolveWithinWorkspace` 校验路径 |
| 软件工作目录(userData)现状 | **由 Electron `app.getPath('userData')` 管理** | dev:`.electron-user-data/sessions.db`;prod:`%APPDATA%/novel-writer-agent/sessions.db` |
| sessions 表是否有 workingDir 字段 | **无** | `db.ts:95-102` schema 仅 id/title/created_at/updated_at/last_message/message_count |
| 渲染层是否有 createSession IPC | **无** | `use-sessions.ts` 仅 list/get/delete/rename;`session-service.ts` 的 `create` 是内部 API,未暴露 IPC |
| 是否有目录选择器 IPC | **无** | 主进程仅有 `dialog.showErrorBox`;preload 未暴露任何 `pickDirectory` 类 API |

### 2.2 关键决策

| 决策 | 选择 | 理由 |
|------|------|------|
| workingDir 存储层级 | **会话级**(存 sessions 表) | 用户需求"支持多项目",每个会话绑定独立 workingDir |
| workingDir 选择 UX | **首次弹原生对话框,有历史显示最近目录列表** | 用户指定方案 |
| Chat 域代码处置 | **保留不动**(死代码) | 删除涉及 ServiceContainer / IPC / preload / 测试,改动面大,不影响功能 |
| 会话列表 UI | **复用现有 Sidebar** | 会话表结构兼容,只需在会话项加 workingDir 副标题 |
| 工具卡片渲染 | **复用 ChatMessageList 内联 ToolCallView** | 已支持,无需改造 |

## 3. 架构设计

### 3.1 数据流

```
用户点击"新对话"
  → 查询最近目录列表(session:listRecentDirs)
  → 有历史?
     ├─ 是 → 显示目录列表 + "浏览其他..."按钮
     │       ├─ 选历史目录 → createSession({ workingDir }) → 跳 /chat/:id
     │       └─ 点"浏览其他" → dialog.pickDirectory() → createSession → 跳 /chat/:id
     └─ 否 → dialog.pickDirectory() → createSession → 跳 /chat/:id

用户在 /chat/:sessionId 页
  → useSessionsQuery 拉取 session.workingDir
  → ChatPanel 接收 workingDir prop
  → useAgentWithIpc({ id: sessionId, workingDir })
  → IpcAgentTransport.configure({ workingDir })
  → useChat.sendMessage
  → transport.sendMessages(传 chatId 作为 sessionId)  ← bug 修复
  → window.api.agent.run({ sessionId: chatId, workingDir, ... })
  → 主进程 agentService.startAgent
  → 流式 parts 推回 → useChat.messages 更新
  → ChatMessageList 渲染(text/reasoning/tool-call/step-start)
```

### 3.2 数据模型变更

#### sessions 表新增字段

```sql
-- 新建库:建表时包含
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  working_dir TEXT NOT NULL,  -- 新增:会话级项目工作目录(绝对路径)
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_message TEXT,
  message_count INTEGER NOT NULL DEFAULT 0
);

-- 已存在库:幂等加列(ALTER TABLE 兼容旧数据)
ALTER TABLE sessions ADD COLUMN working_dir TEXT NOT NULL DEFAULT '';
```

**设计说明**:
- `working_dir` 设为 `NOT NULL` — 业务上必填,空字符串表示异常(由 zod 校验拦截)
- ALTER 用 `DEFAULT ''` 兼容旧数据(旧会话没有 workingDir,但也不会被加载到 agent 模式,因为旧 chat 会话的 messages 反序列化后可能不兼容 agent 工具调用 parts)
- 不做数据迁移(旧 chat 会话作为只读历史保留,用户可手动删除)

#### 最近目录列表查询

```sql
SELECT DISTINCT working_dir, MAX(updated_at) as last_used
FROM sessions
WHERE working_dir != ''
GROUP BY working_dir
ORDER BY last_used DESC
LIMIT 10;
```

**设计说明**:
- 按 `working_dir` 去重,取最近使用时间
- 限制 10 条避免列表过长
- 空字符串过滤(旧数据兼容)

### 3.3 IPC 通道变更

#### 新增 IPC

| Channel | 方向 | 入参 | 返回 | 说明 |
|---------|------|------|------|------|
| `session:create` | invoke | `{ workingDir: string, title?: string }` | `{ sessionId: string }` | 创建空会话(绑定 workingDir) |
| `session:listRecentDirs` | invoke | `{ limit?: number }` | `{ dirs: Array<{ workingDir: string, lastUsed: number }> }` | 查询最近使用的目录 |
| `dialog:pickDirectory` | invoke | `{}` | `{ canceled: boolean, path?: string }` | 弹原生目录选择器 |

#### 修改 IPC

无。现有 `agent:run` / `agent:stop` / `session:list` / `session:get` / `session:delete` / `session:rename` 协议不变。

`session:list` / `session:get` 返回的 `SessionMeta` 会自然带上 `workingDir` 字段(schema 加字段后 drizzle 自动返回),渲染层无需改 IPC 调用。

### 3.4 渲染层组件变更

#### 3.4.1 新建文件

| 文件 | 职责 | 行数 |
|------|------|------|
| `src/renderer/components/chat/NewSessionDialog.tsx` | "新对话"对话框:最近目录列表 + "浏览其他"按钮 | ~80 |
| `src/main/ipc/dialog.handler.ts` | 目录选择器 IPC handler(注册 `dialog:pickDirectory`) | ~30 |

#### 3.4.2 修改文件

| 文件 | 改动 | 行数 |
|------|------|------|
| [schema.ts](file:///f:/TraeProjects/1/src/main/infra/storage/schema.ts) | sessions 加 `workingDir` 字段(drizzle 定义) | ~5 |
| [db.ts:94-127](file:///f:/TraeProjects/1/src/main/infra/storage/db.ts) | 建表 SQL 加列 + ALTER TABLE 兜底 | ~15 |
| [session-service.ts](file:///f:/TraeProjects/1/src/main/infra/storage/session-service.ts) | `SessionCreateOptions` 加 workingDir;`create` 写入;`rowToMeta` 透传;新增 `listRecentDirs` 方法;`ISessionService` 暴露 create + listRecentDirs | ~50 |
| [packages/shared/src/schemas/session.ts](file:///f:/TraeProjects/1/packages/shared/src/schemas/session.ts) | `SessionMetaSchema` 加 `workingDir` 字段;新增 `SessionCreateReqSchema/ResSchema` + `SessionListRecentDirsReqSchema/ResSchema` | ~30 |
| [packages/shared/src/ipc/channels.ts](file:///f:/TraeProjects/1/packages/shared/src/ipc/channels.ts) | 新增 `DIALOG` 域;加 `SESSION_CREATE` / `SESSION_LIST_RECENT_DIRS` / `DIALOG_PICK_DIRECTORY` 三个 channel 常量 | ~8 |
| [packages/shared/src/ipc/api.ts](file:///f:/TraeProjects/1/packages/shared/src/ipc/api.ts) | `SessionApi` 加 `create` / `listRecentDirs` 方法签名;新增 `DialogApi` 接口 | ~15 |
| [preload/index.ts](file:///f:/TraeProjects/1/src/preload/index.ts) | 暴露 `session.create` / `session.listRecentDirs` / `dialog.pickDirectory` | ~20 |
| [session.handler.ts](file:///f:/TraeProjects/1/src/main/ipc/session.handler.ts) | 扩展现有 handler,新增 `session:create` + `session:listRecentDirs` 两个 channel 注册(沿用现有 DI 模式) | ~25 |
| [use-sessions.ts](file:///f:/TraeProjects/1/src/renderer/hooks/use-sessions.ts) | 新增 `useCreateSession` mutation + `useRecentDirs` query | ~50 |
| [home.tsx](file:///f:/TraeProjects/1/src/renderer/routes/home.tsx) | 改造:渲染 `<NewSessionDialog>` | ~20 |
| [chat.tsx](file:///f:/TraeProjects/1/src/renderer/routes/chat.tsx) | 从 `session.workingDir` 注入 `useAgentWithIpc` | ~15 |
| [ChatPanel.tsx](file:///f:/TraeProjects/1/src/renderer/components/chat/ChatPanel.tsx) | 改用 `useAgentWithIpc` + 加 `workingDir` prop + 移除 ToolPanel(已 inline) | ~10 |
| [Sidebar.tsx:229-234](file:///f:/TraeProjects/1/src/renderer/components/layout/Sidebar.tsx#L229) | 会话项显示 workingDir 副标题 | ~5 |
| [ipc-agent-transport.ts:174](file:///f:/TraeProjects/1/src/renderer/lib/agent/ipc-agent-transport.ts#L174) | `sessionId: undefined` → `sessionId: options.chatId` | 1 |
| [main/index.ts](file:///f:/TraeProjects/1/src/main/index.ts) | 注册 `dialog.handler.ts` 新 handler(session.handler 已在注册列表内,扩展即可) | ~3 |

**总计**:约 290 行(实际可能因测试代码增加而略多)

## 4. 组件设计

### 4.1 NewSessionDialog

**位置**: `src/renderer/components/chat/NewSessionDialog.tsx`

**职责**:
- 打开时查询最近目录列表
- 有历史:展示目录列表(每项显示路径 + 最后使用时间)
- 无历史:直接触发目录选择器
- 点击历史项 → 调 `useCreateSession({ workingDir })` → 跳转 `/chat/:id`
- 点击"浏览其他" → `dialog.pickDirectory()` → 选中后 `useCreateSession` → 跳转

**接口**:
```tsx
interface NewSessionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}
```

**行为**:
1. `open=true` 时挂载,查询 `useRecentDirs()`
2. 如果 `dirs.length === 0`,自动调用 `dialog.pickDirectory()`(跳过列表展示)
3. 用户选择目录后,`useCreateSession({ workingDir: path })`:
   - 成功 → `navigate(ROUTES.chatPath(sessionId))` + `setActiveSession(sessionId)`
   - 失败 → toast 错误,留在对话框
4. 成功后 `onOpenChange(false)` 关闭
5. **用户取消目录选择**(包括自动触发与点击"浏览其他"两种场景):`pickDirectory` 返回 `canceled=true`,NewSessionDialog 保持打开 — 此时若 `dirs.length === 0`(首次启动即取消),显示空状态提示"请选择一个项目目录开始",并保留"浏览其他"按钮供重试;若 `dirs.length > 0`,回到列表展示让用户从历史中选择

### 4.2 ChatPanel 改造

**改动**:
- 第32行: `import { useChatWithIpc }` → `import { useAgentWithIpc }`
- 第97行: `useChatWithIpc({ id, ... })` → `useAgentWithIpc({ id, workingDir, ... })`
- props 加 `workingDir: string`(必填)
- 移除底部 `<ToolPanel sessionId={chatId} />`(工具调用已 inline 渲染在 ChatMessageList)

**保留不变**:
- 三段式布局(header / ChatMessageList / ChatInput)
- `onError` 错误处理逻辑
- `onFinish` 回调透传

### 4.3 Sidebar 会话项

**改动**:
- 在会话项标题下方加一行 `workingDir` 副标题(显示路径 basename + tooltip 完整路径)
- 例:`f:\TraeProjects\1` → 显示 `1`,hover 显示完整路径

## 5. 错误处理

### 5.1 目录选择失败

- 用户取消选择 → `dialog.pickDirectory` 返回 `{ canceled: true, path: undefined }` → NewSessionDialog 保持打开,不报错
- 用户选择无权限目录 → `createSession` 时由 zod 校验非空字符串通过;实际工具执行时由 `resolveWithinWorkspace`(`src/main/infra/ai/tools/path-guard.ts`)抛 `UNAUTHORIZED` 错误 → toast 提示,留在对话框

### 5.2 createSession 失败

- 网络错误 / DB 错误 → `useCreateSession` 的 `onError` → toast 提示 `[CODE] message`
- 用户可重试

### 5.3 会话 workingDir 为空

- 不应发生(`SessionCreateReqSchema` 强制非空)
- 防御性:`chat.tsx` 中若 `session.workingDir` 为空,展示错误状态 UI("会话数据异常,请删除后重建")

## 6. 测试策略

### 6.1 单元测试

按 **正向用例(happy path)/ 边界用例(boundary)/ 异常用例(exception)** 三维度组织。

#### 6.1.1 `session-service.ts` — create 方法

| 维度 | 用例 | 期望 |
|------|------|------|
| 正向 | 传入 `{ workingDir: 'f:\proj', messages: undefined, title: undefined }`(空会话) | sessions 行写入,`working_dir` 字段 = `'f:\proj'`,`messageCount` = 0,返回 sessionId(UUID) |
| 正向 | 传入 workingDir + 初始 messages 数组(2 条) | sessions 行 + 2 条 messages 行同时写入,workingDir 保留,title 取首条 user 消息前 50 字符 |
| 边界 | workingDir 为超长路径(如 260 字符 Windows MAX_PATH) | 正常写入(SQLite TEXT 无长度限制) |
| 边界 | workingDir 含中文 / 空格 / Unicode(如 `'D:\我的 项目'`) | 正常写入,`rowToMeta` 透传无乱码 |
| 异常 | DB 事务中途失败(模拟 `tx.insert(messages)` 抛错) | sessions 行未写入(事务回滚),create 抛错向上传播 |

#### 6.1.2 `session-service.ts` — listRecentDirs 方法

| 维度 | 用例 | 期望 |
|------|------|------|
| 正向 | 3 个不同 workingDir 的会话(updatedAt 递增) | 返回 3 条,按 lastUsed 倒序 |
| 边界 | 多个会话共享同一 workingDir(5 条,updatedAt 不同) | 去重返回 1 条,`lastUsed` = MAX(updatedAt) |
| 边界 | 5 个不同 workingDir,`limit=2` | 返回 2 条(最近使用的) |
| 边界 | 含空字符串 workingDir 的旧 chat 会话(3 条) | 空字符串被 `WHERE working_dir != ''` 过滤,不返回 |
| 异常 | 无会话(空表) | 返回 `{ dirs: [] }`,不报错 |

#### 6.1.3 `session-service.ts` — rowToMeta 函数

| 维度 | 用例 | 期望 |
|------|------|------|
| 正向 | 正常 row(`workingDir` 非空字符串) | `SessionMeta.workingDir` 透传原值 |
| 边界 | 旧数据 row(`workingDir` 为空字符串 `''`) | `SessionMeta.workingDir` = `''`(不报错,由 `chat.tsx` 防御性检查处理) |
| 边界 | `lastMessage` 为 null | 转为 `undefined`(对齐 zod schema 推断类型) |

#### 6.1.4 `session.handler.ts` — session:create / session:listRecentDirs channel

| 维度 | 用例 | 期望 |
|------|------|------|
| 正向 | `{ workingDir: 'f:\proj' }` | 调 `sessionService.create`,返回 `{ sessionId }` |
| 边界 | `{ workingDir: 'f:\proj', title: '自定义标题' }` | title 透传到 create |
| 异常 | `{ workingDir: '' }`(空字符串) | `SessionCreateReqSchema` zod 校验失败,返回校验错误,不调 create |
| 异常 | `{ workingDir: '   ' }`(纯空格) | zod `.min(1)` 配合 `.trim()` 校验失败(由 schema 定义决定) |
| 异常 | 缺少 `workingDir` 字段 | zod 校验失败 |

#### 6.1.5 `dialog.handler.ts` — dialog:pickDirectory channel

| 维度 | 用例 | 期望 |
|------|------|------|
| 正向 | mock `dialog.showOpenDialog` 返回 `{ canceled: false, filePaths: ['D:\selected'] }` | 返回 `{ canceled: false, path: 'D:\selected' }` |
| 边界 | mock 返回多选(`filePaths: ['D:\a', 'D:\b']`,但 `properties` 未开 multiSelections) | 取 `filePaths[0]`(第一项) |
| 异常 | mock 返回 `{ canceled: true, filePaths: [] }` | 返回 `{ canceled: true, path: undefined }` |
| 异常 | mock 返回 `{ canceled: false, filePaths: [] }`(理论不应发生) | 兜底返回 `{ canceled: true, path: undefined }` |
| 异常 | mock `dialog.showOpenDialog` 抛错 | 错误向上传播(由 `wrap` 统一捕获) |

#### 6.1.6 `NewSessionDialog.tsx`

| 维度 | 用例 | 期望 |
|------|------|------|
| 正向 | `dirs.length = 3`,挂载后渲染 3 项(每项显示路径 basename + lastUsed 相对时间) | 列表可见,顺序与 query 返回一致 |
| 正向 | 点击历史目录项 | 触发 `useCreateSession({ workingDir })` → 成功后 `navigate(chatPath)` + `setActiveSession` + `onOpenChange(false)` |
| 正向 | 点击"浏览其他" → `pickDirectory` 返回选中路径 | 触发 createSession → 跳转 + 关闭对话框 |
| 边界 | `dirs.length === 0`(首次使用) | 自动触发 `dialog.pickDirectory()`,不渲染列表 |
| 边界 | `dirs.length === 10`(limit 上限) | 渲染 10 项,不截断 |
| 异常 | 自动触发 pickDirectory 后用户取消(`dirs.length === 0`) | 显示空状态提示"请选择一个项目目录开始" + "浏览其他"按钮,对话框保持打开 |
| 异常 | 有历史时点击"浏览其他"后取消 | 回到列表展示,不关闭对话框 |
| 异常 | `useCreateSession` 失败(`onError`) | toast 显示 `[CODE] message`,对话框保持打开,允许重试 |
| 异常 | `useRecentDirs` query 加载中 | 显示 loading skeleton,不触发自动 pickDirectory(避免 loading 时误弹) |

#### 6.1.7 `ChatPanel.tsx`(改用 useAgentWithIpc 后)

| 维度 | 用例 | 期望 |
|------|------|------|
| 正向 | `workingDir` + `id` 注入,`messages` 数组透传 | `ChatMessageList` 收到完整 messages,text/reasoning/tool-call/step-start 正常渲染 |
| 正向 | `sendMessage('读取 package.json')` | 触发 `transport.sendMessages`,**验证传入的 chatId === sessionId**(bug 修复回归) |
| 边界 | `workingDir` prop 变化(切换会话) | `IpcAgentTransport.configure({ workingDir })` 被重新调用 |
| 边界 | `messages` 为空数组(新会话首次渲染) | ChatMessageList 渲染空状态,不报错 |
| 异常 | `agent:run` 流式异常 | `onError` 触发,UI 显示错误状态,不白屏 |
| 异常 | ToolPanel 已移除,验证旧 `<ToolPanel>` 引用不残留 | 渲染树中无 ToolPanel 节点 |

### 6.2 集成测试

| 测试点 | 验证 |
|--------|------|
| 完整新会话流程 | 点击新对话 → 选目录 → createSession → 跳转 → useAgentWithIpc 收到 workingDir |
| 历史目录列表 | 创建多个会话后,新对话对话框显示去重后的目录列表 |
| 多项目切换 | 在 session A(workingDir=/proj1)和 session B(workingDir=/proj2)间切换,验证 transport.configure 被正确调用 |

### 6.3 现有测试

- 现有 294 个测试应继续通过
- `chat-service.ts` 相关测试保留(死代码保留,测试不删)
- `agent-service.test.ts` 现有测试继续通过(workingDir 字段已是必填)

## 7. 迁移与兼容

### 7.1 数据库迁移

- **新安装**:`initDb` 建表时直接包含 `working_dir` 列
- **已有数据库**:`ALTER TABLE sessions ADD COLUMN working_dir TEXT NOT NULL DEFAULT ''` 幂等执行
- **迁移策略**:`initDb` 中先 `CREATE TABLE IF NOT EXISTS`(新库),再 `ALTER TABLE ... ADD COLUMN`(老库加列),两者都 IF NOT EXISTS 语义幂等

### 7.2 旧会话数据

- 旧 chat 会话 `working_dir` 为空字符串 `''`
- 用户能从 sidebar 看到旧会话(但点击会话项后,`chat.tsx` 会检测 `workingDir` 为空,展示"会话数据异常"提示)
- 用户可手动删除旧会话

## 8. 实施顺序

建议按依赖顺序实施,每步可独立验证:

1. **shared schema** — 加 IPC channel 常量(`packages/shared/src/ipc/channels.ts`)+ 请求/响应 schema + SessionMeta 字段(`packages/shared/src/schemas/session.ts`)+ API 接口签名(`packages/shared/src/ipc/api.ts`)
2. **storage 层** — schema.ts + db.ts + session-service.ts
3. **IPC handler** — 扩展 `session.handler.ts`(新增 create + listRecentDirs)+ 新建 `dialog.handler.ts` + `main/index.ts` 注册新 handler
4. **preload** — 暴露新 IPC API
5. **渲染层 hooks** — use-sessions.ts 加 useCreateSession + useRecentDirs
6. **渲染层组件** — NewSessionDialog + ChatPanel 改造 + Sidebar 改造 + home.tsx + chat.tsx
7. **bug 修复** — ipc-agent-transport.ts:174
8. **测试** — 单元 + 集成

## 9. 风险与缓解

| 风险 | 影响 | 缓解 |
|------|------|------|
| ALTER TABLE 失败(已存在同名列) | 应用启动崩溃 | 用 try-catch 包裹 ALTER,捕获 "duplicate column name" 错误时忽略 |
| 旧会话 workingDir 为空导致 chat.tsx 崩溃 | 用户点击旧会话白屏 | chat.tsx 加防御性检查,空 workingDir 显示错误状态 UI |
| ChatPanel 移除 ToolPanel 后,正在 pending 的工具调用丢失视觉反馈 | 用户看不到工具执行进度 | ChatMessageList 的 ToolCallView 已覆盖(tool-call part 的 state='input' 时显示执行中) |
| 目录选择器在 Linux 某些桌面环境异常 | 无法选目录 | dialog.showOpenDialog 是 Electron 跨平台 API,已在 Windows/macOS 验证;Linux 非第一版目标平台 |

## 10. 验收标准

### 10.1 功能验收

- [ ] 点击"新对话" → 弹出目录选择器或最近目录列表
- [ ] 选择目录后创建新会话并跳转到 `/chat/:sessionId`
- [ ] 新会话能发送消息并收到 agent 流式响应(含工具调用)
- [ ] 工具调用以 inline 卡片形式渲染在消息流中
- [ ] 工具调用审批通过 ApprovalDialog 全局弹窗完成
- [ ] 切换不同会话时,workingDir 正确隔离(不同会话操作不同项目目录)
- [ ] sidebar 会话项显示 workingDir 副标题
- [ ] 创建过多个会话后,"新对话"显示去重的最近目录列表
- [ ] 旧 chat 会话(workingDir 为空)点击后显示"会话数据异常"提示,不崩溃
- [ ] 应用重启后,历史会话列表保留,workingDir 字段正确恢复

### 10.2 质量验收

- [ ] `pnpm typecheck` 0 错误
- [ ] `pnpm lint` 0 错误
- [ ] `pnpm test` 全部通过(含新增测试)
- [ ] 新增测试覆盖:create 写入 workingDir / listRecentDirs 去重排序 / NewSessionDialog 空历史自动选择器分支 / ChatPanel 改用 useAgentWithIpc 后透传正确

## 11. 后续迭代(v2+)

以下能力**不在本次范围**,作为后续迭代:

| 能力 | 参考 | 说明 |
|------|------|------|
| inline ApprovalCard | 原型 | 审批卡片 inline 在消息流(替代全局 ApprovalDialog) |
| inline ToolCard 美化 | 原型 | 工具卡片 Aurora 发光样式 |
| Sidebar folder 分组 | 原型 | 按 workingDir 分组显示会话 |
| 会话 fork / resume | gemini-cli | `$rewindTo` 回退 / 子会话嵌套 |
| 会话蒸馏 | cognee | 长对话压缩摘要 |
| Chat 域代码清理 | — | 删除 chat-service / chat.handler / use-chat / ipc-chat-transport |
| 多窗口支持 | VS Code | 不同窗口不同项目 |
