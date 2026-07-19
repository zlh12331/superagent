# Phase 9: Phase 8 尾巴补全 + 集成测试基础设施

> **日期**：2026-07-19
> **状态**：待执行
> **前置**：Phase 8 完成（7 业务页面 + 8 领域 hooks + 4 通用组件），254 测试通过，typecheck/lint 0 errors
> **规模**：4 Task，预计 6 个 commit（含本计划）

---

## 1. 目标

补全 Phase 8 已识别的尾巴功能，并按设计文档 §8.3 搭建集成测试基础设施：

1. **删除对话会话全链路**：补 `chat:deleteSession` channel（shared schemas → IPC payloads → service → handler → preload → renderer hook → UI 接入）
2. **RAG PDF 解析**：主进程引入 `pdf-parse` 库，扩展 `rag.service.ingestDocument` 支持 PDF 文件
3. **集成测试基础设施**：Testcontainers + `pgvector/pgvector:pg17` 镜像 + Vitest projects 配置（区分 unit / integration）
4. **关键 Service 集成测试用例**：`chat.service` 全链路（含级联删除）+ `rag.service` 全链路（含 HNSW 真实检索）

> **范围限定**：AGE 集成测试列入未来 Phase（AGE 官方 Docker 镜像与 PG 版本兼容矩阵复杂，本期不引入；character.service 的 AGE 部分继续依赖现有单测覆盖）。

---

## 2. 前置条件核实

| 依赖 | 状态 | 文件 |
|------|------|------|
| 38 IPC channel（IpcApi） | ✅ | packages/shared/src/ipc/api.ts |
| 9 个 service | ✅ | src/main/services/*.service.ts |
| Phase 8 7 业务页面 | ✅ | src/renderer/routes/*.tsx |
| Prisma migration（0_init） | ✅ | prisma/migrations/0_init/migration.sql |
| pgvector + HNSW 索引 | ✅ | src/main/infra/prisma/extensions/hnsw.ts |
| Vitest 4 配置（unit） | ✅ | src/main/vitest.config.ts |

### 2.1 缺口识别

| # | 缺口 | 影响 | 解决 |
|---|------|------|------|
| 1 | `chat:deleteSession` channel 缺失 | chat.tsx 删除按钮仅 toast 占位 | Task 1 补全 7 层改动 |
| 2 | RAG 仅支持 .md/.txt/.json | 用户上传 PDF 失败 | Task 2 主进程引入 pdf-parse + 扩展白名单 |
| 3 | 无集成测试环境 | Service + 真 PG 全链路未验证 | Task 3 搭建 Testcontainers + Vitest projects |
| 4 | 无集成测试用例 | 删除级联、HNSW 检索等关键流程未覆盖 | Task 4 编写 chat / rag 各 1 个集成测试套件 |

---

## 3. 文件结构

```
f:\TraeProjects\1\
├─ packages/shared/src/
│  ├─ ipc/
│  │  ├─ channels.ts                       [Task 1 新增 CHAT_DELETE_SESSION]
│  │  ├─ payloads.ts                        [Task 1 新增 chat:deleteSession]
│  │  └─ api.ts                             [Task 1 新增 chat.deleteSession]
│  └─ schemas/
│     └─ rag.ts                             [Task 2 校验 mimeType 含 application/pdf]
│
├─ src/main/
│  ├─ services/
│  │  ├─ chat.service.ts                    [Task 1 新增 deleteChatSession]
│  │  ├─ chat.service.test.ts               [Task 1 新增 deleteChatSession 单测]
│  │  ├─ rag.service.ts                     [Task 2 PDF 走解析器]
│  │  └─ rag.service.test.ts                [Task 2 新增 PDF 解析单测]
│  ├─ ipc/handlers/
│  │  └─ chat.handler.ts                    [Task 1 注册 chat:deleteSession]
│  ├─ infra/
│  │  └─ rag/
│  │     └─ pdf-parser.ts                   [Task 2 新增 PDF 解析模块]
│  └─ vitest.config.ts                      [Task 3 改造为 projects 区分 unit/integration]
│
├─ src/preload/
│  └─ index.ts                              [Task 1 chat.deleteSession 实现]
│
├─ src/renderer/
│  ├─ hooks/
│  │  └─ use-chat-sessions.ts               [Task 1 新增 useDeleteChatSession]
│  └─ components/rag/
│     └─ RagUploadDialog.tsx                [Task 2 扩展 .pdf 白名单]
│
├─ tests/
│  └─ integration/                          [Task 3/4 新增目录]
│     ├─ helpers/
│     │  ├─ pg-container.ts                 [Task 3 PG Testcontainer 启动/迁移/扩展]
│     │  └─ reset-db.ts                     [Task 3 测试间清表工具]
│     ├─ chat.service.integration.test.ts   [Task 4 删除会话级联 + 消息持久化]
│     └─ rag.service.integration.test.ts    [Task 4 PDF 入库 + HNSW 真实检索]
│
└─ package.json                             [Task 2/3 新增 pdf-parse + testcontainers 依赖]
```

---

## 4. Task 分解

### Task 1：删除会话功能全链路（7 层改动）

**目标**：用户点击删除按钮，主进程级联删除会话及其所有消息，渲染层刷新列表。

**改动清单**：

1. **`packages/shared/src/ipc/channels.ts`**
   - 新增 `CHAT_DELETE_SESSION: 'chat:deleteSession'`

2. **`packages/shared/src/ipc/payloads.ts`**
   - `IpcRequestMap` 新增 `'chat:deleteSession': { req: { id: string }; res: { id: string } }`

3. **`packages/shared/src/ipc/api.ts`**
   - `IpcApi.chat` 新增 `deleteSession: IpcInvokeMethod<'chat:deleteSession'>`

4. **`src/main/services/chat.service.ts`**
   - 新增 `deleteChatSession(id: string): Promise<{ id: string }>`
   - 校验会话存在 → `prisma.chatSession.delete({ where: { id } })`（依赖 schema 的 `onDelete: Cascade` 自动级联 `chatMessage`）
   - 不存在抛 `AppError(NOT_FOUND)`
   - 若会话有活跃 AI 流：先 `streamBridge.abort(id)` 再删除（避免删除后流仍在写消息）

5. **`src/main/services/chat.service.test.ts`**
   - 新增 `deleteChatSession` 测试组：成功删除、不存在抛 NOT_FOUND、有活跃流时先 abort

6. **`src/main/ipc/handlers/chat.handler.ts`**
   - 新增 `wrap(IPC_CHANNELS.CHAT_DELETE_SESSION, z.object({ id: z.string().min(1) }), (input) => deleteChatSession(input.id))`
   - 头部注释 channel 数量从 5 改为 6

7. **`src/preload/index.ts`**
   - `chat` 域新增 `deleteSession: (input) => invoke(IPC_CHANNELS.CHAT_DELETE_SESSION, input)`

8. **`src/renderer/hooks/use-chat-sessions.ts`**
   - 新增 `useDeleteChatSession` hook
   - 成功后 `qc.invalidateQueries({ queryKey: queryKeys.chatSessions.list(projectId) })`
   - 同时 `qc.removeQueries({ queryKey: queryKeys.chatMessages.list(deletedId) })` 清理消息缓存
   - 调用方需传 `projectId` 用于失效列表（hook 接收 `{ projectId: string }` 参数）

9. **`src/renderer/routes/chat.tsx`**
   - 替换 `handleDelete` 内的 `toast.info` 占位为真实 `deleteSessionAsync({ id, projectId })`
   - 删除成功后 `clearSession(deletedId)` 清理流式状态
   - 若删除的是当前 active session，由现有 `useEffect` 自动切换到第一个会话

**验收**：
- `pnpm typecheck` 0 errors
- `pnpm lint` 0 errors
- `pnpm test:main` 新增 3 个用例全通过
- `pnpm build` 三入口产物生成

---

### Task 2：RAG PDF 解析

**目标**：用户上传 PDF 文件时，主进程提取文本后走 `ingestDocument` 现有流程。

**改动清单**：

1. **`package.json`**
   - 新增 `pdf-parse` 依赖（轻量纯 JS，无原生编译，约 100KB）
   - 选型理由：`pdf-parse` 是 npm 上最流行的 PDF 文本提取库，无原生依赖（不像 `pdfjs-dist` 需要 DOM），适合 Node.js 主进程
   - 备选：`pdfjs-dist` 体积大且需要 canvas 环境，不适合 Electron 主进程

2. **`src/main/infra/rag/pdf-parser.ts`**（新文件）
   ```ts
   // PDF 文本提取模块
   // 设计文档 §5.1 场景 4（RAG 检索增强）
   //
   // 职责：
   // - 接收 Buffer，返回纯文本字符串
   // - 失败时抛 AppError(RAG_DOCUMENT_PARSE_FAILED)
   //
   // 注意：
   // - pdf-parse 的 default export 是函数，需用 require 或 interopDefault
   // - verbatimModuleSyntax: true 下需用 `import pdfParse from 'pdf-parse'` 配合 esModuleInterop
   ```

3. **`src/main/services/rag.service.ts`**
   - `ingestDocument` 新增 PDF 分支：
   ```ts
   // 1. 若 mimeType === 'application/pdf' 或文件名以 .pdf 结尾，先走 PDF 解析
   // 2. 解析得到的 text 替换 fileContent，后续流程不变
   // 3. 解析失败抛 AppError(RAG_DOCUMENT_PARSE_FAILED)
   ```
   - 不改变切片/嵌入/入库流程，仅在入口处做文本提取

4. **`src/main/services/rag.service.test.ts`**
   - 新增测试组：PDF 文件调 mock pdf-parser → 走 ingest 流程

5. **`src/main/infra/rag/pdf-parser.test.ts`**（新文件）
   - 用一个最小 PDF buffer（10 字节 stub）验证错误处理路径
   - 真实 PDF 文本提取依赖集成测试（Task 4）

6. **`packages/shared/src/constants/errors.ts`**
   - 新增 `RAG_DOCUMENT_PARSE_FAILED` 错误码（若不存在）
   - HTTP 400，用户提示"PDF 解析失败，请检查文件是否损坏"

7. **`src/renderer/components/rag/RagUploadDialog.tsx`**
   - `ALLOWED_EXTENSIONS` 新增 `.pdf`
   - `accept` 属性扩展 `.pdf`
   - DialogDescription 文案改为 "支持 Markdown / 文本 / JSON / PDF"

**验收**：
- 上传 PDF 文件后能切片 + 入库 + 检索
- 损坏 PDF 文件返回友好的 `RAG_DOCUMENT_PARSE_FAILED` 错误
- typecheck / lint / test 全通过

---

### Task 3：集成测试基础设施（Testcontainers + Vitest projects）

**目标**：搭建可重复运行的集成测试环境，使用真实 PG 17 + pgvector 容器。

**改动清单**：

1. **`package.json`**
   - 新增 devDependencies：
     - `@testcontainers/postgresql` ^11
     - `testcontainers` ^11
   - 新增 scripts：
     - `test:integration`: `vitest run --root tests/integration`
     - `test`: 调整为先跑 unit 再跑 integration（如果 Docker 可用）

2. **`src/main/vitest.config.ts`**
   - 改造为 `projects` 配置，区分 unit / integration：
   ```ts
   export default defineConfig({
     test: {
       projects: [
         {
           // 单元测试：mock Prisma，秒级
           test: {
             name: 'unit',
             include: ['**/*.test.ts'],
             exclude: ['tests/integration/**'],
           },
         },
         {
           // 集成测试：真实 PG，需要 Docker
           test: {
             name: 'integration',
             include: ['tests/integration/**/*.test.ts'],
             setupFiles: ['tests/integration/setup.ts'],
             testTimeout: 60_000, // 容器启动慢，放宽到 60s
           },
         },
       ],
     },
   });
   ```
   - 注意：Vitest 4 的 `projects` 配置取代旧 `include` 模式

3. **`tests/integration/helpers/pg-container.ts`**（新文件）
   - 使用 `@testcontainers/postgresql` 启动 `pgvector/pgvector:pg17` 镜像
   - 容器启动后：
     - 执行 `prisma/migrations/0_init/migration.sql`（含 CREATE EXTENSION pgvector + 建表）
     - 执行 HNSW 索引创建 SQL
   - 导出 `getTestPrismaClient()` 与 `stopTestContainer()` 函数
   - 全局共享 1 个容器（`beforeAll` 启动，`afterAll` 关闭）以加速

4. **`tests/integration/helpers/reset-db.ts`**（新文件）
   - `resetDatabase()`：TRUNCATE 所有业务表（按外键依赖倒序）
   - 每个测试用例 `beforeEach` 调用，保证隔离

5. **`tests/integration/setup.ts`**（新文件）
   - 全局 setup：启动容器 + 设置环境变量（DATABASE_URL）+ 注入 getPrismaClient mock

**镜像选型**：
- `pgvector/pgvector:pg17`：官方 pgvector 镜像，基于 PG 17，已预装 pgvector 扩展
- 不使用 `apache/age` 镜像：AGE 与 PG 17 兼容性未确认，且 AGE 测试已在单测覆盖

**Docker 不可用兜底**：
- `pg-container.ts` 检测 `DOCKER_HOST` 或尝试连接，失败则 `console.warn` + `it.skip`
- CI 环境（GitHub Actions）默认有 Docker

**验收**：
- `pnpm test:integration` 能启动容器并完成空测试
- 容器在测试结束后被正确销毁
- 单元测试不受影响（`pnpm test:main` 仍走原配置）

---

### Task 4：编写集成测试用例

**目标**：覆盖关键业务流程，证明 Prisma migration + pgvector 扩展 + Service 层全链路可用。

**改动清单**：

1. **`tests/integration/chat.service.integration.test.ts`**
   - 测试场景：
     - 创建会话 → 发送消息 → 查询消息列表 → 删除会话（级联删除消息）→ 查询消息列表为空
     - 验证：Prisma schema 的 `onDelete: Cascade` 生效
     - 验证：删除后会话列表不再包含该 ID
   - 不依赖 AI 调用（`sendChatMessage` 只测持久化，不触发 `runChatGeneration`）

2. **`tests/integration/rag.service.integration.test.ts`**
   - 测试场景：
     - 入库 1 个 .md 文档（mock embedding.service 返回固定向量）→ 验证 chunksCount
     - 检索同向量 → 验证返回 score = 1.0（余弦距离 = 0）
     - 检索不同向量 → 验证 score < 1.0
     - 删除文档 → 验证 chunks 级联删除（`ragDocumentChunk` 表为空）
   - **embedding mock 策略**：集成测试不依赖真实 Ollama，通过 `vi.mock('./embedding.service')` 返回 2048 维单位向量
   - **HNSW 索引验证**：通过 `EXPLAIN ANALYZE` 查看是否使用 HNSW 索引（可选，若复杂可省略）

3. **`tests/integration/prisma-extensions.integration.test.ts`**（可选）
   - 验证 `pgvector` 扩展已加载（`SELECT extname FROM pg_extension`）
   - 验证 `halfvec` 类型可用（`CREATE TABLE t (v halfvec(3))`）
   - 验证 HNSW 索引存在（查询 `pg_indexes`）

**验收**：
- `pnpm test:integration` 全部通过（≥ 5 个用例）
- 集成测试运行时长 < 90s（含容器启动）
- 单元测试 254+ 用例仍全通过

---

## 5. 验收清单

执行以下命令逐项验证，**全部通过后方可认为 Phase 9 完成**：

```powershell
# 1. 类型检查
pnpm typecheck                                # 0 errors

# 2. Lint
pnpm lint                                     # 0 errors

# 3. 单元测试
pnpm test                                    # 含新增 chat/rag 单测
pnpm test:main                               # 254+ 用例通过

# 4. 集成测试（需 Docker Desktop 运行）
pnpm test:integration                        # 5+ 用例通过

# 5. 构建
pnpm build                                   # 三入口产物生成

# 6. CodeGraph 索引同步
codegraph sync                               # 更新代码图谱

# 7. 功能验证（手动）
pnpm dev                                     # 启动应用
# - 进入 AI 对话页 → 创建会话 → 删除会话（验证级联）
# - 进入 RAG 页 → 上传 PDF 文件 → 检索验证
```

---

## 6. 风险与缓解

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| Docker Desktop 未安装 | 中 | 集成测试无法运行 | setup.ts 检测并 skip，不阻塞 CI |
| pdf-parse 对中文 PDF 提取效果差 | 中 | 文本残缺影响 RAG 检索 | Task 4 集成测试用英文 PDF stub，中文场景留待用户实测反馈 |
| Testcontainers 启动慢（>30s） | 高 | 测试体验差 | 全局共享容器，单测与集成测试分离 |
| Prisma 7 与 PG 17 容器 query engine 不匹配 | 低 | migration 失败 | 已在 Phase 4a 验证 PG 18/17 兼容，Prisma 7 engine 自动适配 |
| `chat:deleteSession` 与活跃 AI 流冲突 | 中 | 删除后流仍尝试写消息 | service 层先 `streamBridge.abort` 再 delete |

---

## 7. 执行顺序

```
Task 1（删除会话，6 层 + 1 测试）  ──┐
                                      ├──> Task 3（集成测试基础设施）
Task 2（PDF 解析，含依赖安装）       ──┘                │
                                                       └──> Task 4（集成测试用例）
```

- Task 1 + Task 2 互相独立，可并行
- Task 3 依赖前两个 Task 的 service 改动完成
- Task 4 依赖 Task 3 的基础设施

---

## 8. Commit 规划

| # | Commit Message | Scope |
|---|----------------|-------|
| 1 | `chore: 添加 Phase 9 计划文档` | docs |
| 2 | `feat(ipc): 补全 chat:deleteSession 全链路` | shared, main, preload, renderer |
| 3 | `feat(rag): 新增 PDF 文档解析支持` | main, renderer |
| 4 | `test: 搭建 Testcontainers 集成测试基础设施` | main, tests |
| 5 | `test: 新增 chat/rag 集成测试用例` | tests |
| 6 | `chore: 同步 codegraph 索引` | - |

> 注：每个 Task 完成后立即 `codegraph sync` 并 git 提交。

---

**文档结束。等待执行。**
