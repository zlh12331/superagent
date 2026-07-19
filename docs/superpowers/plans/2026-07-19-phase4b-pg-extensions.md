# Phase 4b: pgvector + HNSW + AGE + pg-installer 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 完成嵌入式 PG 的 initdb、扩展加载（pgvector / AGE）、HNSW 索引创建、AGE Cypher 透传封装，以及 PG + DB 初始化流程在主进程入口的集成。

**Architecture:**
- `pg-installer` 负责 initdb 与版本资源管理（不启动 PG，由 `pg-controller` 负责）
- `age-extension` 负责 AGE 扩展加载 + Graph 创建 + Cypher 透传 API（基于 Prisma `$executeRawUnsafe` / `$queryRawUnsafe`）
- `hnsw-index` 负责 HNSW 索引 + pg_trgm 全文索引创建（在 migration 执行后）
- 主进程入口 `index.ts` 串联启动流程：`ensureInstalled → pgController.start → testPrismaConnection → migrate deploy → ensureAgeExtension → ensureHnswIndex`
- AGE 兼容性降级（设计文档 §6.5）：PG 18.4 默认，AGE 加载失败时降级到 PG 17.10

**Tech Stack:**
- Prisma 7 migrate deploy（执行 migration.sql）
- pgvector halfvec(2048) + HNSW（`m=16, ef_construction=64`）
- Apache AGE（Cypher over SQL）
- pg_trgm（章节内容 GIN 全文索引）
- `child_process.spawn`（initdb 子进程）

---

## 上下文与约束

### 设计文档依据
- §6.3 Apache AGE 图数据：Character 顶点 + RELATION 边，通过 Prisma raw SQL 透传 Cypher
- §6.4 HNSW 索引：halfvec(2048)，`m=16, ef_construction=64`，余弦距离
- §6.5 AGE 兼容性策略：PG 18.4 默认 + 17.10 降级（在 pg-installer 启动初始化时执行）
- §4.3 infra 层职责：pg-installer / pg-controller / prisma/extensions/pgvector / prisma/extensions/age
- §1.1 进程拓扑：PG 子进程生命周期由 pg-controller 管理

### Phase 4a 已有资源
- `prisma/schema.prisma` — 12 模型 + 4 enum + datasource（含 `extensions = [pgvector, age]`）
- `prisma.config.ts` — Prisma 7 配置（datasource.url 在此声明）
- `prisma/migrations/0_init/migration.sql` — 267 行初始化 SQL（含 `CREATE EXTENSION IF NOT EXISTS age/pgvector`，幂等）
- `src/main/infra/prisma/client.ts` — PrismaClient 单例 + `testPrismaConnection()` + `disconnectPrisma()`
- `src/main/config/index.ts` — `pg` 配置块（url/dataDir/port/database/startTimeout）
- `packages/shared/src/constants/pg-versions.ts` — `POSTGRES_VERSIONS.V18_4` / `V17_10`
- `src/main/index.ts` — `before-quit` 已集成 disconnectPrisma

### Phase 3b 已有资源
- `src/main/infra/pg/pg-controller.ts` — PgController（spawn + TCP 探活 + SIGTERM → SIGKILL）
- `src/main/infra/pg/pg-types.ts` — PgConfig（binaryPath/dataDir/port）+ PgStatus + PgStatusChangeEvent

### Phase 3a 已有资源
- `src/main/infra/storage/app-data.ts` — `getUserDataPath()` / `getLogsPath()` / `getBackupsPath()` 等
- `src/main/utils/logger.ts` — 结构化日志（traceId）
- `src/main/utils/retry.ts` — 指数退避重试

### 错误码（已定义）
- `PG_INIT_FAILED` — 数据库初始化失败（fatal）
- `PG_START_FAILED` — 数据库启动失败
- `PG_CRASHED` — 数据库异常
- `DB_CONNECTION_FAILED` — 数据库连接失败
- `DB_QUERY_ERROR` — 数据库查询错误

### 子代理执行注意事项（Phase 3b + 4a 经验）
1. **vi.fn constructor 陷阱**：`vi.fn(() => x)` 箭头函数无 `[[Construct]]`，必须用 `vi.fn(function () { return mockInstance; })`
2. **biome useNamingConvention**：`PrismaClient` / `PgInstaller` / `AGE_EXTENSION` 等连续大写标识符需加 `// biome-ignore lint/style/useNamingConvention`
3. **commitlint subject-case**：subject 不能以大写字母开头（用中文开头）
4. **PowerShell 不支持 heredoc**：用多个 `-m "message"` 参数
5. **PowerShell stderr 混入**：`Out-File` 时需 `2>$null` 隔离 stderr
6. **mock 污染**：`beforeEach` 必须 `mockReset()`，不只是 `clearAllMocks()`
7. **Prisma 7 raw SQL API**：`$executeRawUnsafe` 返回 `Promise<number>`（受影响行数），`$queryRawUnsafe` 返回 `Promise<unknown[]>`
8. **Prisma 7 driver adapter**：Phase 4a 已通过 `prisma.config.ts` 提供 URL，本阶段无需 driver adapter

---

## 文件结构总览

```
f:\TraeProjects\1\
├── packages/
│   └── shared/
│       └── src/
│           └── constants/
│               └── age.ts                       # Create: AGE Graph 名 + 顶点/边标签常量
├── src/
│   └── main/
│       ├── infra/
│       │   ├── pg/
│       │   │   ├── pg-controller.ts             # 已存在（Phase 3b）
│       │   │   ├── pg-types.ts                  # 已存在（Phase 3b）
│       │   │   ├── pg-installer.ts              # Create: initdb + 资源路径 + AGE 降级编排
│       │   │   └── pg-installer.test.ts         # Create: 单元测试
│       │   └── prisma/
│       │       ├── client.ts                    # 已存在（Phase 4a）
│       │       └── extensions/
│       │           ├── age.ts                   # Create: AGE 扩展加载 + Cypher 透传
│       │           ├── age.test.ts              # Create: 单元测试
│       │           ├── hnsw.ts                  # Create: HNSW + pg_trgm 索引初始化
│       │           └── hnsw.test.ts             # Create: 单元测试
│       ├── config/
│       │   └── index.ts                         # Modify: pg 配置块新增版本与资源路径字段
│       └── index.ts                            # Modify: 集成 PG 启动 + DB 初始化流程
└── resources/
    └── pg/
        ├── 18.4/                                 # 占位目录（实际二进制由 4b 后续打包阶段填充）
        └── 17.10/                                # 占位目录（AGE 降级备份）
```

---

## Task 1: pg-installer 模块（initdb + 资源路径 + AGE 降级编排）

**Files:**
- Create: `f:\TraeProjects\1\packages\shared\src\constants\age.ts`
- Create: `f:\TraeProjects\1\src\main\infra\pg\pg-installer.ts`
- Create: `f:\TraeProjects\1\src\main\infra\pg\pg-installer.test.ts`
- Modify: `f:\TraeProjects\1\src\main\config\index.ts`（pg 配置块新增字段）

### 设计文档 §6.3 AGE 常量

```ts
// packages/shared/src/constants/age.ts
// Apache AGE 图数据常量（设计文档 §6.3）
// - 顶点标签 Character（属性：characterId, name, role）
// - 边标签 RELATION（属性：type, description, chapterId）
// - 通过 Prisma $executeRawUnsafe / $queryRawUnsafe 透传 Cypher

/** AGE Graph 名（novel writer agent 业务图） */
export const AGE_GRAPH_NAME = 'novel_graph';

/** 顶点标签：人物 */
export const AGE_VERTEX_LABEL = {
  CHARACTER: 'Character',
} as const;

/** 边标签：人物关系 */
export const AGE_EDGE_LABEL = {
  RELATION: 'RELATION',
} as const;
```

### pg 配置块扩展

在 `src/main/config/index.ts` 的 `PgConfigSchema` 中新增字段：

```ts
const PgConfigSchema = z.object({
  url: z.string().url().default('postgresql://nwa@localhost:5433/nwa'),
  dataDir: z.string().default(''),
  port: z.number().int().min(1).max(65535).default(5433),
  database: z.string().default('nwa'),
  startTimeout: z.number().int().positive().default(30_000),
  // 新增字段（Phase 4b）
  /** PG 版本（默认 18.4，AGE 失败降级到 17.10） */
  version: z.string().default(POSTGRES_VERSIONS.V18_4),
  /** PG 资源根目录（dev: 空，用系统 PATH；prod: resources/pg） */
  resourcesDir: z.string().default(''),
  /** initdb 超时（毫秒） */
  initdbTimeout: z.number().int().positive().default(60_000),
});
```

### pg-installer.ts 完整实现

```ts
// src/main/infra/pg/pg-installer.ts
// PostgreSQL 初始化模块（设计文档 §6.5 AGE 兼容性策略 + §1.2 决策 3）
//
// 职责：
// 1. 检测数据目录是否已初始化（PG_VERSION 文件存在）
// 2. 未初始化时调用 initdb 创建数据目录
// 3. 提供 postgres 二进制路径（dev: 系统 PATH；prod: resources/pg/<version>/bin/）
// 4. AGE 兼容性降级编排（18.4 失败 → 切换 17.10，迁移数据目录）
//
// 注意：不启动 PG（由 pg-controller.start() 负责）

import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';
import { AppError, ErrorCode, POSTGRES_VERSIONS } from '@novel-writer/shared';
import { getAppConfig } from '../../config';
import { getUserDataPath } from '../storage/app-data';
import { logger } from '../../utils/logger';

/** PG 数据目录标识文件（initdb 后存在） */
const PG_VERSION_FILE = 'PG_VERSION';

/** 默认 PG 版本 */
const DEFAULT_VERSION = POSTGRES_VERSIONS.V18_4;

/** 降级 PG 版本 */
const FALLBACK_VERSION = POSTGRES_VERSIONS.V17_10;

/**
 * 获取 PG 二进制路径
 *
 * dev：返回 'postgres'（系统 PATH）
 * prod：返回 resources/pg/<version>/bin/postgres.exe
 */
export function getPgBinaryPath(version: string = DEFAULT_VERSION): string {
  const config = getAppConfig();
  if (config.isDev) {
    return 'postgres';
  }
  // 生产环境：resources/pg/<version>/bin/postgres.exe
  return join(
    process.resourcesPath,
    'pg',
    version,
    'bin',
    'postgres.exe',
  );
}

/**
 * 获取 PG 数据目录
 *
 * %APPDATA%/<AppName>/pgdata-<version>/
 * 版本切换时通过目录后缀隔离
 */
export function getPgDataDir(version: string = DEFAULT_VERSION): string {
  return join(getUserDataPath(), `pgdata-${version}`);
}

/**
 * 检测 PG 数据目录是否已初始化
 *
 * initdb 会在数据目录创建 PG_VERSION 文件
 */
export function isPgInitialized(version: string = DEFAULT_VERSION): boolean {
  const dataDir = getPgDataDir(version);
  const versionFile = join(dataDir, PG_VERSION_FILE);
  return existsSync(versionFile);
}

/**
 * 执行 initdb 初始化数据目录
 *
 * @param version PG 版本
 * @throws AppError(PG_INIT_FAILED) initdb 失败或超时
 */
export async function initdb(version: string = DEFAULT_VERSION): Promise<void> {
  const dataDir = getPgDataDir(version);
  const binaryPath = getPgBinaryPath(version);
  const initdbPath = binaryPath === 'postgres' ? 'initdb' : join(binaryPath, '..', 'initdb.exe');

  logger.info({ version, dataDir }, '执行 initdb 初始化数据目录');

  return new Promise<void>((resolve, reject) => {
    const config = getAppConfig();
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(
        new AppError(
          ErrorCode.PG_INIT_FAILED,
          `initdb 超时（${config.pg.initdbTimeout}ms）`,
        ),
      );
    }, config.pg.initdbTimeout).unref();

    const child = spawn(
      initdbPath,
      ['-D', dataDir, '--username=postgres', '--auth=trust', '--encoding=UTF8'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );

    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      logger.debug({ version }, `initdb stdout: ${chunk.toString().trim()}`);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim();
      stderr += text;
      logger.warn({ version }, `initdb stderr: ${text}`);
    });

    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) {
        logger.info({ version, dataDir }, 'initdb 完成');
        resolve();
      } else {
        reject(
          new AppError(
            ErrorCode.PG_INIT_FAILED,
            `initdb 失败（code=${code}, signal=${signal}）: ${stderr}`,
          ),
        );
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(
        new AppError(
          ErrorCode.PG_INIT_FAILED,
          `initdb 进程错误: ${err.message}`,
        ),
      );
    });
  });
}

/**
 * 确保数据目录已初始化
 *
 * 首次启动调用，已初始化则跳过
 */
export async function ensureInstalled(version: string = DEFAULT_VERSION): Promise<void> {
  if (isPgInitialized(version)) {
    logger.debug({ version }, 'PG 数据目录已存在，跳过 initdb');
    return;
  }
  await initdb(version);
}

/**
 * 切换 PG 版本（AGE 降级用）
 *
 * 1. 确保目标版本数据目录已初始化
 * 2. 调用方负责 stop 旧版本 + start 新版本
 *
 * @param targetVersion 目标 PG 版本（如 17.10）
 */
export async function switchVersion(targetVersion: string): Promise<void> {
  if (targetVersion !== FALLBACK_VERSION) {
    logger.warn({ targetVersion }, '切换到非标准版本，可能不兼容');
  }
  logger.info({ targetVersion }, '切换 PG 版本');
  await ensureInstalled(targetVersion);
}
```

### pg-installer.test.ts 完整实现

```ts
// src/main/infra/pg/pg-installer.test.ts
// pg-installer 单元测试
//
// 测试策略：
// 1. vi.mock('node:fs') 替换 existsSync
// 2. vi.mock('node:child_process') 替换 spawn
// 3. vi.mock('../../config') 替换 getAppConfig
// 4. vi.mock('../storage/app-data') 替换 getUserDataPath
// 5. vi.mock('electron') 替换 app

import { AppError } from '@novel-writer/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock 依赖
const mockExistsSync = vi.fn();
const mockSpawn = vi.fn();

vi.mock('node:fs', () => ({
  existsSync: mockExistsSync,
}));
vi.mock('node:child_process', () => ({
  spawn: mockSpawn,
}));
vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: vi.fn().mockReturnValue('C:/userData'),
  },
}));

const { getAppConfig, resetConfigCache } = await import('../../config/index');
const {
  ensureInstalled,
  getPgBinaryPath,
  getPgDataDir,
  initdb,
  isPgInitialized,
  switchVersion,
} = await import('./pg-installer');

// Mock child process 工厂
function createMockChild(exitCode: number = 0) {
  const handlers: Record<string, (...args: unknown[]) => void> = {};
  return {
    stdout: { on: (event: string, cb: (...args: unknown[]) => void) => { handlers.stdout = cb; } },
    stderr: { on: (event: string, cb: (...args: unknown[]) => void) => { handlers.stderr = cb; } },
    on: (event: string, cb: (...args: unknown[]) => void) => { handlers[event] = cb; },
    kill: vi.fn(),
    pid: 12345,
    // 触发事件
    emit: (event: string, ...args: unknown[]) => handlers[event]?.(...args),
    emitStderr: (text: string) => handlers.stderr?.(Buffer.from(text)),
    emitExit: (code: number, signal: string | null = null) => handlers.exit?.(code, signal),
  };
}

describe('pg-installer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReset();
    mockSpawn.mockReset();
    resetConfigCache();
    delete process.env.PG_VERSION;
    delete process.env.PG_RESOURCES_DIR;
  });

  afterEach(() => {
    resetConfigCache();
  });

  describe('getPgBinaryPath', () => {
    it('dev 环境应返回 "postgres"（系统 PATH）', () => {
      const config = getAppConfig();
      expect(config.isDev).toBe(true);
      expect(getPgBinaryPath()).toBe('postgres');
    });

    it('应接受版本参数', () => {
      // dev 环境始终返回 'postgres'，但不应抛错
      expect(getPgBinaryPath('17.10')).toBe('postgres');
    });
  });

  describe('getPgDataDir', () => {
    it('应返回 userData 下的 pgdata-<version> 路径', () => {
      const path = getPgDataDir();
      expect(path).toContain('pgdata-18.4');
    });

    it('应根据版本参数返回不同路径', () => {
      const path = getPgDataDir('17.10');
      expect(path).toContain('pgdata-17.10');
    });
  });

  describe('isPgInitialized', () => {
    it('数据目录存在 PG_VERSION 文件应返回 true', () => {
      mockExistsSync.mockReturnValue(true);
      expect(isPgInitialized()).toBe(true);
      expect(mockExistsSync).toHaveBeenCalledWith(
        expect.stringContaining('PG_VERSION'),
      );
    });

    it('数据目录不存在 PG_VERSION 文件应返回 false', () => {
      mockExistsSync.mockReturnValue(false);
      expect(isPgInitialized()).toBe(false);
    });
  });

  describe('initdb', () => {
    it('应成功执行 initdb（exit code 0）', async () => {
      const child = createMockChild();
      mockSpawn.mockReturnValue(child);

      const promise = initdb();
      child.emitExit(0);

      await expect(promise).resolves.toBeUndefined();
      expect(mockSpawn).toHaveBeenCalled();
    });

    it('initdb 失败（非 0 退出码）应抛 AppError(PG_INIT_FAILED)', async () => {
      const child = createMockChild();
      mockSpawn.mockReturnValue(child);

      const promise = initdb();
      child.emitStderr('permission denied');
      child.emitExit(1);

      await expect(promise).rejects.toThrow(AppError);
      await expect(promise).catch((err: AppError) => {
        expect(err.code).toBe('PG_INIT_FAILED');
      });
    });

    it('initdb 进程错误应抛 AppError(PG_INIT_FAILED)', async () => {
      const child = createMockChild();
      mockSpawn.mockReturnValue(child);

      const promise = initdb();
      // 模拟进程 spawn 失败
      const handlers: Record<string, (...args: unknown[]) => void> = {};
      child.on = (event: string, cb: (...args: unknown[]) => void) => { handlers[event] = cb; };
      handlers.error?.(new Error('ENOENT'));

      await expect(promise).rejects.toThrow(AppError);
    });
  });

  describe('ensureInstalled', () => {
    it('已初始化时应跳过 initdb', async () => {
      mockExistsSync.mockReturnValue(true);
      await ensureInstalled();
      expect(mockSpawn).not.toHaveBeenCalled();
    });

    it('未初始化时应调用 initdb', async () => {
      mockExistsSync.mockReturnValue(false);
      const child = createMockChild();
      mockSpawn.mockReturnValue(child);

      const promise = ensureInstalled();
      child.emitExit(0);

      await expect(promise).resolves.toBeUndefined();
      expect(mockSpawn).toHaveBeenCalled();
    });
  });

  describe('switchVersion', () => {
    it('切换到 17.10 应确保该版本数据目录已初始化', async () => {
      mockExistsSync.mockReturnValue(true);
      await switchVersion('17.10');
      // 应检查 pgdata-17.10/PG_VERSION
      expect(mockExistsSync).toHaveBeenCalledWith(
        expect.stringContaining('pgdata-17.10'),
      );
    });
  });
});
```

### Steps

- [ ] **Step 1: 创建 packages/shared/src/constants/age.ts**

写入上述 AGE 常量代码。

- [ ] **Step 2: 在 packages/shared/src/index.ts 导出 AGE 常量**

追加 `export * from './constants/age';`

- [ ] **Step 3: 修改 src/main/config/index.ts PgConfigSchema**

读取现有 `f:\TraeProjects\1\src\main\config\index.ts`，在 `PgConfigSchema` 中新增 `version` / `resourcesDir` / `initdbTimeout` 字段。在 `loadConfig()` 中新增对应读取：
```ts
version: process.env.PG_VERSION ?? POSTGRES_VERSIONS.V18_4,
resourcesDir: process.env.PG_RESOURCES_DIR ?? '',
initdbTimeout: Number(process.env.PG_INITDB_TIMEOUT ?? 60_000),
```

- [ ] **Step 4: 修改 src/main/__tests__/config.test.ts 补充 pg 新字段测试**

在 `describe('AppConfig - pg', ...)` 中追加 2 个测试：
- `应使用默认 version 与 initdbTimeout`
- `应从环境变量读取 version 与 initdbTimeout`

- [ ] **Step 5: 运行 config 测试验证**

Run: `pnpm test:main -- config.test.ts`
Expected: 既有 + 2 个新测试通过

- [ ] **Step 6: 创建 pg-installer.ts**

写入上述 pg-installer.ts 完整实现。

- [ ] **Step 7: 创建 pg-installer.test.ts**

写入上述 pg-installer.test.ts 完整实现。

- [ ] **Step 8: 运行 pg-installer 测试**

Run: `pnpm test:main -- pg-installer.test.ts`
Expected: 所有测试通过（约 10 个测试）

- [ ] **Step 9: 运行 typecheck**

Run: `pnpm typecheck`
Expected: 0 errors

- [ ] **Step 10: 运行 lint**

Run: `pnpm lint`
Expected: 0 errors

- [ ] **Step 11: 运行全部测试**

Run: `pnpm test`
Expected: 全部通过（118 + 2 config + ~10 installer = ~130 测试）

- [ ] **Step 12: 提交**

```powershell
git add packages/shared/src/constants/age.ts packages/shared/src/index.ts src/main/infra/pg/pg-installer.ts src/main/infra/pg/pg-installer.test.ts src/main/config/index.ts src/main/__tests__/config.test.ts
git commit -m "feat(pg): 实现 pg-installer 模块与 AGE 常量" -m "设计文档 §6.3 + §6.5 AGE 兼容性策略"
```

---

## Task 2: AGE 扩展管理器（CREATE EXTENSION + LOAD + Cypher 透传）

**Files:**
- Create: `f:\TraeProjects\1\src\main\infra\prisma\extensions\age.ts`
- Create: `f:\TraeProjects\1\src\main\infra\prisma\extensions\age.test.ts`

### age.ts 完整实现

```ts
// src/main/infra/prisma/extensions/age.ts
// Apache AGE 扩展管理器（设计文档 §6.3 + §6.5）
//
// 职责：
// 1. CREATE EXTENSION age + LOAD 'age' + SET search_path
// 2. 创建 Graph（ag_catalog.create_graph）
// 3. 提供 Cypher 透传 API（executeCypher / queryCypher）
// 4. AGE 加载失败时返回 false（由调用方决定是否降级 PG 版本）
//
// 注意：
// - Cypher 语句通过 ag_catalog.cypher() 函数包裹，返回 SETOF record
// - 必须用 Prisma $executeRawUnsafe / $queryRawUnsafe（Prisma 不原生支持 Cypher）
// - ag_catalog.create_graph 是幂等的（已存在则报 NOTICE 不抛错）

import { PrismaClient } from '@prisma/client';
import { AGE_GRAPH_NAME } from '@novel-writer/shared';
import { logger } from '../../../utils/logger';

/**
 * AGE Graph 初始化 SQL（设计文档 §6.3）
 *
 * - CREATE EXTENSION IF NOT EXISTS age（幂等）
 * - LOAD 'age'（每个会话需重新 LOAD，但 Prisma 连接池中只执行一次足够）
 * - SET search_path（让 ag_catalog.cypher 函数可直接调用）
 */
const AGE_INIT_SQL = `
  CREATE EXTENSION IF NOT EXISTS age;
  LOAD 'age';
  SET search_path = ag_catalog, "$user", public;
`;

/**
 * 创建 Graph SQL（若已存在则 NOTICE 不抛错）
 *
 * ag_catalog.create_graph 第二参数是 Graph 名
 */
const CREATE_GRAPH_SQL = `SELECT ag_catalog.create_graph('${AGE_GRAPH_NAME}');`;

/**
 * 加载 AGE 扩展并初始化 Graph
 *
 * @returns true 成功；false 失败（AGE 不兼容当前 PG 版本）
 */
export async function ensureAgeExtension(client: PrismaClient): Promise<boolean> {
  try {
    logger.info({}, '加载 Apache AGE 扩展');
    await client.$executeRawUnsafe(AGE_INIT_SQL);
    await client.$executeRawUnsafe(CREATE_GRAPH_SQL);
    logger.info({ graph: AGE_GRAPH_NAME }, 'AGE 扩展加载完成，Graph 已创建');
    return true;
  } catch (err) {
    logger.warn(
      { error: err instanceof Error ? err.message : String(err) },
      'AGE 扩展加载失败（可能 PG 版本不兼容）',
    );
    return false;
  }
}

/**
 * 执行 Cypher 写操作（无返回值）
 *
 * @param cypher Cypher 语句（不含 ag_catalog.cypher 包裹）
 *
 * @example
 * ```ts
 * await executeCypher(client, `
 *   CREATE (n:Character {characterId: 'abc', name: '主角', role: 'PROTAGONIST'})
 * `);
 * ```
 */
export async function executeCypher(
  client: PrismaClient,
  cypher: string,
): Promise<number> {
  // ag_catalog.cypher 第二参数是 Cypher 字符串
  // 返回 SETOF record，但 CREATE/DELETE/MERGE 等写操作不需要 RETURNING
  const sql = `SELECT * FROM ag_catalog.cypher('${AGE_GRAPH_NAME}', $$ ${cypher} $$) AS (result agtype);`;
  return client.$executeRawUnsafe(sql);
}

/**
 * 查询 Cypher 返回结果
 *
 * @param cypher Cypher 语句（含 RETURNING）
 * @returns 查询结果数组（agtype 类型）
 *
 * @example
 * ```ts
 * const results = await queryCypher(client, `
 *   MATCH (n:Character) RETURN n.characterId, n.name
 * `);
 * ```
 */
export async function queryCypher<T = unknown>(
  client: PrismaClient,
  cypher: string,
): Promise<T[]> {
  const sql = `SELECT * FROM ag_catalog.cypher('${AGE_GRAPH_NAME}', $$ ${cypher} $$) AS (result agtype);`;
  const rows = await client.$queryRawUnsafe<T[]>(sql);
  return rows;
}

/**
 * 创建 Character 顶点（便捷方法）
 *
 * @param characterId Character 表 id
 * @param name 角色名
 * @param role 角色定位
 */
export async function createCharacterVertex(
  client: PrismaClient,
  params: { characterId: string; name: string; role: string },
): Promise<number> {
  const cypher = `CREATE (n:Character {characterId: '${params.characterId}', name: '${params.name}', role: '${params.role}'})`;
  return executeCypher(client, cypher);
}

/**
 * 创建 RELATION 边（便捷方法）
 *
 * @param fromCharacterId 起始角色 id
 * @param toCharacterId 目标角色 id
 * @param type 关系类型（如 'friend', 'enemy', 'mentor'）
 * @param description 关系描述
 * @param chapterId 关联章节 id
 */
export async function createRelationEdge(
  client: PrismaClient,
  params: {
    fromCharacterId: string;
    toCharacterId: string;
    type: string;
    description?: string;
    chapterId?: string;
  },
): Promise<number> {
  const props = [
    `type: '${params.type}'`,
    params.description ? `description: '${params.description}'` : '',
    params.chapterId ? `chapterId: '${params.chapterId}'` : '',
  ]
    .filter(Boolean)
    .join(', ');

  // 先 MATCH 两个顶点，再 CREATE 关系
  const cypher = `
    MATCH (a:Character {characterId: '${params.fromCharacterId}'}),
          (b:Character {characterId: '${params.toCharacterId}'})
    CREATE (a)-[r:RELATION {${props}}]->(b)
  `;
  return executeCypher(client, cypher);
}
```

### age.test.ts 完整实现

```ts
// src/main/infra/prisma/extensions/age.test.ts
// AGE 扩展管理器单元测试

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock PrismaClient
const mockPrisma = {
  $executeRawUnsafe: vi.fn().mockResolvedValue(1),
  $queryRawUnsafe: vi.fn().mockResolvedValue([]),
};

vi.mock('@prisma/client', () => ({
  // biome-ignore lint/complexity/useArrowFunction: 需要 [[Construct]] 调用
  PrismaClient: vi.fn(function () {
    return mockPrisma;
  }),
}));

const {
  createCharacterVertex,
  createRelationEdge,
  ensureAgeExtension,
  executeCypher,
  queryCypher,
} = await import('./age');

describe('AGE 扩展管理器', () => {
  beforeEach(() => {
    mockPrisma.$executeRawUnsafe.mockClear();
    mockPrisma.$queryRawUnsafe.mockClear();
    mockPrisma.$executeRawUnsafe.mockResolvedValue(1);
    mockPrisma.$queryRawUnsafe.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('ensureAgeExtension', () => {
    it('加载成功应返回 true', async () => {
      const result = await ensureAgeExtension(mockPrisma as never);
      expect(result).toBe(true);
      expect(mockPrisma.$executeRawUnsafe).toHaveBeenCalledTimes(2);
    });

    it('加载失败应返回 false（不抛错）', async () => {
      mockPrisma.$executeRawUnsafe.mockRejectedValueOnce(new Error('AGE not compatible'));
      const result = await ensureAgeExtension(mockPrisma as never);
      expect(result).toBe(false);
    });
  });

  describe('executeCypher', () => {
    it('应正确包裹 Cypher 语句并调用 $executeRawUnsafe', async () => {
      await executeCypher(mockPrisma as never, 'CREATE (n:Character {name: "test"})');
      expect(mockPrisma.$executeRawUnsafe).toHaveBeenCalledWith(
        expect.stringContaining('ag_catalog.cypher'),
      );
      expect(mockPrisma.$executeRawUnsafe).toHaveBeenCalledWith(
        expect.stringContaining('CREATE (n:Character {name: "test"})'),
      );
    });

    it('应使用 novel_graph 作为 Graph 名', async () => {
      await executeCypher(mockPrisma as never, 'RETURN 1');
      const sqlArg = mockPrisma.$executeRawUnsafe.mock.calls[0]?.[0] as string;
      expect(sqlArg).toContain("'novel_graph'");
    });

    it('应返回受影响行数', async () => {
      mockPrisma.$executeRawUnsafe.mockResolvedValueOnce(42);
      const result = await executeCypher(mockPrisma as never, 'CREATE (n:Test)');
      expect(result).toBe(42);
    });
  });

  describe('queryCypher', () => {
    it('应正确包裹 Cypher 语句并调用 $queryRawUnsafe', async () => {
      await queryCypher(mockPrisma as never, 'MATCH (n) RETURN n');
      expect(mockPrisma.$queryRawUnsafe).toHaveBeenCalledWith(
        expect.stringContaining('ag_catalog.cypher'),
      );
    });

    it('应返回查询结果数组', async () => {
      const mockRows = [{ result: 'data1' }, { result: 'data2' }];
      mockPrisma.$queryRawUnsafe.mockResolvedValueOnce(mockRows);
      const result = await queryCypher(mockPrisma as never, 'MATCH (n) RETURN n');
      expect(result).toEqual(mockRows);
    });
  });

  describe('createCharacterVertex', () => {
    it('应创建 Character 顶点', async () => {
      await createCharacterVertex(mockPrisma as never, {
        characterId: 'c1',
        name: '主角',
        role: 'PROTAGONIST',
      });
      const sqlArg = mockPrisma.$executeRawUnsafe.mock.calls[0]?.[0] as string;
      expect(sqlArg).toContain(':Character');
      expect(sqlArg).toContain("characterId: 'c1'");
      expect(sqlArg).toContain("name: '主角'");
      expect(sqlArg).toContain("role: 'PROTAGONIST'");
    });
  });

  describe('createRelationEdge', () => {
    it('应创建 RELATION 边（含 description 与 chapterId）', async () => {
      await createRelationEdge(mockPrisma as never, {
        fromCharacterId: 'c1',
        toCharacterId: 'c2',
        type: 'friend',
        description: '好友',
        chapterId: 'ch1',
      });
      const sqlArg = mockPrisma.$executeRawUnsafe.mock.calls[0]?.[0] as string;
      expect(sqlArg).toContain('MATCH (a:Character {characterId: \'c1\'})');
      expect(sqlArg).toContain('MATCH (b:Character {characterId: \'c2\'})');
      expect(sqlArg).toContain(':RELATION');
      expect(sqlArg).toContain("type: 'friend'");
      expect(sqlArg).toContain("description: '好友'");
      expect(sqlArg).toContain("chapterId: 'ch1'");
    });

    it('应创建 RELATION 边（仅 type 必填）', async () => {
      await createRelationEdge(mockPrisma as never, {
        fromCharacterId: 'c1',
        toCharacterId: 'c2',
        type: 'enemy',
      });
      const sqlArg = mockPrisma.$executeRawUnsafe.mock.calls[0]?.[0] as string;
      expect(sqlArg).toContain("type: 'enemy'");
      expect(sqlArg).not.toContain('description');
      expect(sqlArg).not.toContain('chapterId');
    });
  });
});
```

### Steps

- [ ] **Step 1: 创建 age.ts**

写入上述 age.ts 完整实现到 `f:\TraeProjects\1\src\main\infra\prisma\extensions\age.ts`。

- [ ] **Step 2: 创建 age.test.ts**

写入上述 age.test.ts 完整实现到 `f:\TraeProjects\1\src\main\infra\prisma\extensions\age.test.ts`。

- [ ] **Step 3: 运行测试**

Run: `pnpm test:main -- extensions/age.test.ts`
Expected: 所有测试通过（约 10 个测试）

- [ ] **Step 4: 运行 typecheck**

Run: `pnpm typecheck`
Expected: 0 errors

- [ ] **Step 5: 运行 lint**

Run: `pnpm lint`
Expected: 0 errors

- [ ] **Step 6: 运行全部测试**

Run: `pnpm test`
Expected: 全部通过

- [ ] **Step 7: 提交**

```powershell
git add src/main/infra/prisma/extensions/age.ts src/main/infra/prisma/extensions/age.test.ts
git commit -m "feat(prisma): 实现 Apache AGE 扩展加载与 Cypher 透传" -m "设计文档 §6.3 + §6.5"
```

---

## Task 3: HNSW 索引初始化（pg_trgm + HNSW + 复合索引）

**Files:**
- Create: `f:\TraeProjects\1\src\main\infra\prisma\extensions\hnsw.ts`
- Create: `f:\TraeProjects\1\src\main\infra\prisma\extensions\hnsw.test.ts`

### hnsw.ts 完整实现

```ts
// src/main/infra/prisma\extensions/hnsw.ts
// HNSW 向量索引 + pg_trgm 全文索引初始化（设计文档 §6.4）
//
// 职责：
// 1. CREATE EXTENSION pgvector（已由 migration.sql 幂等创建，此处不重复）
// 2. CREATE EXTENSION pg_trgm（章节内容 GIN 索引）
// 3. 创建 HNSW 索引（halfvec(2048) + m=16 + ef_construction=64）
// 4. 创建章节内容 trgm 索引（相似度搜索）
// 5. 创建章节复合索引（project_id + sort_order）
//
// 注意：
// - HNSW 索引在 migration 之后创建（Prisma 不支持 halfvec 类型 DDL）
// - 索引创建幂等（IF NOT EXISTS）
// - 大表创建 HNSW 索引可能耗时，生产环境应在用户引导下执行

import { PrismaClient } from '@prisma/client';
import { logger } from '../../../utils/logger';

/**
 * 创建 pg_trgm 扩展（章节内容相似度搜索）
 */
const CREATE_PG_TRGM_SQL = 'CREATE EXTENSION IF NOT EXISTS pg_trgm;';

/**
 * HNSW 索引 SQL（设计文档 §6.4）
 *
 * - halfvec(2048) + 余弦距离
 * - m=16（每个节点的最大连接数）
 * - ef_construction=64（构建时搜索宽度）
 */
const CREATE_HNSW_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_rag_chunks_embedding
    ON rag_document_chunks
    USING hnsw (embedding halfvec_cosine_ops)
    WITH (m = 16, ef_construction = 64);
`;

/**
 * 章节内容 GIN trgm 索引（相似度搜索）
 */
const CREATE_CONTENT_TRGM_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_chapters_content_trgm
    ON chapters USING gin (content gin_trgm_ops);
`;

/**
 * 章节复合索引（项目列表排序）
 */
const CREATE_CHAPTERS_PROJECT_ORDER_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_chapters_project_order
    ON chapters (project_id, sort_order);
`;

/**
 * 索引初始化状态
 *
 * 避免每次应用启动都执行 CREATE INDEX（IF NOT EXISTS 仍会有 SQL 往返）
 */
let isInitialized = false;

/**
 * 初始化所有索引
 *
 * 顺序：
 * 1. pg_trgm 扩展
 * 2. HNSW 向量索引
 * 3. trgm 全文索引
 * 4. 章节复合索引
 *
 * @throws Error 索引创建失败（HNSW 在大数据量时可能耗时/失败）
 */
export async function ensureHnswIndex(client: PrismaClient): Promise<void> {
  if (isInitialized) {
    logger.debug({}, 'HNSW 索引已初始化，跳过');
    return;
  }

  logger.info({}, '初始化向量索引与全文索引');

  await client.$executeRawUnsafe(CREATE_PG_TRGM_SQL);
  logger.info({}, 'pg_trgm 扩展已就绪');

  await client.$executeRawUnsafe(CREATE_HNSW_INDEX_SQL);
  logger.info({}, 'HNSW 向量索引已就绪（halfvec(2048), m=16, ef_construction=64）');

  await client.$executeRawUnsafe(CREATE_CONTENT_TRGM_INDEX_SQL);
  logger.info({}, 'chapters.content trgm 索引已就绪');

  await client.$executeRawUnsafe(CREATE_CHAPTERS_PROJECT_ORDER_INDEX_SQL);
  logger.info({}, 'chapters(project_id, sort_order) 复合索引已就绪');

  isInitialized = true;
  logger.info({}, '索引初始化完成');
}

/**
 * 重置初始化状态（仅测试用）
 */
export function resetHnswIndexState(): void {
  isInitialized = false;
}
```

### hnsw.test.ts 完整实现

```ts
// src/main/infra/prisma/extensions/hnsw.test.ts
// HNSW 索引初始化单元测试

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockPrisma = {
  $executeRawUnsafe: vi.fn().mockResolvedValue(1),
};

vi.mock('@prisma/client', () => ({
  // biome-ignore lint/complexity/useArrowFunction: 需要 [[Construct]] 调用
  PrismaClient: vi.fn(function () {
    return mockPrisma;
  }),
}));

const { ensureHnswIndex, resetHnswIndexState } = await import('./hnsw');

describe('HNSW 索引初始化', () => {
  beforeEach(() => {
    mockPrisma.$executeRawUnsafe.mockClear();
    mockPrisma.$executeRawUnsafe.mockResolvedValue(1);
    resetHnswIndexState();
  });

  afterEach(() => {
    resetHnswIndexState();
  });

  it('应按顺序创建 pg_trgm + HNSW + trgm + 复合索引', async () => {
    await ensureHnswIndex(mockPrisma as never);

    // 应执行 4 个 $executeRawUnsafe 调用
    expect(mockPrisma.$executeRawUnsafe).toHaveBeenCalledTimes(4);

    // 验证顺序
    const calls = mockPrisma.$executeRawUnsafe.mock.calls.map((c) => c[0] as string);
    expect(calls[0]).toContain('CREATE EXTENSION IF NOT EXISTS pg_trgm');
    expect(calls[1]).toContain('USING hnsw');
    expect(calls[1]).toContain('halfvec_cosine_ops');
    expect(calls[1]).toContain('m = 16');
    expect(calls[1]).toContain('ef_construction = 64');
    expect(calls[2]).toContain('idx_chapters_content_trgm');
    expect(calls[2]).toContain('gin_trgm_ops');
    expect(calls[3]).toContain('idx_chapters_project_order');
    expect(calls[3]).toContain('project_id, sort_order');
  });

  it('HNSW 索引名应为 idx_rag_chunks_embedding', async () => {
    await ensureHnswIndex(mockPrisma as never);
    const hnswCall = mockPrisma.$executeRawUnsafe.mock.calls[1]?.[0] as string;
    expect(hnswCall).toContain('idx_rag_chunks_embedding');
  });

  it('已初始化时应跳过（幂等）', async () => {
    await ensureHnswIndex(mockPrisma as never);
    await ensureHnswIndex(mockPrisma as never);

    // 第二次调用应跳过，总共只 4 次调用
    expect(mockPrisma.$executeRawUnsafe).toHaveBeenCalledTimes(4);
  });

  it('resetHnswIndexState 应重置初始化状态', async () => {
    await ensureHnswIndex(mockPrisma as never);
    expect(mockPrisma.$executeRawUnsafe).toHaveBeenCalledTimes(4);

    resetHnswIndexState();
    await ensureHnswIndex(mockPrisma as never);
    expect(mockPrisma.$executeRawUnsafe).toHaveBeenCalledTimes(8);
  });

  it('索引创建失败应抛错', async () => {
    mockPrisma.$executeRawUnsafe.mockRejectedValueOnce(new Error('halfvec type not found'));
    await expect(ensureHnswIndex(mockPrisma as never)).rejects.toThrow('halfvec type not found');
  });
});
```

### Steps

- [ ] **Step 1: 创建 hnsw.ts**

写入上述 hnsw.ts 完整实现到 `f:\TraeProjects\1\src\main\infra\prisma\extensions\hnsw.ts`。

- [ ] **Step 2: 创建 hnsw.test.ts**

写入上述 hnsw.test.ts 完整实现到 `f:\TraeProjects\1\src\main\infra\prisma\extensions\hnsw.test.ts`。

- [ ] **Step 3: 运行测试**

Run: `pnpm test:main -- extensions/hnsw.test.ts`
Expected: 所有测试通过（5 个测试）

- [ ] **Step 4: 运行 typecheck**

Run: `pnpm typecheck`
Expected: 0 errors

- [ ] **Step 5: 运行 lint**

Run: `pnpm lint`
Expected: 0 errors

- [ ] **Step 6: 运行全部测试**

Run: `pnpm test`
Expected: 全部通过

- [ ] **Step 7: 提交**

```powershell
git add src/main/infra/prisma/extensions/hnsw.ts src/main/infra/prisma/extensions/hnsw.test.ts
git commit -m "feat(prisma): 实现 HNSW 向量索引与全文索引初始化" -m "设计文档 §6.4"
```

---

## Task 4: 集成 PG 启动 + DB 初始化到 main/index.ts

**Files:**
- Modify: `f:\TraeProjects\1\src\main\index.ts`（集成启动 + 退出流程）
- Modify: `f:\TraeProjects\1\src\main\config\index.ts`（pg 配置块新增 binaryPath 与 resourcesDir 自动派生）
- Create: `f:\TraeProjects\1\src\main\app\db-init.ts`（DB 初始化编排）
- Create: `f:\TraeProjects\1\src\main\app\db-init.test.ts`

### db-init.ts 完整实现

```ts
// src/main/app/db-init.ts
// 数据库初始化编排（设计文档 §1.1 + §6.5 AGE 兼容性策略）
//
// 职责：
// 1. 编排 PG 启动 + DB 初始化流程
// 2. AGE 加载失败时降级 PG 版本
// 3. 串联 pg-installer / pg-controller / Prisma migrate / AGE / HNSW
//
// 启动顺序：
//   ensureInstalled(18.4) → pgController.start → testPrismaConnection
//   → prisma migrate deploy → ensureAgeExtension
//   → 失败则 switchVersion(17.10) + 重启 PG + 重新 AGE
//   → ensureHnswIndex
//
// 注意：本模块不直接被 index.ts 调用，由 index.ts 在 whenReady 中调用

import { POSTGRES_VERSIONS } from '@novel-writer/shared';
import { PgController } from '../infra/pg/pg-controller';
import {
  ensureAgeExtension,
} from '../infra/prisma/extensions/age';
import { ensureHnswIndex } from '../infra/prisma/extensions/hnsw';
import {
  ensureInstalled,
  getPgBinaryPath,
  getPgDataDir,
  switchVersion,
} from '../infra/pg/pg-installer';
import { disconnectPrisma, getPrismaClient, testPrismaConnection } from '../infra/prisma/client';
import { getAppConfig } from '../config';
import { logger } from '../utils/logger';

/** PG 控制器单例 */
let pgController: PgController | null = null;

/**
 * 创建 PgController 实例
 *
 * 根据配置生成 binaryPath 与 dataDir
 */
function createPgController(version: string): PgController {
  const config = getAppConfig();
  return new PgController({
    binaryPath: getPgBinaryPath(version),
    dataDir: getPgDataDir(version),
    port: config.pg.port,
  });
}

/**
 * 初始化数据库
 *
 * 完整流程：
 * 1. 确保数据目录已初始化（initdb）
 * 2. 启动 PG 子进程
 * 3. 测试 PrismaClient 连接
 * 4. 执行 Prisma migration（deploy 模式）
 * 5. 加载 AGE 扩展（失败降级到 PG 17.10）
 * 6. 初始化 HNSW 索引
 *
 * @throws AppError 任何阶段失败
 */
export async function initializeDatabase(): Promise<void> {
  const defaultVersion = POSTGRES_VERSIONS.V18_4;
  logger.info({ version: defaultVersion }, '初始化数据库');

  // 1. initdb
  await ensureInstalled(defaultVersion);

  // 2. 启动 PG
  pgController = createPgController(defaultVersion);
  await pgController.start();

  // 3. 测试连接
  await testPrismaConnection();
  logger.info({}, '数据库连接成功');

  // 4. 执行 migration（通过 Prisma CLI）
  // 注：Prisma 7 推荐用 prisma migrate deploy 在生产环境执行
  // 这里通过 child_process 调用，因为 Prisma client 不直接暴露 migrate API
  await runMigrateDeploy();

  // 5. 加载 AGE 扩展（失败降级）
  const client = getPrismaClient();
  const ageOk = await ensureAgeExtension(client);
  if (!ageOk) {
    logger.warn({}, 'AGE 在 PG 18.4 上加载失败，触发降级流程');
    await downgradeForAge();
  }

  // 6. 初始化 HNSW 索引
  await ensureHnswIndex(client);

  logger.info({}, '数据库初始化完成');
}

/**
 * AGE 降级流程（设计文档 §6.5）
 *
 * 1. 停止当前 PG
 * 2. 切换到 PG 17.10（确保数据目录已初始化）
 * 3. 重启 PG
 * 4. 重新加载 AGE 扩展
 */
async function downgradeForAge(): Promise<void> {
  if (pgController === null) {
    throw new Error('PG 控制器未初始化');
  }

  // 1. 停止当前 PG
  await pgController.stop();
  await disconnectPrisma();

  // 2. 切换到 PG 17.10
  const fallbackVersion = POSTGRES_VERSIONS.V17_10;
  await switchVersion(fallbackVersion);

  // 3. 重启 PG
  pgController = createPgController(fallbackVersion);
  await pgController.start();
  await testPrismaConnection();

  // 4. 重新加载 AGE
  const client = getPrismaClient();
  const ageOk = await ensureAgeExtension(client);
  if (!ageOk) {
    logger.error({}, 'AGE 在 PG 17.10 上仍无法加载，扩展可能不兼容');
    throw new Error('Apache AGE 扩展加载失败');
  }
  logger.info({ version: fallbackVersion }, 'AGE 降级完成');
}

/**
 * 执行 prisma migrate deploy
 *
 * 通过 child_process 调用 prisma CLI（Prisma 7 不在 client 中暴露 migrate API）
 */
async function runMigrateDeploy(): Promise<void> {
  const { spawn } = await import('node:child_process');
  logger.info({}, '执行 prisma migrate deploy');

  return new Promise<void>((resolve, reject) => {
    const child = spawn('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: process.cwd(),
    });

    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      logger.debug({}, `prisma migrate: ${chunk.toString().trim()}`);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim();
      stderr += text;
      logger.warn({}, `prisma migrate stderr: ${text}`);
    });

    child.on('exit', (code) => {
      if (code === 0) {
        logger.info({}, 'prisma migrate deploy 完成');
        resolve();
      } else {
        reject(new Error(`prisma migrate deploy 失败（code=${code}）: ${stderr}`));
      }
    });

    child.on('error', (err) => {
      reject(new Error(`prisma migrate deploy 进程错误: ${err.message}`));
    });
  });
}

/**
 * 关闭数据库
 *
 * 应用退出时调用：
 * 1. 断开 PrismaClient
 * 2. 停止 PG 子进程
 */
export async function shutdownDatabase(): Promise<void> {
  await disconnectPrisma();
  if (pgController !== null) {
    await pgController.stop();
    pgController = null;
  }
}

/**
 * 获取 PG 控制器（仅用于测试与状态查询）
 */
export function getPgController(): PgController | null {
  return pgController;
}
```

### db-init.test.ts 完整实现

```ts
// src/main/app/db-init.test.ts
// 数据库初始化编排单元测试
//
// 测试策略：
// 1. vi.mock 所有 infra 模块
// 2. 验证 initializeDatabase 调用顺序
// 3. 验证 AGE 降级流程
// 4. 不实际启动 PG

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock 所有依赖模块
const mockEnsureInstalled = vi.fn().mockResolvedValue(undefined);
const mockSwitchVersion = vi.fn().mockResolvedValue(undefined);
const mockGetPgBinaryPath = vi.fn().mockReturnValue('postgres');
const mockGetPgDataDir = vi.fn().mockReturnValue('/tmp/pgdata');

const mockPgController = {
  start: vi.fn().mockResolvedValue(undefined),
  stop: vi.fn().mockResolvedValue(undefined),
};

const mockTestPrismaConnection = vi.fn().mockResolvedValue(true);
const mockDisconnectPrisma = vi.fn().mockResolvedValue(undefined);
const mockGetPrismaClient = vi.fn().mockReturnValue({});

const mockEnsureAgeExtension = vi.fn().mockResolvedValue(true);
const mockEnsureHnswIndex = vi.fn().mockResolvedValue(undefined);

vi.mock('../infra/pg/pg-installer', () => ({
  ensureInstalled: mockEnsureInstalled,
  switchVersion: mockSwitchVersion,
  getPgBinaryPath: mockGetPgBinaryPath,
  getPgDataDir: mockGetPgDataDir,
}));

vi.mock('../infra/pg/pg-controller', () => ({
  PgController: vi.fn(function () {
    return mockPgController;
  }),
}));

vi.mock('../infra/prisma/client', () => ({
  testPrismaConnection: mockTestPrismaConnection,
  disconnectPrisma: mockDisconnectPrisma,
  getPrismaClient: mockGetPrismaClient,
}));

vi.mock('../infra/prisma/extensions/age', () => ({
  ensureAgeExtension: mockEnsureAgeExtension,
}));

vi.mock('../infra/prisma/extensions/hnsw', () => ({
  ensureHnswIndex: mockEnsureHnswIndex,
}));

// Mock child_process（避免实际 spawn prisma）
vi.mock('node:child_process', () => ({
  spawn: vi.fn(function () {
    const handlers: Record<string, (...args: unknown[]) => void> = {};
    return {
      stdout: { on: (_e: string, cb: (...args: unknown[]) => void) => { handlers.stdout = cb; } },
      stderr: { on: (_e: string, cb: (...args: unknown[]) => void) => { handlers.stderr = cb; } },
      on: (event: string, cb: (...args: unknown[]) => void) => { handlers[event] = cb; },
      kill: vi.fn(),
      pid: 99999,
    };
  }),
}));

const { initializeDatabase, shutdownDatabase, getPgController } = await import('./db-init');

describe('数据库初始化编排', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnsureInstalled.mockResolvedValue(undefined);
    mockSwitchVersion.mockResolvedValue(undefined);
    mockPgController.start.mockResolvedValue(undefined);
    mockPgController.stop.mockResolvedValue(undefined);
    mockTestPrismaConnection.mockResolvedValue(true);
    mockEnsureAgeExtension.mockResolvedValue(true);
    mockEnsureHnswIndex.mockResolvedValue(undefined);
    mockDisconnectPrisma.mockResolvedValue(undefined);
    mockGetPgBinaryPath.mockReturnValue('postgres');
    mockGetPgDataDir.mockReturnValue('/tmp/pgdata');
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('initializeDatabase', () => {
    it('成功流程应按顺序调用所有步骤', async () => {
      await initializeDatabase();

      // 1. initdb
      expect(mockEnsureInstalled).toHaveBeenCalledWith('18.4');
      // 2. pgController.start
      expect(mockPgController.start).toHaveBeenCalledTimes(1);
      // 3. testPrismaConnection
      expect(mockTestPrismaConnection).toHaveBeenCalledTimes(1);
      // 4. AGE
      expect(mockEnsureAgeExtension).toHaveBeenCalledTimes(1);
      // 5. HNSW
      expect(mockEnsureHnswIndex).toHaveBeenCalledTimes(1);
    });

    it('initdb 失败应抛错并停止流程', async () => {
      mockEnsureInstalled.mockRejectedValueOnce(new Error('initdb failed'));
      await expect(initializeDatabase()).rejects.toThrow('initdb failed');
      expect(mockPgController.start).not.toHaveBeenCalled();
    });

    it('PG 启动失败应抛错', async () => {
      mockPgController.start.mockRejectedValueOnce(new Error('PG start failed'));
      await expect(initializeDatabase()).rejects.toThrow('PG start failed');
    });

    it('AGE 在 18.4 失败应触发降级流程', async () => {
      // 第一次（18.4）失败，第二次（17.10）成功
      mockEnsureAgeExtension
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true);

      await initializeDatabase();

      // 应停止旧 PG + 启动新 PG + 重新 AGE
      expect(mockPgController.stop).toHaveBeenCalledTimes(1);
      expect(mockSwitchVersion).toHaveBeenCalledWith('17.10');
      expect(mockPgController.start).toHaveBeenCalledTimes(2);
      expect(mockEnsureAgeExtension).toHaveBeenCalledTimes(2);
    });

    it('AGE 降级后仍失败应抛错', async () => {
      mockEnsureAgeExtension.mockResolvedValue(false);
      await expect(initializeDatabase()).rejects.toThrow('Apache AGE');
    });
  });

  describe('shutdownDatabase', () => {
    it('应断开 PrismaClient 并停止 PG', async () => {
      await initializeDatabase();
      await shutdownDatabase();

      expect(mockDisconnectPrisma).toHaveBeenCalledTimes(2);
      expect(mockPgController.stop).toHaveBeenCalledTimes(1);
    });

    it('未初始化时应安全返回', async () => {
      await expect(shutdownDatabase()).resolves.toBeUndefined();
    });
  });

  describe('getPgController', () => {
    it('未初始化时应返回 null', () => {
      expect(getPgController()).toBeNull();
    });

    it('初始化后应返回 controller 实例', async () => {
      await initializeDatabase();
      expect(getPgController()).toBeDefined();
      await shutdownDatabase();
    });
  });
});
```

### main/index.ts 集成修改

读取 `f:\TraeProjects\1\src\main\index.ts`，按以下步骤修改：

1. **导入** initializeDatabase / shutdownDatabase：
```ts
import { initializeDatabase, shutdownDatabase } from './app/db-init';
```

2. **修改 `app.whenReady()` 回调**：
```ts
app.whenReady().then(async () => {
  initLogger();
  registerGlobalErrorHandlers();
  logger.info({}, '应用启动');

  // 初始化数据库（initdb + PG 启动 + migration + AGE + HNSW）
  try {
    await initializeDatabase();
    logger.info({}, '数据库初始化完成');
  } catch (err) {
    logger.error({ error: err }, '数据库初始化失败，应用将退出');
    app.exit(1);
    return;
  }

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});
```

3. **修改 `before-quit` 处理**（替换 Phase 4a 的 disconnectPrisma）：
```ts
let isQuitting = false;
app.on('before-quit', async (event) => {
  if (isQuitting) {
    return;
  }
  event.preventDefault();
  isQuitting = true;
  try {
    await shutdownDatabase(); // 包含 disconnectPrisma + pgController.stop
  } catch (err) {
    logger.error({ error: err }, '应用退出清理失败');
  }
  app.exit(0);
});
```

### Steps

- [ ] **Step 1: 创建 src/main/app/db-init.ts**

写入上述 db-init.ts 完整实现。

- [ ] **Step 2: 创建 src/main/app/db-init.test.ts**

写入上述 db-init.test.ts 完整实现。

- [ ] **Step 3: 运行 db-init 测试**

Run: `pnpm test:main -- db-init.test.ts`
Expected: 所有测试通过（约 7 个测试）

- [ ] **Step 4: 修改 src/main/index.ts**

按上述集成方案修改 `app.whenReady()` 与 `before-quit`。

- [ ] **Step 5: 运行 typecheck**

Run: `pnpm typecheck`
Expected: 0 errors

- [ ] **Step 6: 运行 lint**

Run: `pnpm lint`
Expected: 0 errors

- [ ] **Step 7: 运行全部测试**

Run: `pnpm test`
Expected: 全部通过

- [ ] **Step 8: 运行 build**

Run: `pnpm build`
Expected: 三入口产物生成

- [ ] **Step 9: 提交**

```powershell
git add src/main/app/db-init.ts src/main/app/db-init.test.ts src/main/index.ts
git commit -m "feat(app): 集成 PG 启动与 DB 初始化流程到主进程" -m "设计文档 §1.1 + §6.5"
```

---

## 验收清单（Phase 4b 完成后执行）

- [ ] `pnpm install` 成功
- [ ] `pnpm typecheck` 0 errors 0 warnings
- [ ] `pnpm lint` 0 errors
- [ ] `pnpm test` 全部通过（预期 ~145 测试）
- [ ] `pnpm build` 三入口产物生成
- [ ] `src/main/infra/pg/pg-installer.ts` 含 initdb + ensureInstalled + switchVersion
- [ ] `src/main/infra/prisma/extensions/age.ts` 含 ensureAgeExtension + executeCypher + queryCypher
- [ ] `src/main/infra/prisma/extensions/hnsw.ts` 含 ensureHnswIndex（HNSW + pg_trgm + 复合索引）
- [ ] `src/main/app/db-init.ts` 含 initializeDatabase + shutdownDatabase + AGE 降级流程
- [ ] `src/main/index.ts` whenReady 调用 initializeDatabase
- [ ] `src/main/index.ts` before-quit 调用 shutdownDatabase
- [ ] `packages/shared/src/constants/age.ts` 含 AGE_GRAPH_NAME + 顶点/边标签
- [ ] CodeGraph index 已同步（husky pre-commit）
- [ ] 4 个 commit 已创建

---

## Self-Review 检查（计划编写者自检）

### Spec coverage（设计文档覆盖）
- ✅ §6.3 Apache AGE 图数据 → Task 2 实现 ensureAgeExtension + executeCypher + queryCypher + createCharacterVertex + createRelationEdge
- ✅ §6.4 HNSW 索引 → Task 3 实现 ensureHnswIndex（HNSW + pg_trgm + 复合索引）
- ✅ §6.5 AGE 兼容性策略 → Task 1 实现 switchVersion + Task 4 实现 downgradeForAge
- ✅ §4.3 pg-installer 职责 → Task 1 实现 initdb + ensureInstalled + 资源路径管理
- ✅ §4.3 prisma/extensions/age 职责 → Task 2
- ✅ §4.3 prisma/extensions/pgvector 职责 → Task 3（HNSW 索引初始化）
- ✅ §1.1 应用生命周期 → Task 4 集成到 main/index.ts
- ✅ §7.8 PG 子进程健康监控 → Task 4 集成 PgController.start/stop（Phase 3b 已实现）

### Placeholder scan
- ❌ 无 TBD / TODO / "implement later"
- ❌ 无 "add appropriate error handling"（已显式列出 try/catch + AppError）
- ✅ 所有步骤都有具体代码或命令

### Type consistency
- `ensureAgeExtension(client: PrismaClient): Promise<boolean>` — Task 2 定义，Task 4 调用一致
- `ensureHnswIndex(client: PrismaClient): Promise<void>` — Task 3 定义，Task 4 调用一致
- `ensureInstalled(version: string): Promise<void>` — Task 1 定义，Task 4 调用一致
- `switchVersion(targetVersion: string): Promise<void>` — Task 1 定义，Task 4 调用一致
- `getPgBinaryPath(version: string): string` — Task 1 定义，Task 4 调用一致
- `getPgDataDir(version: string): string` — Task 1 定义，Task 4 调用一致
- `initializeDatabase(): Promise<void>` — Task 4 定义，index.ts 调用一致
- `shutdownDatabase(): Promise<void>` — Task 4 定义，index.ts 调用一致
- `POSTGRES_VERSIONS.V18_4 / V17_10` — Phase 4a 定义，Task 4 调用一致
- `AGE_GRAPH_NAME` — Task 1 定义，Task 2 使用

### Phase 边界遵守
- ✅ 不修改 Phase 3b 的 pg-controller / pg-types / ollama-controller / openai-client / embedding-client / stream-bridge
- ✅ 不修改 Phase 4a 的 prisma/schema.prisma / prisma.config.ts / migration.sql / client.ts
- ✅ 不修改 Phase 3a 的 logger / retry / app-data / keychain / wrap
- ✅ 不实际打包 PG 二进制（resources/pg/18.4 与 17.10 目录留待打包阶段填充）

### 已知风险（执行时需注意）
1. **Prisma 7 migrate deploy 可能要求 prisma.config.ts**：Task 4 中 `runMigrateDeploy` 调用 `pnpm exec prisma migrate deploy`，需确保 prisma.config.ts 与 .env 中 DATABASE_URL 已配置。在 dev 环境运行测试时不会调用此函数（被 mock），但实际运行时需要。
2. **AGE 加载失败的实际处理**：测试中通过 mock 模拟，实际运行时 AGE 在 PG 18.4 上失败的具体原因可能是 `CREATE EXTENSION` 报错或 `LOAD 'age'` 找不到文件。`ensureAgeExtension` 已用 try/catch 捕获并返回 false。
3. **resources/pg/ 目录的占位**：本阶段不实际下载 PG 二进制，dev 环境用系统 PATH 中的 `postgres`。实际生产打包时需要在 `resources/pg/18.4/bin/` 与 `resources/pg/17.10/bin/` 放置便携版 PG。
4. **vi.mock dynamic import**：Task 1/2/3 的测试用 `await import('./module')` 动态导入，配合 vi.mock 的 hoisting。Vitest 4 支持此模式，但若报错可改用顶层静态 import + vi.hoisted。
5. **spawn mock 工厂**：Task 1 的 `createMockChild` 工厂需要支持 `emit` 触发事件。若 Vitest 4 的 vi.fn 不支持自定义方法，可改用普通对象。
6. **db-init.test.ts 中 vi.mock 链式调用**：mock 所有依赖模块后，`initializeDatabase` 内部的 `await import('node:child_process')` 也需要 mock。已在计划中包含。

### 执行建议
- Task 1 必须先执行（Task 4 依赖 pg-installer）
- Task 2 与 Task 3 可并行执行（互不依赖）
- Task 4 必须最后执行（依赖 Task 1-3 的模块）
- 子代理执行 Task 时，**直接使用本计划中的代码块**，不要自行重构
- 子代理若遇到 Prisma 7 API 不兼容（如 $executeRawUnsafe 签名变化），应停止汇报
