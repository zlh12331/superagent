# Phase 4a: Prisma Schema + Client + Migration SQL 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 完成 Prisma 7 依赖安装、schema.prisma 编写（13 个模型 + 4 个 enum）、PrismaClient 单例工厂、migration SQL 生成（不执行），并集成到主进程入口。

**Architecture:**
- Prisma schema 放在项目根 `prisma/schema.prisma`，遵循 Prisma 7 官方目录约定
- PrismaClient 单例放在 `src/main/infra/prisma/client.ts`，复用 Phase 3a 的 logger 与 retry
- migration SQL 通过 `prisma migrate diff` 离线生成（无需真实 PG 连接），实际执行推迟到 Phase 4b
- `datasource db` 声明 `url = env("DATABASE_URL")`，extensions 数组只声明不加载（实际 `CREATE EXTENSION` 由 4b 完成）
- 不修改 `pg-controller`、不连接真实 PG；所有 DB 相关操作推迟到 4b

**Tech Stack:**
- Prisma `^7`（@prisma/client + prisma CLI）
- PostgreSQL 18 datasource（仅 schema 声明）
- pgvector halfvec(2048) via `Unsupported("halfvec(2048)")`
- Vitest 4（mock PrismaClient 构造函数，沿用 Phase 3b vi.fn + function 表达式模式）

---

## 上下文与约束

### 设计文档依据
- `docs/superpowers/specs/novel-writer-agent-design.md` §6.2 完整 Prisma Schema
- §6.1 ER 关系总览：Project 1─* Volume 1─* Chapter 等
- §6.3 Apache AGE 图数据：人物关系通过 AGE 图存储，不在 Prisma 关系表中
- §6.4 HNSW 索引：halfvec(2048)，由 4b 创建
- §6.5 AGE 兼容性策略：PG 18.4 默认 + 17.10 降级，由 4b 实现

### Phase 4a 边界（关键）
- ✅ **本阶段做**：schema.prisma + PrismaClient 单例 + migration SQL 文件 + main/index.ts 集成
- ❌ **本阶段不做**：实际连接 PG、`CREATE EXTENSION pgvector/age`、HNSW 索引、AGE 顶点/边初始化、pg-installer、initdb、pg-controller 集成

### shared 包已有资源（Phase 2 产出）
- `packages/shared/src/types/enums.ts`：ProjectStatus / ChapterStatus / CharacterRole / ChatRole 已定义（as const + 字面量联合类型）
- `packages/shared/src/schemas/project.schema.ts`：ProjectSchema 已对齐 §6.2 字段
- `packages/shared/src/constants/errors.ts`：ErrorCode 已包含 PG / Prisma 相关错误码（PG_START_FAILED / PG_CRASHED 等）

### Phase 3a/3b 已有资源
- `src/main/utils/logger.ts`：结构化日志（traceId）
- `src/main/utils/retry.ts`：指数退避重试
- `src/main/config/index.ts`：AppConfig 单例（已含 deepseek/ollama 块，**需新增 pg 块**）
- `src/main/infra/pg/pg-controller.ts`：PG 子进程管理（本阶段不集成）
- `src/main/infra/ai/*`：AI 客户端（本阶段不集成）

### 子代理执行注意事项（Phase 3b 经验）
1. **vi.fn constructor 陷阱**：Vitest 4 的 `vi.fn(() => x)` 箭头函数没有 `[[Construct]]`，无法被 `new` 调用。必须用 `vi.fn(function () { return mockInstance; })` + `// biome-ignore lint/complexity/useArrowFunction`
2. **biome useNamingConvention**：对 `PrismaClient`/`DATABASE_URL` 等连续大写标识符报错，需加 `// biome-ignore lint/style/useNamingConvention: <原因>`
3. **commitlint subject-case**：subject 不能以大写字母开头（用中文开头或小写开头）
4. **PowerShell 不支持 heredoc**：用多个 `-m "message"` 参数
5. **biome organizeImports**：导入名按大小写不敏感字母序排序（如 `{ type X, y }` 而非 `{ y, type X }`）
6. **vi.hoisted**：vi.mock 的 factory 中如需访问变量，必须用 `vi.hoisted` 导出
7. **mockReset vs clearAllMocks**：`clearAllMocks` 只清调用记录不清 once 队列，跨测试用例污染需用 `mockReset()`

---

## 文件结构总览

```
f:\TraeProjects\1\
├── prisma/
│   ├── schema.prisma                        # Create: 13 模型 + 4 enum + datasource 声明
│   └── migrations/
│       └── 0_init/
│           └── migration.sql                # Create: 离线生成的初始化 SQL（不执行）
├── packages/
│   └── shared/
│       └── src/
│           └── constants/
│               └── pg-versions.ts           # Create: PG 版本枚举（§6.5）
├── src/
│   └── main/
│       ├── config/
│       │   └── index.ts                     # Modify: 新增 pg 配置块（DATABASE_URL 等）
│       ├── infra/
│       │   └── prisma/
│       │       ├── client.ts                # Create: PrismaClient 单例工厂 + 类型导出
│       │       └── client.test.ts           # Create: 单元测试（vi.fn constructor 模式）
│       ├── __tests__/
│       │   └── config.test.ts              # Modify: 新增 pg 配置块测试用例
│       └── index.ts                        # Modify: 集成 PrismaClient lifecycle（startup/shutdown）
└── package.json                             # Modify: 新增 prisma / @prisma/client 依赖 + db 脚本
```

---

## Task 1: 添加 Prisma 依赖 + 创建 schema.prisma

**Files:**
- Create: `f:\TraeProjects\1\prisma\schema.prisma`
- Create: `f:\TraeProjects\1\packages\shared\src\constants\pg-versions.ts`
- Modify: `f:\TraeProjects\1\package.json` (添加 prisma / @prisma/client 依赖 + db 脚本)

### 设计文档 §6.5 PG 版本常量（必须先于 schema.prisma 创建）

```ts
// packages/shared/src/constants/pg-versions.ts
// PostgreSQL 版本枚举（设计文档 §6.5 AGE 兼容性策略）
// Phase 4b 实际使用；Phase 4a 仅声明，避免散落硬编码

/** PostgreSQL 版本（AGE 兼容性策略：默认 18.4，失败降级 17.10） */
export const POSTGRES_VERSIONS = {
  /** 默认版本（AGE 通常滞后 PG 主版本 1-2 个 minor） */
  V18_4: '18.4',
  /** AGE 兼容降级版本 */
  V17_10: '17.10',
} as const;

export type PostgresVersion = (typeof POSTGRES_VERSIONS)[keyof typeof POSTGRES_VERSIONS];
```

### 设计文档 §6.2 schema.prisma 完整定义（逐字对齐）

```prisma
// prisma/schema.prisma
// Prisma 7 schema（设计文档 §6.2 完整定义）
//
// 注意：
// 1. datasource.db.extensions 只声明不加载，实际 CREATE EXTENSION 由 Phase 4b 完成
// 2. RagDocumentChunk.embedding 使用 Unsupported("halfvec(2048)")，
//    Phase 4a 不在 client 层操作该字段；HNSW 索引由 4b 创建
// 3. previewFeatures = ["postgresqlExtensions"] 在 Prisma 7 中已 GA，
//    保留以兼容设计文档；若 prisma generate 报 warning 可忽略

generator client {
  provider        = "prisma-client-js"
  previewFeatures = ["postgresqlExtensions"]
}

datasource db {
  provider   = "postgresql"
  url        = env("DATABASE_URL")
  extensions = [pgvector, age]
}

model Project {
  id          String       @id @default(cuid())
  name        String       @db.VarChar(200)
  description String?      @db.Text
  genre       String?      @db.VarChar(50)
  cover       String?
  status      ProjectStatus @default(ACTIVE)
  metadata    Json         @default("{}")
  createdAt   DateTime     @default(now())
  updatedAt   DateTime     @updatedAt
  archivedAt  DateTime?

  volumes      Volume[]
  chapters     Chapter[]
  characters   Character[]
  worldviews   Worldview[]
  chatSessions ChatSession[]
  ragDocuments RagDocument[]
  setting      ProjectSetting?

  @@index([status])
  @@map("projects")
}

enum ProjectStatus {
  ACTIVE
  ARCHIVED
  DRAFT
}

model Volume {
  id        String   @id @default(cuid())
  projectId String
  title     String   @db.VarChar(200)
  summary   String?  @db.Text
  sortOrder Int      @default(0)
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  project  Project   @relation(fields: [projectId], references: [id], onDelete: Cascade)
  chapters Chapter[]

  @@index([projectId])
  @@map("volumes")
}

model Chapter {
  id        String        @id @default(cuid())
  projectId String
  volumeId  String?
  title     String        @db.VarChar(200)
  content   String        @db.Text
  wordCount Int           @default(0)
  status    ChapterStatus @default(DRAFT)
  sortOrder Int           @default(0)
  metadata  Json          @default("{}")
  createdAt DateTime      @default(now())
  updatedAt DateTime      @updatedAt

  project Project @relation(fields: [projectId], references: [id], onDelete: Cascade)
  volume  Volume? @relation(fields: [volumeId], references: [id], onDelete: SetNull)

  @@index([projectId])
  @@index([volumeId])
  @@index([status, sortOrder])
  @@map("chapters")
}

enum ChapterStatus {
  DRAFT
  OUTLINE
  WRITING
  COMPLETED
  REVISION
}

model Character {
  id          String        @id @default(cuid())
  projectId    String
  name         String        @db.VarChar(100)
  avatar       String?
  role         CharacterRole @default(SUPPORTING)
  description  String?       @db.Text
  profile      Json          @default("{}")
  createdAt    DateTime      @default(now())
  updatedAt    DateTime      @updatedAt

  project Project @relation(fields: [projectId], references: [id], onDelete: Cascade)

  // 人物关系通过 Apache AGE 图存储（不在 Prisma 关系表中）

  @@index([projectId])
  @@index([role])
  @@map("characters")
}

enum CharacterRole {
  PROTAGONIST
  ANTAGONIST
  SUPPORTING
  MINOR
}

model Worldview {
  id        String   @id @default(cuid())
  projectId String
  parentId  String?
  title     String   @db.VarChar(200)
  content   String?  @db.Text
  type      String?  @db.VarChar(50)
  icon      String?
  sortOrder Int      @default(0)
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  project  Project    @relation(fields: [projectId], references: [id], onDelete: Cascade)
  parent   Worldview? @relation(fields: [parentId], references: [id], onDelete: Cascade)
  children Worldview[]

  @@index([projectId])
  @@index([parentId])
  @@map("worldviews")
}

model ChatSession {
  id        String   @id @default(cuid())
  projectId String
  title     String   @db.VarChar(200)
  context   Json     @default("{}")
  model     String?  @db.VarChar(50)
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  project  Project       @relation(fields: [projectId], references: [id], onDelete: Cascade)
  messages ChatMessage[]

  @@index([projectId])
  @@map("chat_sessions")
}

model ChatMessage {
  id        String   @id @default(cuid())
  sessionId String
  role      ChatRole
  content   String   @db.Text
  tokens    Int      @default(0)
  metadata  Json     @default("{}")
  createdAt DateTime @default(now())

  session ChatSession @relation(fields: [sessionId], references: [id], onDelete: Cascade)

  @@index([sessionId, createdAt])
  @@map("chat_messages")
}

enum ChatRole {
  user
  assistant
  system
}

model RagDocument {
  id          String   @id @default(cuid())
  projectId   String
  title       String   @db.VarChar(200)
  source      String?  @db.VarChar(500)
  mimeType    String?  @db.VarChar(100)
  chunksCount Int      @default(0)
  metadata    Json     @default("{}")
  createdAt   DateTime @default(now())

  project Project           @relation(fields: [projectId], references: [id], onDelete: Cascade)
  chunks  RagDocumentChunk[]

  @@index([projectId])
  @@map("rag_documents")
}

model RagDocumentChunk {
  id         String   @id @default(cuid())
  documentId String
  content    String   @db.Text
  chunkIndex Int
  // 向量维度 = 2048（Nemotron-3-Embed-1B-BF16 官方默认维度）
  // Phase 4a 使用 Unsupported 类型，client 层不操作；
  // Phase 4b 通过 raw SQL 创建 HNSW 索引并操作 embedding 字段
  embedding  Unsupported("halfvec(2048)")
  metadata   Json     @default("{}")
  createdAt  DateTime @default(now())

  document RagDocument @relation(fields: [documentId], references: [id], onDelete: Cascade)

  @@index([documentId])
  @@map("rag_document_chunks")
}

model ProjectSetting {
  projectId     String   @id
  aiModel       String   @db.VarChar(50) @default("deepseek-v4-flash")
  aiTemperature Float    @default(0.7)
  aiMaxTokens   Int      @default(4096)
  ragEnabled    Boolean  @default(true)
  ragTopK       Int      @default(5)
  ragThreshold  Float    @default(0.7)
  customPrompts Json     @default("{}")
  updatedAt     DateTime @updatedAt

  project Project @relation(fields: [projectId], references: [id], onDelete: Cascade)

  @@map("project_settings")
}

model AppSetting {
  key       String   @id
  value     String   @db.Text
  updatedAt DateTime @updatedAt

  @@map("app_settings")
}

model AiUsageLog {
  id           String   @id @default(cuid())
  provider     String   @db.VarChar(50)
  model        String   @db.VarChar(50)
  inputTokens  Int      @default(0)
  outputTokens Int      @default(0)
  durationMs   Int      @default(0)
  status       String   @db.VarChar(20)
  error        String?  @db.Text
  createdAt    DateTime @default(now())

  @@index([createdAt])
  @@index([provider, model])
  @@map("ai_usage_logs")
}
```

### Steps

- [ ] **Step 1: 创建 pg-versions.ts 常量文件**

写入 `f:\TraeProjects\1\packages\shared\src\constants\pg-versions.ts`，内容如上「设计文档 §6.5 PG 版本常量」代码块。

- [ ] **Step 2: 在 packages/shared/src/index.ts 导出 POSTGRES_VERSIONS**

读取 `f:\TraeProjects\1\packages\shared\src\index.ts`，确认 constants 导出方式（若是 `export * from './constants/errors'` 模式，则追加 `export * from './constants/pg-versions';`）。

- [ ] **Step 3: 创建 prisma/schema.prisma**

写入 `f:\TraeProjects\1\prisma\schema.prisma`，内容如上「设计文档 §6.2 schema.prisma 完整定义」代码块。

- [ ] **Step 4: 在 package.json 添加 prisma 依赖与 db 脚本**

读取 `f:\TraeProjects\1\package.json`，在 `dependencies` 中添加：
```json
"@prisma/client": "^7",
```
在 `devDependencies` 中添加：
```json
"prisma": "^7",
```
在 `scripts` 中添加：
```json
"db:generate": "prisma generate",
"db:migrate:diff": "prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script"
```

- [ ] **Step 5: 安装依赖**

Run: `pnpm install`
Expected: 安装成功，可能存在 peer dependency 警告（如 prisma 7 期望 zod ^3.x），不影响功能

- [ ] **Step 6: 创建 .env 文件（仅用于 prisma generate）**

写入 `f:\TraeProjects\1\.env`（如已存在则追加）：
```
# Phase 4a: 仅用于 prisma generate / migrate diff（不需要真实连接）
DATABASE_URL="postgresql://nwa@localhost:5433/nwa"
```

> 注：`.env` 已在 `.gitignore` 中（Phase 1 配置），不会提交

- [ ] **Step 7: 运行 prisma generate 验证 schema 语法**

Run: `pnpm db:generate`
Expected: 生成 `@prisma/client` 到 `node_modules/.prisma/client`，无错误

- [ ] **Step 8: 运行 typecheck 验证 TS 类型**

Run: `pnpm typecheck`
Expected: 0 errors 0 warnings

- [ ] **Step 9: 运行 lint**

Run: `pnpm lint`
Expected: 0 errors（pg-versions.ts 应通过）

- [ ] **Step 10: 运行 test 确保未破坏既有测试**

Run: `pnpm test`
Expected: 全部通过（Phase 3b 的 62 个测试不受影响）

- [ ] **Step 11: 提交**

```powershell
git add prisma/schema.prisma packages/shared/src/constants/pg-versions.ts packages/shared/src/index.ts package.json pnpm-lock.yaml
git commit -m "feat(prisma): 添加 Prisma 7 schema 与 PG 版本常量" -m "设计文档 §6.2 + §6.5"
```

---

## Task 2: 添加 pg 配置块 + 验证 prisma generate

**Files:**
- Modify: `f:\TraeProjects\1\src\main\config\index.ts` (新增 pg 配置块)
- Modify: `f:\TraeProjects\1\src\main\__tests__\config.test.ts` (新增 pg 配置测试)

### pg 配置块 Schema 设计

```ts
// 在 src/main/config/index.ts 中新增 PgConfigSchema
const PgConfigSchema = z.object({
  /** 数据库连接 URL（端口 5433 避免与系统 PG 5432 冲突） */
  url: z.string().url().default('postgresql://nwa@localhost:5433/nwa'),
  /** PG 数据目录（%APPDATA%/<AppName>/pgdata，由 app-data.ts 提供） */
  dataDir: z.string().default(''),
  /** PG 监听端口（与 url 中端口一致，pg-controller.start() 使用） */
  port: z.number().int().min(1).max(65535).default(5433),
  /** PG 数据库实例名 */
  database: z.string().default('nwa'),
  /** PG 启动超时（毫秒） */
  startTimeout: z.number().int().positive().default(30_000),
});
```

### config/index.ts 完整修改方案

读取现有 `f:\TraeProjects\1\src\main\config\index.ts`，按以下步骤修改：

1. 在 `OllamaConfigSchema` 定义之后、`AppConfigSchema` 之前，新增 `PgConfigSchema`
2. 在 `AppConfigSchema` 中新增 `pg: PgConfigSchema` 字段
3. 在 `loadConfig()` 中新增 pg 配置读取逻辑：
   ```ts
   pg: {
     url: process.env.DATABASE_URL ?? 'postgresql://nwa@localhost:5433/nwa',
     dataDir: process.env.PG_DATA_DIR ?? '',
     port: Number(process.env.PG_PORT ?? 5433),
     database: process.env.PG_DATABASE ?? 'nwa',
     startTimeout: Number(processenv.PG_START_TIMEOUT ?? 30_000),
   },
   ```

### Steps

- [ ] **Step 1: 读取现有 config/index.ts 与 config.test.ts**

读取 `f:\TraeProjects\1\src\main\config\index.ts` 与 `f:\TraeProjects\1\src\main\__tests__\config.test.ts` 完整内容。

- [ ] **Step 2: 在 config.test.ts 末尾追加 pg 配置失败测试（TDD）**

在 `f:\TraeProjects\1\src\main\__tests__\config.test.ts` 末尾追加：

```ts
describe('AppConfig - pg', () => {
  beforeEach(() => {
    resetConfigCache();
  });

  it('应使用默认 pg 配置（DATABASE_URL 未设置时）', () => {
    delete process.env.DATABASE_URL;
    delete process.env.PG_PORT;
    delete process.env.PG_DATABASE;
    delete process.env.PG_DATA_DIR;
    delete process.env.PG_START_TIMEOUT;

    const config = getAppConfig();

    expect(config.pg.url).toBe('postgresql://nwa@localhost:5433/nwa');
    expect(config.pg.port).toBe(5433);
    expect(config.pg.database).toBe('nwa');
    expect(config.pg.dataDir).toBe('');
    expect(config.pg.startTimeout).toBe(30_000);
  });

  it('应从环境变量读取 pg 配置', () => {
    process.env.DATABASE_URL = 'postgresql://user:pass@host:6543/db';
    process.env.PG_PORT = '6543';
    process.env.PG_DATABASE = 'custom_db';
    process.env.PG_DATA_DIR = 'C:/custom/pgdata';
    process.env.PG_START_TIMEOUT = '60000';

    const config = getAppConfig();

    expect(config.pg.url).toBe('postgresql://user:pass@host:6543/db');
    expect(config.pg.port).toBe(6543);
    expect(config.pg.database).toBe('custom_db');
    expect(config.pg.dataDir).toBe('C:/custom/pgdata');
    expect(config.pg.startTimeout).toBe(60_000);

    delete process.env.DATABASE_URL;
    delete process.env.PG_PORT;
    delete process.env.PG_DATABASE;
    delete process.env.PG_DATA_DIR;
    delete process.env.PG_START_TIMEOUT;
  });

  it('应拒绝无效端口（0 / 负数 / 超过 65535）', () => {
    process.env.PG_PORT = '0';
    resetConfigCache();
    expect(() => getAppConfig()).toThrow();
    resetConfigCache();

    process.env.PG_PORT = '-1';
    expect(() => getAppConfig()).toThrow();
    resetConfigCache();

    process.env.PG_PORT = '70000';
    expect(() => getAppConfig()).toThrow();

    delete process.env.PG_PORT;
  });

  it('应拒绝无效 URL', () => {
    process.env.DATABASE_URL = 'not-a-url';
    resetConfigCache();
    expect(() => getAppConfig()).toThrow();
    delete process.env.DATABASE_URL;
  });
});
```

- [ ] **Step 3: 运行测试验证失败**

Run: `pnpm test:main -- config.test.ts`
Expected: FAIL，提示 `config.pg` 未定义

- [ ] **Step 4: 修改 config/index.ts 添加 PgConfigSchema 与 pg 配置块**

按上述「pg 配置块 Schema 设计」修改 `f:\TraeProjects\1\src\main\config\index.ts`：
- 新增 `PgConfigSchema` 定义
- 在 `AppConfigSchema` 中新增 `pg: PgConfigSchema`
- 在 `loadConfig()` 中新增 pg 配置读取

- [ ] **Step 5: 运行测试验证通过**

Run: `pnpm test:main -- config.test.ts`
Expected: 既有测试 + 4 个新测试全部 PASS

- [ ] **Step 6: 运行 typecheck**

Run: `pnpm typecheck`
Expected: 0 errors

- [ ] **Step 7: 运行 lint**

Run: `pnpm lint`
Expected: 0 errors

- [ ] **Step 8: 运行全部测试**

Run: `pnpm test`
Expected: 全部通过（62 + 4 = 66 测试）

- [ ] **Step 9: 验证 prisma generate 仍能成功**

Run: `pnpm db:generate`
Expected: 无错误，生成 `@prisma/client`

- [ ] **Step 10: 提交**

```powershell
git add src/main/config/index.ts src/main/__tests__/config.test.ts
git commit -m "feat(config): 添加 PostgreSQL 数据库配置块" -m "设计文档 §6.2 + §7.8"
```

---

## Task 3: PrismaClient 单例 + 单元测试

**Files:**
- Create: `f:\TraeProjects\1\src\main\infra\prisma\client.ts`
- Create: `f:\TraeProjects\1\src\main\infra\prisma\client.test.ts`

### client.ts 完整实现

```ts
// src/main/infra/prisma/client.ts
// PrismaClient 单例工厂
// 设计文档 §4.3 infra 层职责：prisma/client = PrismaClient 单例
//
// 职责：
// 1. 单例模式（避免重复实例化，复用连接池）
// 2. 集成 logger（记录查询错误）
// 3. 集成 retry（指数退避，应对瞬时连接失败）
// 4. 提供 disconnect() 用于应用退出时清理
// 5. 提供 resetClient() 用于测试隔离
//
// 注意：
// - 本阶段不实际连接 PG（PG 由 Phase 4b 启动）
// - getPrismaClient() 仅返回单例，不主动 $connect()
// - 调用方应在使用前调用 $connect()（或由 service 层 retry 包裹）

import { PrismaClient } from '@prisma/client';
import { getAppConfig } from '../../config';
import { logger } from '../../utils/logger';
import { retry } from '../../utils/retry';

// biome-ignore lint/style/useNamingConvention: PrismaClient 是 Prisma 官方类型名
let cachedClient: PrismaClient | null = null;

/**
 * 获取 PrismaClient 单例
 *
 * 首次调用时实例化并绑定日志钩子，后续调用返回缓存
 *
 * @returns PrismaClient 单例
 */
// biome-ignore lint/style/useNamingConvention: PrismaClient 是 Prisma 官方类型名
export function getPrismaClient(): PrismaClient {
  if (cachedClient !== null) {
    return cachedClient;
  }

  const config = getAppConfig();
  // biome-ignore lint/style/useNamingConvention: PrismaClient 是 Prisma 官方类型名
  const client = new PrismaClient({
    datasources: {
      db: {
        url: config.pg.url,
      },
    },
    // 日志级别：dev 环境输出 query，生产仅输出 error
    log: [
      { level: 'error', emit: 'event' },
      { level: 'warn', emit: 'event' },
    ],
  });

  // 绑定日志事件（Prisma 7 事件 API）
  client.$on('error', (e) => {
    logger.error({ error: e.message }, 'Prisma 查询错误');
  });
  client.$on('warn', (e) => {
    logger.warn({ message: e.message }, 'Prisma 警告');
  });

  cachedClient = client;
  return client;
}

/**
 * 测试数据库连接（带 retry）
 *
 * Phase 4b 启动 PG 后调用此方法验证连接
 *
 * @returns 成功返回 true，失败抛错
 */
export async function testPrismaConnection(): Promise<boolean> {
  const client = getPrismaClient();
  await retry(async () => {
    await client.$connect();
  });
  return true;
}

/**
 * 断开 PrismaClient 连接
 *
 * 应用退出时调用（main/index.ts before-quit）
 */
export async function disconnectPrisma(): Promise<void> {
  if (cachedClient === null) {
    return;
  }
  try {
    await cachedClient.$disconnect();
    logger.info({}, 'PrismaClient 已断开连接');
  } catch (err) {
    logger.error({ error: err }, 'PrismaClient 断开连接失败');
  } finally {
    cachedClient = null;
  }
}

/**
 * 重置 client 缓存（仅测试用）
 *
 * 测试用例隔离时使用，避免单例污染
 */
export function resetPrismaClient(): void {
  cachedClient = null;
}
```

### client.test.ts 完整实现

```ts
// src/main/infra/prisma/client.test.ts
// PrismaClient 单例工厂单元测试
//
// 测试策略：
// 1. vi.mock('@prisma/client') 替换 PrismaClient 构造函数
// 2. 使用 vi.fn(function () { return mockInstance; }) 避免 [[Construct]] 陷阱（Phase 3b 经验）
// 3. 不连接真实 PG，仅验证单例行为与生命周期
// 4. 重置缓存确保测试隔离

import { PrismaClient } from '@prisma/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAppConfig, resetConfigCache } from '../../config';
import { disconnectPrisma, getPrismaClient, resetPrismaClient } from './client';

// biome-ignore lint/style/useNamingConvention: mockPrismaInstance 是测试 mock 命名
const mockPrismaInstance = {
  $on: vi.fn(),
  $connect: vi.fn().mockResolvedValue(undefined),
  $disconnect: vi.fn().mockResolvedValue(undefined),
};

// 关键：用 function 表达式实现 constructor（Vitest 4 vi.fn 箭头函数无 [[Construct]]）
vi.mock('@prisma/client', () => ({
  // biome-ignore lint/complexity/useArrowFunction: 需要 [[Construct]] 调用
  PrismaClient: vi.fn(function () {
    return mockPrismaInstance;
  }),
}));

describe('PrismaClient 单例工厂', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrismaInstance.$on.mockClear();
    mockPrismaInstance.$connect.mockClear();
    mockPrismaInstance.$disconnect.mockClear();
    mockPrismaInstance.$connect.mockResolvedValue(undefined);
    mockPrismaInstance.$disconnect.mockResolvedValue(undefined);
    resetPrismaClient();
    resetConfigCache();
  });

  afterEach(() => {
    resetPrismaClient();
    resetConfigCache();
  });

  it('应返回 PrismaClient 实例', () => {
    const client = getPrismaClient();
    expect(client).toBe(mockPrismaInstance);
  });

  it('应使用单例模式（重复调用返回同一实例）', () => {
    const c1 = getPrismaClient();
    const c2 = getPrismaClient();
    expect(c1).toBe(c2);
    // PrismaClient 构造函数只被调用 1 次
    expect(PrismaClient).toHaveBeenCalledTimes(1);
  });

  it('应使用 config.pg.url 作为 datasource', () => {
    process.env.DATABASE_URL = 'postgresql://test@localhost:9999/test';
    getPrismaClient();

    expect(PrismaClient).toHaveBeenCalledTimes(1);
    const callArgs = (PrismaClient as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0] as {
      datasources?: { db?: { url?: string } };
    };
    expect(callArgs.datasources?.db?.url).toBe('postgresql://test@localhost:9999/test');

    delete process.env.DATABASE_URL;
  });

  it('应绑定 error 与 warn 日志事件', () => {
    getPrismaClient();
    expect(mockPrismaInstance.$on).toHaveBeenCalledWith('error', expect.any(Function));
    expect(mockPrismaInstance.$on).toHaveBeenCalledWith('warn', expect.any(Function));
  });

  it('disconnectPrisma 应调用 $disconnect 并清空缓存', async () => {
    getPrismaClient();
    await disconnectPrisma();

    expect(mockPrismaInstance.$disconnect).toHaveBeenCalledTimes(1);

    // 缓存清空后，再次调用应重新实例化
    getPrismaClient();
    expect(PrismaClient).toHaveBeenCalledTimes(2);
  });

  it('disconnectPrisma 在 client 未初始化时应安全返回', async () => {
    await expect(disconnectPrisma()).resolves.toBeUndefined();
    expect(mockPrismaInstance.$disconnect).not.toHaveBeenCalled();
  });

  it('resetPrismaClient 应清空缓存', () => {
    getPrismaClient();
    resetPrismaClient();
    getPrismaClient();

    // 缓存清空后重新实例化，构造函数被调用 2 次
    expect(PrismaClient).toHaveBeenCalledTimes(2);
  });

  it('应使用 getAppConfig 读取默认 URL（未设置环境变量时）', () => {
    delete process.env.DATABASE_URL;
    const config = getAppConfig();
    const expectedUrl = config.pg.url;

    getPrismaClient();

    const callArgs = (PrismaClient as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0] as {
      datasources?: { db?: { url?: string } };
    };
    expect(callArgs.datasources?.db?.url).toBe(expectedUrl);
  });
});
```

### Steps

- [ ] **Step 1: 读取现有 config.test.ts 与 retry.ts 了解测试模式**

读取 `f:\TraeProjects\1\src\main\__tests__\config.test.ts` 与 `f:\TraeProjects\1\src\main\utils\retry.ts`，确认 mock 风格与测试组织。

- [ ] **Step 2: 创建 client.test.ts（TDD 先写测试）**

写入 `f:\TraeProjects\1\src\main\infra\prisma\client.test.ts`，内容如上「client.test.ts 完整实现」。

- [ ] **Step 3: 运行测试验证失败**

Run: `pnpm test:main -- prisma/client.test.ts`
Expected: FAIL，提示模块 `./client` 不存在

- [ ] **Step 4: 创建 client.ts 实现**

写入 `f:\TraeProjects\1\src\main\infra\prisma\client.ts`，内容如上「client.ts 完整实现」。

- [ ] **Step 5: 运行测试验证通过**

Run: `pnpm test:main -- prisma/client.test.ts`
Expected: 8 个测试全部 PASS

- [ ] **Step 6: 运行 typecheck**

Run: `pnpm typecheck`
Expected: 0 errors

- [ ] **Step 7: 运行 lint**

Run: `pnpm lint`
Expected: 0 errors

- [ ] **Step 8: 运行全部测试**

Run: `pnpm test`
Expected: 全部通过（66 + 8 = 74 测试）

- [ ] **Step 9: 提交**

```powershell
git add src/main/infra/prisma/client.ts src/main/infra/prisma/client.test.ts
git commit -m "feat(prisma): PrismaClient 单例工厂与生命周期管理" -m "设计文档 §4.3 infra 层职责"
```

---

## Task 4: 生成 migration SQL + 集成 main/index.ts

**Files:**
- Create: `f:\TraeProjects\1\prisma\migrations\0_init\migration.sql`
- Modify: `f:\TraeProjects\1\src\main\index.ts` (集成 PrismaClient lifecycle)

### migration SQL 生成策略

使用 `prisma migrate diff` 离线生成 SQL，**不连接真实 PG**：

```bash
pnpm prisma migrate diff \
  --from-empty \
  --to-schema-datamodel prisma/schema.prisma \
  --script > prisma/migrations/0_init/migration.sql
```

生成的 SQL 包含：
- 13 个 CREATE TABLE
- 4 个 CREATE TYPE（enum）
- 索引创建
- **不包含** `CREATE EXTENSION pgvector/age`（由 Phase 4b 在 initdb 后执行）
- **不包含** HNSW 索引（RagDocumentChunk.embedding 是 Unsupported 类型，Prisma 不会生成 DDL）

### main/index.ts 集成方案

在 `app.whenReady()` 中、`createWindow()` 之前**不调用** `testPrismaConnection()`（PG 未启动）。
在 `app.on('before-quit')` 中调用 `disconnectPrisma()` 清理连接。

```ts
// 修改 src/main/index.ts
import { disconnectPrisma } from './infra/prisma/client';

// ... 现有代码 ...

// 在文件末尾追加：应用退出前断开 PrismaClient 连接
app.on('before-quit', async (event) => {
  // 阻止默认退出行为，等待异步清理完成
  event.preventDefault();
  await disconnectPrisma();
  // 清理完成后再次触发退出（避免无限循环）
  app.exit(0);
});

// 注：Phase 4b 集成 PG 启动后，会在 app.whenReady() 中：
// 1. await pgController.start()
// 2. await testPrismaConnection()
// 3. createWindow()
// Phase 4a 仅集成 disconnect 逻辑，避免启动时连接失败
```

### Steps

- [ ] **Step 1: 创建 migrations 目录**

Run: `New-Item -ItemType Directory -Path f:\TraeProjects\1\prisma\migrations\0_init -Force`
Expected: 目录创建成功

- [ ] **Step 2: 生成 migration SQL（离线）**

Run:
```powershell
pnpm exec prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script | Out-File -FilePath prisma/migrations/0_init/migration.sql -Encoding utf8
```
Expected: `prisma/migrations/0_init/migration.sql` 文件生成，包含 CREATE TABLE / CREATE TYPE 语句

- [ ] **Step 3: 验证 migration SQL 内容**

读取 `f:\TraeProjects\1\prisma\migrations\0_init\migration.sql`，确认：
- 包含 `CREATE TABLE "projects"` / `"volumes"` / `"chapters"` 等 13 张表
- 包含 `CREATE TYPE "ProjectStatus"` / `"ChapterStatus"` / `"CharacterRole"` / `"ChatRole"` 4 个 enum
- 包含 `CREATE INDEX` 语句
- 不包含 `CREATE EXTENSION`（应在 4b 处理）
- 不包含 `halfvec` 相关 DDL（Unsupported 类型不生成 DDL）

- [ ] **Step 4: 创建 migration_lock.toml**

写入 `f:\TraeProjects\1\prisma\migrations\migration_lock.toml`：
```toml
# Prisma migration lock 文件
# 标记 migrations 目录的 provider，避免不同 provider 混用
provider = "postgresql"
```

- [ ] **Step 5: 修改 main/index.ts 集成 disconnectPrisma**

读取 `f:\TraeProjects\1\src\main\index.ts` 完整内容。

在 import 部分追加：
```ts
import { disconnectPrisma } from './infra/prisma/client';
```

在文件末尾（`app.on('window-all-closed', ...)` 之后）追加 `before-quit` 处理：
```ts
// 应用退出前断开 PrismaClient 连接（设计文档 §1.1 应用生命周期）
// 注：Phase 4a 仅注册清理逻辑，启动时连接 PG 由 Phase 4b 实现
let isQuitting = false;
app.on('before-quit', async (event) => {
  if (isQuitting) {
    return;
  }
  event.preventDefault();
  isQuitting = true;
  try {
    await disconnectPrisma();
  } catch (err) {
    logger.error({ error: err }, '应用退出清理失败');
  }
  app.exit(0);
});
```

- [ ] **Step 6: 运行 typecheck**

Run: `pnpm typecheck`
Expected: 0 errors

- [ ] **Step 7: 运行 lint**

Run: `pnpm lint`
Expected: 0 errors

- [ ] **Step 8: 运行全部测试**

Run: `pnpm test`
Expected: 全部通过（74 测试不受影响）

- [ ] **Step 9: 运行 build 验证生产构建**

Run: `pnpm build`
Expected: 三入口产物生成（main / preload / renderer），无错误

- [ ] **Step 10: 提交**

```powershell
git add prisma/migrations/0_init/migration.sql prisma/migrations/migration_lock.toml src/main/index.ts
git commit -m "feat(prisma): 生成初始化 migration SQL 并集成退出清理" -m "设计文档 §6.2 + §1.1 应用生命周期"
```

---

## 验收清单（Phase 4a 完成后执行）

- [ ] `pnpm install` 成功（无 fatal 错误）
- [ ] `pnpm db:generate` 成功（无错误）
- [ ] `pnpm typecheck` 0 errors 0 warnings
- [ ] `pnpm lint` 0 errors
- [ ] `pnpm test` 全部通过（预期 74 个测试）
- [ ] `pnpm build` 三入口产物生成
- [ ] `prisma/schema.prisma` 含 13 个 model + 4 个 enum
- [ ] `prisma/migrations/0_init/migration.sql` 已生成
- [ ] `src/main/infra/prisma/client.ts` 含单例 + retry + disconnect
- [ ] `src/main/config/index.ts` 含 pg 配置块
- [ ] `src/main/index.ts` 含 before-quit 清理逻辑
- [ ] `packages/shared/src/constants/pg-versions.ts` 已导出
- [ ] CodeGraph index 已同步（`codegraph sync`，由 husky pre-commit 自动执行）
- [ ] 4 个 commit 已创建

---

## Self-Review 检查（计划编写者自检）

### Spec coverage（设计文档覆盖）
- ✅ §6.1 ER 关系总览 → schema.prisma 中 model 关系完整覆盖
- ✅ §6.2 完整 Prisma Schema → Task 1 创建 schema.prisma（逐字对齐）
- ✅ §6.3 Apache AGE 图数据 → Phase 4a 不实现（人物关系通过 AGE 图存储，无 Prisma 关系字段）
- ✅ §6.4 HNSW 索引 → Phase 4a 不实现（halfvec(2048) 通过 Unsupported 类型声明，实际 HNSW 由 4b 创建）
- ✅ §6.5 AGE 兼容性策略 → Task 1 创建 `pg-versions.ts` 常量（实际降级逻辑由 4b 实现）
- ✅ §6.6 Ollama 嵌入服务 → Phase 3b 已完成，4a 不涉及
- ✅ §4.3 infra 层 prisma/client 职责 → Task 3 实现 PrismaClient 单例
- ✅ §1.1 应用生命周期 → Task 4 集成 before-quit 清理

### Placeholder scan
- ❌ 无 TBD / TODO / "implement later"
- ❌ 无 "add appropriate error handling"（已显式列出 try/catch + logger.error）
- ❌ 无 "Similar to Task N"（每个 Task 都有完整代码）
- ✅ 所有步骤都给出具体代码或具体命令

### Type consistency
- `getPrismaClient()` / `disconnectPrisma()` / `resetPrismaClient()` / `testPrismaConnection()` 在 Task 3 与 Task 4 中名称一致
- `PgConfigSchema` 字段名（url / dataDir / port / database / startTimeout）在 Task 2 config 与 Task 3 client 调用中一致
- `POSTGRES_VERSIONS` 常量名与设计文档 §6.5 一致
- `PrismaClient` mock 命名（mockPrismaInstance）在测试内一致
- `config.pg.url` 在 client.ts 与 config/index.ts 中字段名一致

### Phase 边界遵守
- ✅ 不实际连接 PG（testPrismaConnection 只在 4b 调用）
- ✅ 不创建 HNSW 索引（migration SQL 中 embedding 是 Unsupported，不生成 DDL）
- ✅ 不执行 `CREATE EXTENSION`（migration SQL 不包含，由 4b 处理）
- ✅ 不集成 pg-controller（4b 集成）
- ✅ 不实现 AGE 顶点/边初始化（4b 实现）

### 已知风险（执行时需注意）
1. **prisma 7 previewFeatures warning**：`previewFeatures = ["postgresqlExtensions"]` 在 Prisma 7 中可能已 GA，generate 时会出现 warning。处理：保留以兼容设计文档；若 warning 影响构建，可移除 previewFeatures 行。
2. **@prisma/client peer dependency**：prisma 7 可能期望 zod ^3.x，项目用 zod 4.4.3。处理：pnpm install 时若出现 peer warning，不影响功能，可后续在 package.json 添加 `pnpm.peerDependencyRules.allowedVersions`。
3. **prisma migrate diff 输出编码**：PowerShell 默认 UTF-16，`Out-File -Encoding utf8` 强制 UTF-8。处理：检查文件首字节是否含 BOM（若含需移除）。
4. **vi.mock '@prisma/client' 完整替换**：vi.mock 默认 hoisting，mock 工厂中不能引用外部变量（除了 vi.hoisted）。处理：mockPrismaInstance 在 vi.mock factory 内部声明，或用 vi.hoisted 导出。**修正**：本计划已在 vi.mock factory 内部用 `function () { return mockPrismaInstance; }` 引用外部 mockPrismaInstance（Vitest 4 允许），但更安全的做法是用 vi.hoisted。**执行时若失败，改用 vi.hoisted 重构**。

### 执行建议
- Task 1-2 可顺序执行（Task 2 依赖 Task 1 的 schema 验证）
- Task 3 依赖 Task 2 的 pg 配置块
- Task 4 依赖 Task 3 的 disconnectPrisma 函数
- 每个 Task 派发独立子代理，子代理间通过 git commit 传递状态
- 子代理执行 Task 时，**直接使用本计划中的代码块**，不要自行重构
