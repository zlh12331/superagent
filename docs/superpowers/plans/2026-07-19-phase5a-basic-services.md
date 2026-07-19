# Phase 5a: 基础 Service 层实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现项目、章节、人物、世界观、对话、设置 6 个基础 Service 层，提供 Prisma 数据访问 + Zod 校验 + AppError 错误处理，作为 Phase 6 IPC Handler 的业务底座。

**Architecture:** Service 层为纯函数模块（不持有状态），通过 `getPrismaClient()` 单例访问数据库；Service 之间互不依赖（character.service 例外，调用 age.ts 透传模块）。所有函数返回值类型对齐 `@novel-writer/shared` 中由 Zod schema 派生的实体类型，DateTime 字段在 service 边界序列化为 ISO 字符串。错误统一通过 `AppError` 抛出，由调用方（IPC Handler）通过 `wrap()` 捕获。

**Tech Stack:**
- Prisma 7（`@prisma/client`，PrismaClient 单例）
- Zod 4（schemas 已在 `packages/shared/src/schemas/` 定义，service 复用）
- Vitest 4（colocation 测试，`*.service.test.ts`）
- Biome 2.5.4（lint + format）
- TypeScript 6.0

---

## 文件结构

| 路径 | 职责 | 创建/修改 |
|------|------|----------|
| `src/main/services/project.service.ts` | 项目 CRUD + 归档 | Create |
| `src/main/services/project.service.test.ts` | 项目 service 单元测试 | Create |
| `src/main/services/chapter.service.ts` | 章节 CRUD + 排序 + 字数自动计算 | Create |
| `src/main/services/chapter.service.test.ts` | 章节 service 单元测试 | Create |
| `src/main/services/character.service.ts` | 人物 CRUD + AGE 关系管理 | Create |
| `src/main/services/character.service.test.ts` | 人物 service 单元测试 | Create |
| `src/main/services/worldview.service.ts` | 世界观 CRUD + 树形查询 | Create |
| `src/main/services/worldview.service.test.ts` | 世界观 service 单元测试 | Create |
| `src/main/services/chat.service.ts` | 对话会话 + 消息持久化 | Create |
| `src/main/services/chat.service.test.ts` | 对话 service 单元测试 | Create |
| `src/main/services/settings.service.ts` | 项目设置 + API Key 钥匙串 | Create |
| `src/main/services/settings.service.test.ts` | 设置 service 单元测试 | Create |

**设计原则**：

1. **纯函数模块**：Service 函数不持有状态，通过 `getPrismaClient()` 单例访问数据库
2. **单一职责**：每个 service 只负责一个业务域，文件 < 300 行
3. **类型对齐**：返回值类型对齐 `@novel-writer/shared` 派生类型，DateTime 序列化为 ISO 字符串
4. **错误统一**：所有业务错误通过 `AppError` 抛出（NOT_FOUND / INVALID_INPUT 等）
5. **不互相依赖**：除 `character.service` 调用 `age.ts`（infra 层）外，service 之间无依赖
6. **测试隔离**：测试用 `vi.mock` mock PrismaClient 单例模块，每个测试用例独立

**通用约定**（所有 service 共享）：

- Prisma 返回的 `Date` 字段在 service 边界通过 `.toISOString()` 序列化为 ISO 字符串
- Prisma 返回的可空字段保持 `T | null`，service 层映射为 Zod schema 兼容的 `T | null | undefined`
- Prisma 模型字段名（如 `projectId` / `createdAt`）与 Zod schema 字段名一致，无需映射
- 测试中 mock PrismaClient 使用 `vi.hoisted` 模式避免 TDZ，参考 `src/main/app/db-init.test.ts`
- Biome `useNamingConvention` 对 PrismaClient 字段（如 `projectId`）默认通过（驼峰）；对连续大写常量需 biome-ignore

---

## Task 1: project.service

**Files:**
- Create: `src/main/services/project.service.ts`
- Create: `src/main/services/project.service.test.ts`

### 实现说明

**ProjectService 函数清单**：

| 函数 | 签名 | 错误码 |
|------|------|--------|
| `createProject` | `(input: ProjectCreateInput) => Promise<Project>` | INVALID_INPUT |
| `listProjects` | `() => Promise<Project[]>` | - |
| `getProject` | `(id: string) => Promise<Project>` | PROJECT_NOT_FOUND |
| `updateProject` | `(input: ProjectUpdateInput) => Promise<Project>` | PROJECT_NOT_FOUND |
| `deleteProject` | `(id: string) => Promise<{ id: string }>` | PROJECT_NOT_FOUND |
| `archiveProject` | `(id: string) => Promise<Project>` | PROJECT_NOT_FOUND |

**业务规则**：
- `createProject`：name 在 service 层校验非空（Zod schema 已 trim，但 DB 层无 unique 约束，故不校验重名）
- `archiveProject`：将 `status` 设为 `ARCHIVED`，`archivedAt` 设为当前时间
- `deleteProject`：硬删除，DB 层 `onDelete: Cascade` 级联删除所有子表
- `listProjects`：按 `updatedAt` 倒序，返回所有项目（不归档的优先）

### Step 1: 创建测试文件（含失败测试）

- [ ] **Step 1: 创建测试文件**

`src/main/services/project.service.test.ts`:

```typescript
// src/main/services/project.service.test.ts
// project.service 单元测试
// 设计文档 §4.2 Services 层职责矩阵 / §6.2 Project 模型

import { AppError, ErrorCode } from '@novel-writer/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createMockPrismaClient,
  mockPrismaClient,
  resetMocks,
} from '../__tests__/helpers/mock-prisma';

// vi.hoisted 模式：避免 vi.mock factory TDZ（参考 db-init.test.ts）
const { mockProject } = vi.hoisted(() => ({
  mockProject: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}));

// mock PrismaClient 单例模块
vi.mock('../infra/prisma/client', () => ({
  getPrismaClient: () => mockPrismaClient,
}));

// 直接 import（vi.mock 已提升）
import {
  archiveProject,
  createProject,
  deleteProject,
  getProject,
  listProjects,
  updateProject,
} from './project.service';

describe('project.service', () => {
  beforeEach(() => {
    resetMocks();
    mockPrismaClient.project = mockProject as never;
  });

  describe('createProject', () => {
    it('应创建项目并返回 Project', async () => {
      const input = { name: '我的新书' };
      const now = new Date();
      const created = {
        id: 'c1',
        name: '我的新书',
        description: null,
        genre: null,
        cover: null,
        status: 'ACTIVE',
        metadata: {},
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
      };
      mockProject.create.mockResolvedValue(created);

      const result = await createProject(input);

      expect(mockProject.create).toHaveBeenCalledWith({
        data: {
          name: '我的新书',
          description: undefined,
          genre: undefined,
          cover: undefined,
        },
      });
      expect(result).toEqual({
        id: 'c1',
        name: '我的新书',
        description: null,
        genre: null,
        cover: null,
        status: 'ACTIVE',
        metadata: {},
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        archivedAt: null,
      });
    });
  });

  describe('listProjects', () => {
    it('应返回项目列表（按 updatedAt 倒序）', async () => {
      const now = new Date();
      const projects = [
        { ...sampleDbProject('p1', 'A', now), updatedAt: now },
        { ...sampleDbProject('p2', 'B', now), updatedAt: now },
      ];
      mockProject.findMany.mockResolvedValue(projects);

      const result = await listProjects();

      expect(mockProject.findMany).toHaveBeenCalledWith({
        orderBy: [{ archivedAt: 'asc' }, { updatedAt: 'desc' }],
        where: { archivedAt: null },
      });
      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('p1');
    });
  });

  describe('getProject', () => {
    it('应返回单个项目', async () => {
      const now = new Date();
      mockProject.findUnique.mockResolvedValue(sampleDbProject('p1', 'A', now));

      const result = await getProject('p1');

      expect(mockProject.findUnique).toHaveBeenCalledWith({ where: { id: 'p1' } });
      expect(result.id).toBe('p1');
    });

    it('项目不存在应抛 PROJECT_NOT_FOUND', async () => {
      mockProject.findUnique.mockResolvedValue(null);

      await expect(getProject('not-exist')).rejects.toMatchObject({
        code: ErrorCode.PROJECT_NOT_FOUND,
      });
    });
  });

  describe('updateProject', () => {
    it('应更新项目字段', async () => {
      const now = new Date();
      mockProject.findUnique.mockResolvedValue(sampleDbProject('p1', '旧名', now));
      const updated = { ...sampleDbProject('p1', '新名', now), genre: '玄幻' };
      mockProject.update.mockResolvedValue(updated);

      const result = await updateProject({ id: 'p1', name: '新名', genre: '玄幻' });

      expect(mockProject.update).toHaveBeenCalledWith({
        where: { id: 'p1' },
        data: { name: '新名', genre: '玄幻' },
      });
      expect(result.name).toBe('新名');
    });

    it('项目不存在应抛 PROJECT_NOT_FOUND', async () => {
      mockProject.findUnique.mockResolvedValue(null);
      await expect(
        updateProject({ id: 'nope', name: 'x' }),
      ).rejects.toMatchObject({ code: ErrorCode.PROJECT_NOT_FOUND });
    });
  });

  describe('deleteProject', () => {
    it('应删除项目', async () => {
      const now = new Date();
      mockProject.findUnique.mockResolvedValue(sampleDbProject('p1', 'A', now));
      mockProject.delete.mockResolvedValue({});

      const result = await deleteProject('p1');

      expect(mockProject.delete).toHaveBeenCalledWith({ where: { id: 'p1' } });
      expect(result).toEqual({ id: 'p1' });
    });

    it('项目不存在应抛 PROJECT_NOT_FOUND', async () => {
      mockProject.findUnique.mockResolvedValue(null);
      await expect(deleteProject('nope')).rejects.toMatchObject({
        code: ErrorCode.PROJECT_NOT_FOUND,
      });
    });
  });

  describe('archiveProject', () => {
    it('应归档项目（status=ARCHIVED + archivedAt）', async () => {
      const now = new Date();
      mockProject.findUnique.mockResolvedValue(sampleDbProject('p1', 'A', now));
      const archived = {
        ...sampleDbProject('p1', 'A', now),
        status: 'ARCHIVED',
        archivedAt: now,
      };
      mockProject.update.mockResolvedValue(archived);

      const result = await archiveProject('p1');

      expect(mockProject.update).toHaveBeenCalledWith({
        where: { id: 'p1' },
        data: { status: 'ARCHIVED', archivedAt: expect.any(Date) },
      });
      expect(result.status).toBe('ARCHIVED');
    });

    it('项目不存在应抛 PROJECT_NOT_FOUND', async () => {
      mockProject.findUnique.mockResolvedValue(null);
      await expect(archiveProject('nope')).rejects.toMatchObject({
        code: ErrorCode.PROJECT_NOT_FOUND,
      });
    });
  });
});

/** 生成样本 DB Project 记录 */
function sampleDbProject(id: string, name: string, now: Date) {
  return {
    id,
    name,
    description: null,
    genre: null,
    cover: null,
    status: 'ACTIVE',
    metadata: {},
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
  };
}
```

注意：`mock-prisma.ts` helper（Task 1 Step 2 创建）提供共享 mock 工厂。

### Step 2: 创建 mock-prisma helper

- [ ] **Step 2: 创建共享 mock helper**

`src/main/__tests__/helpers/mock-prisma.ts`:

```typescript
// src/main/__tests__/helpers/mock-prisma.ts
// 共享 PrismaClient mock 工具
// 所有 service 测试统一使用，避免重复定义 mock

import { vi } from 'vitest';

/** Prisma 各 model 的 mock 接口（覆盖 service 用到的方法） */
export interface PrismaModelMock {
  findUnique: ReturnType<typeof vi.fn>;
  findMany: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  upsert: ReturnType<typeof vi.fn>;
  count: ReturnType<typeof vi.fn>;
  deleteMany: ReturnType<typeof vi.fn>;
  updateMany: ReturnType<typeof vi.fn>;
}

/** 创建一个 Prisma model mock（含全部 CRUD 方法） */
export function createPrismaModelMock(): PrismaModelMock {
  return {
    findUnique: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    upsert: vi.fn(),
    count: vi.fn(),
    deleteMany: vi.fn(),
    updateMany: vi.fn(),
  };
}

/** 全局 mock PrismaClient 实例（service 通过 getPrismaClient() 获取） */
export const mockPrismaClient: Record<string, PrismaModelMock> = {};

/** 重置所有 mock（每个测试用例 beforeEach 调用） */
export function resetMocks(): void {
  for (const model of Object.values(mockPrismaClient)) {
    model.findUnique.mockReset();
    model.findMany.mockReset();
    model.create.mockReset();
    model.update.mockReset();
    model.delete.mockReset();
    model.upsert.mockReset();
    model.count.mockReset();
    model.deleteMany.mockReset();
    model.updateMany.mockReset();
  }
}

/** 创建完整 mock PrismaClient（覆盖所有 service 用到的 model） */
export function createMockPrismaClient(): void {
  for (const modelName of [
    'project',
    'chapter',
    'character',
    'worldview',
    'chatSession',
    'chatMessage',
    'projectSetting',
    'appSetting',
    'ragDocument',
    'ragDocumentChunk',
    'aiUsageLog',
  ]) {
    mockPrismaClient[modelName] = createPrismaModelMock();
  }
}

// 模块加载时初始化一次
createMockPrismaClient();
```

### Step 3: 运行测试验证失败

- [ ] **Step 3: 运行测试验证失败**

Run: `pnpm --filter @novel-writer/main exec vitest run src/main/services/project.service.test.ts`
Expected: FAIL — `Cannot find module './project.service'` 或类似错误

### Step 4: 实现 project.service

- [ ] **Step 4: 实现 project.service.ts**

`src/main/services/project.service.ts`:

```typescript
// src/main/services/project.service.ts
// 项目业务逻辑层
// 设计文档 §4.2 Services 层职责矩阵 / §6.2 Project 模型
//
// 职责：
// 1. 项目 CRUD（create / list / get / update / delete）
// 2. 项目归档（archive）
// 3. 错误统一通过 AppError 抛出
//
// 注意：
// - 不持有状态，通过 getPrismaClient() 单例访问数据库
// - 不与其他 service 互相依赖（设计文档 §4.4 禁止依赖方向）
// - Prisma Date 字段在 service 边界序列化为 ISO 字符串（IPC 兼容）

import {
  AppError,
  ErrorCode,
  type Project,
  type ProjectCreateInput,
  type ProjectUpdateInput,
  ProjectStatus,
} from '@novel-writer/shared';
import type { PrismaClient } from '@prisma/client';
import { getPrismaClient } from '../infra/prisma/client';
import { logger } from '../utils/logger';

/**
 * 创建项目
 *
 * @param input 项目创建入参（name 必填，其余可选）
 * @returns 创建后的项目（含自动生成的 id 与时间戳）
 */
export async function createProject(input: ProjectCreateInput): Promise<Project> {
  const prisma = getPrismaClient();
  logger.info({ name: input.name }, '创建项目');

  const created = await prisma.project.create({
    data: {
      name: input.name,
      description: input.description,
      genre: input.genre,
      cover: input.cover,
    },
  });

  return serializeProject(created);
}

/**
 * 列出所有未归档的项目
 *
 * 排序：archivedAt（NULL 优先）+ updatedAt 倒序
 *
 * @returns 项目数组
 */
export async function listProjects(): Promise<Project[]> {
  const prisma = getPrismaClient();
  const projects = await prisma.project.findMany({
    where: { archivedAt: null },
    orderBy: [{ archivedAt: 'asc' }, { updatedAt: 'desc' }],
  });
  return projects.map(serializeProject);
}

/**
 * 获取单个项目
 *
 * @param id 项目 ID
 * @throws AppError(PROJECT_NOT_FOUND) 项目不存在
 */
export async function getProject(id: string): Promise<Project> {
  const prisma = getPrismaClient();
  const found = await prisma.project.findUnique({ where: { id } });
  if (found === null) {
    throw new AppError(ErrorCode.PROJECT_NOT_FOUND, `项目不存在：${id}`);
  }
  return serializeProject(found);
}

/**
 * 更新项目字段
 *
 * @param input 更新入参（id 必填，其余至少 1 个字段）
 * @throws AppError(PROJECT_NOT_FOUND) 项目不存在
 */
export async function updateProject(input: ProjectUpdateInput): Promise<Project> {
  const prisma = getPrismaClient();

  // 先检查存在（提供更友好的错误码）
  const existing = await prisma.project.findUnique({ where: { id: input.id } });
  if (existing === null) {
    throw new AppError(ErrorCode.PROJECT_NOT_FOUND, `项目不存在：${input.id}`);
  }

  // 提取除 id 之外的更新字段
  const { id: _id, ...updateData } = input;
  const updated = await prisma.project.update({
    where: { id: input.id },
    data: updateData,
  });

  logger.info({ projectId: input.id }, '更新项目');
  return serializeProject(updated);
}

/**
 * 删除项目（硬删除，级联删除所有子表）
 *
 * @param id 项目 ID
 * @throws AppError(PROJECT_NOT_FOUND) 项目不存在
 */
export async function deleteProject(id: string): Promise<{ id: string }> {
  const prisma = getPrismaClient();

  const existing = await prisma.project.findUnique({ where: { id } });
  if (existing === null) {
    throw new AppError(ErrorCode.PROJECT_NOT_FOUND, `项目不存在：${id}`);
  }

  await prisma.project.delete({ where: { id } });
  logger.info({ projectId: id }, '删除项目');
  return { id };
}

/**
 * 归档项目（标记为 ARCHIVED 并记录归档时间）
 *
 * @param id 项目 ID
 * @throws AppError(PROJECT_NOT_FOUND) 项目不存在
 */
export async function archiveProject(id: string): Promise<Project> {
  const prisma = getPrismaClient();

  const existing = await prisma.project.findUnique({ where: { id } });
  if (existing === null) {
    throw new AppError(ErrorCode.PROJECT_NOT_FOUND, `项目不存在：${id}`);
  }

  const updated = await prisma.project.update({
    where: { id },
    data: {
      status: ProjectStatus.ARCHIVED,
      archivedAt: new Date(),
    },
  });

  logger.info({ projectId: id }, '归档项目');
  return serializeProject(updated);
}

/**
 * 序列化 Prisma Project 记录为 IPC 兼容的 Project 类型
 *
 * - Date 字段转 ISO 字符串
 * - null 保持 null（不转 undefined，保留显式空值语义）
 */
function serializeProject(raw: RawProject): Project {
  return {
    id: raw.id,
    name: raw.name,
    description: raw.description,
    genre: raw.genre,
    cover: raw.cover,
    status: raw.status as Project['status'],
    metadata: raw.metadata as Record<string, unknown>,
    createdAt: raw.createdAt.toISOString(),
    updatedAt: raw.updatedAt.toISOString(),
    archivedAt: raw.archivedAt === null ? null : raw.archivedAt.toISOString(),
  };
}

/** Prisma project.findUnique / findMany 返回的原始类型 */
type RawProject = Awaited<ReturnType<PrismaClient['project']['findUnique']>>;
```

### Step 5: 运行测试验证通过

- [ ] **Step 5: 运行测试验证通过**

Run: `pnpm --filter @novel-writer/main exec vitest run src/main/services/project.service.test.ts`
Expected: PASS — 全部 9 个测试用例通过

### Step 6: typecheck + lint + commit

- [ ] **Step 6: typecheck + lint + commit**

Run:
```
pnpm typecheck
pnpm lint
```
Expected: 0 errors / 0 warnings

```bash
git add src/main/services/project.service.ts src/main/services/project.service.test.ts src/main/__tests__/helpers/mock-prisma.ts
git commit -m "feat(main): 实现 project.service 项目 CRUD 与归档"
```

---

## Task 2: chapter.service

**Files:**
- Create: `src/main/services/chapter.service.ts`
- Create: `src/main/services/chapter.service.test.ts`

### 实现说明

**ChapterService 函数清单**：

| 函数 | 签名 | 错误码 |
|------|------|--------|
| `createChapter` | `(input: ChapterCreateInput) => Promise<Chapter>` | - |
| `listChapters` | `(projectId: string) => Promise<Chapter[]>` | - |
| `getChapter` | `(id: string) => Promise<Chapter>` | CHAPTER_NOT_FOUND |
| `updateChapter` | `(input: ChapterUpdateInput) => Promise<Chapter>` | CHAPTER_NOT_FOUND |
| `reorderChapters` | `(projectId: string, orderedIds: string[]) => Promise<{ id: string; sortOrder: number }[]>` | - |
| `deleteChapter` | `(id: string) => Promise<{ id: string }>` | CHAPTER_NOT_FOUND |

**业务规则**：
- `createChapter`：若未传 `wordCount`，根据 `content.length` 自动计算（中文按字符数）
- `updateChapter`：若 `content` 被更新，自动重算 `wordCount`（除非显式传 `wordCount`）
- `listChapters`：按 `sortOrder` 升序
- `reorderChapters`：批量更新 `sortOrder`，使用 Prisma `$transaction` 保证原子性

### Step 1: 创建测试文件

- [ ] **Step 1: 创建测试文件**

`src/main/services/chapter.service.test.ts`:

```typescript
// src/main/services/chapter.service.test.ts
// chapter.service 单元测试
// 设计文档 §4.2 Services 层职责矩阵 / §6.2 Chapter 模型

import { AppError, ErrorCode } from '@novel-writer/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockPrismaClient, resetMocks } from '../__tests__/helpers/mock-prisma';

const { mockChapter, mockTransaction } = vi.hoisted(() => ({
  mockChapter: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  mockTransaction: vi.fn(),
}));

vi.mock('../infra/prisma/client', () => ({
  getPrismaClient: () => ({
    ...mockPrismaClient,
    chapter: mockChapter,
    $transaction: mockTransaction,
  }),
}));

import {
  createChapter,
  deleteChapter,
  getChapter,
  listChapters,
  reorderChapters,
  updateChapter,
} from './chapter.service';

describe('chapter.service', () => {
  beforeEach(() => {
    resetMocks();
    mockChapter.findUnique.mockReset();
    mockChapter.findMany.mockReset();
    mockChapter.create.mockReset();
    mockChapter.update.mockReset();
    mockChapter.delete.mockReset();
    mockTransaction.mockReset();
  });

  describe('createChapter', () => {
    it('应创建章节并自动计算 wordCount', async () => {
      const input = {
        projectId: 'p1',
        title: '第一章',
        content: '这是正文内容，共 12 字。',
      };
      const now = new Date();
      mockChapter.create.mockResolvedValue({
        ...sampleDbChapter('c1', now),
        ...input,
        wordCount: 12,
      });

      const result = await createChapter(input);

      expect(mockChapter.create).toHaveBeenCalledWith({
        data: {
          projectId: 'p1',
          volumeId: undefined,
          title: '第一章',
          content: '这是正文内容，共 12 字。',
          status: 'DRAFT',
          sortOrder: 0,
          wordCount: 12,
          metadata: {},
        },
      });
      expect(result.id).toBe('c1');
      expect(result.wordCount).toBe(12);
    });

    it('传入 volumeId 时应正确关联', async () => {
      const now = new Date();
      mockChapter.create.mockResolvedValue({
        ...sampleDbChapter('c1', now),
        projectId: 'p1',
        volumeId: 'v1',
        title: 'T',
        content: '',
        wordCount: 0,
      });

      await createChapter({
        projectId: 'p1',
        volumeId: 'v1',
        title: 'T',
        content: '',
      });

      expect(mockChapter.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ volumeId: 'v1' }),
      });
    });
  });

  describe('listChapters', () => {
    it('应返回章节列表（按 sortOrder 升序）', async () => {
      const now = new Date();
      mockChapter.findMany.mockResolvedValue([
        { ...sampleDbChapter('c1', now), projectId: 'p1', sortOrder: 0 },
        { ...sampleDbChapter('c2', now), projectId: 'p1', sortOrder: 1 },
      ]);

      const result = await listChapters('p1');

      expect(mockChapter.findMany).toHaveBeenCalledWith({
        where: { projectId: 'p1' },
        orderBy: { sortOrder: 'asc' },
      });
      expect(result).toHaveLength(2);
    });
  });

  describe('getChapter', () => {
    it('应返回单个章节', async () => {
      const now = new Date();
      mockChapter.findUnique.mockResolvedValue(sampleDbChapter('c1', now));

      const result = await getChapter('c1');

      expect(mockChapter.findUnique).toHaveBeenCalledWith({ where: { id: 'c1' } });
      expect(result.id).toBe('c1');
    });

    it('章节不存在应抛 CHAPTER_NOT_FOUND', async () => {
      mockChapter.findUnique.mockResolvedValue(null);
      await expect(getChapter('nope')).rejects.toMatchObject({
        code: ErrorCode.CHAPTER_NOT_FOUND,
      });
    });
  });

  describe('updateChapter', () => {
    it('应更新 content 时自动重算 wordCount', async () => {
      const now = new Date();
      mockChapter.findUnique.mockResolvedValue(sampleDbChapter('c1', now));
      mockChapter.update.mockResolvedValue({
        ...sampleDbChapter('c1', now),
        content: '新内容 4 字',
        wordCount: 4,
      });

      const result = await updateChapter({ id: 'c1', content: '新内容 4 字' });

      expect(mockChapter.update).toHaveBeenCalledWith({
        where: { id: 'c1' },
        data: { content: '新内容 4 字', wordCount: 4 },
      });
      expect(result.wordCount).toBe(4);
    });

    it('章节不存在应抛 CHAPTER_NOT_FOUND', async () => {
      mockChapter.findUnique.mockResolvedValue(null);
      await expect(updateChapter({ id: 'nope', title: 'x' })).rejects.toMatchObject({
        code: ErrorCode.CHAPTER_NOT_FOUND,
      });
    });
  });

  describe('reorderChapters', () => {
    it('应批量更新 sortOrder（事务原子性）', async () => {
      // $transaction 数组形式：接收 Promise[]，返回 Promise.all 结果
      // service 内部已调用 prisma.chapter.update（被 mock），$transaction 只需透传
      mockTransaction.mockImplementation((arr: Promise<unknown>[]) => Promise.all(arr));
      // mock chapter.update 返回带 id + sortOrder 的对象
      mockChapter.update.mockImplementation(async ({ where, data }: { where: { id: string }; data: { sortOrder: number } }) => ({
        id: where.id,
        sortOrder: data.sortOrder,
      }));

      const result = await reorderChapters('p1', ['c2', 'c1', 'c3']);

      expect(mockChapter.update).toHaveBeenCalledTimes(3);
      // 验证每次调用都传了正确的 where + data
      expect(mockChapter.update).toHaveBeenNthCalledWith(1, {
        where: { id: 'c2' },
        data: { sortOrder: 0 },
        select: { id: true, sortOrder: true },
      });
      expect(result).toEqual([
        { id: 'c2', sortOrder: 0 },
        { id: 'c1', sortOrder: 1 },
        { id: 'c3', sortOrder: 2 },
      ]);
    });
  });

  describe('deleteChapter', () => {
    it('应删除章节', async () => {
      const now = new Date();
      mockChapter.findUnique.mockResolvedValue(sampleDbChapter('c1', now));
      mockChapter.delete.mockResolvedValue({});

      const result = await deleteChapter('c1');

      expect(mockChapter.delete).toHaveBeenCalledWith({ where: { id: 'c1' } });
      expect(result).toEqual({ id: 'c1' });
    });

    it('章节不存在应抛 CHAPTER_NOT_FOUND', async () => {
      mockChapter.findUnique.mockResolvedValue(null);
      await expect(deleteChapter('nope')).rejects.toMatchObject({
        code: ErrorCode.CHAPTER_NOT_FOUND,
      });
    });
  });
});

function sampleDbChapter(id: string, now: Date) {
  return {
    id,
    projectId: 'p1',
    volumeId: null,
    title: 'T',
    content: '',
    wordCount: 0,
    status: 'DRAFT',
    sortOrder: 0,
    metadata: {},
    createdAt: now,
    updatedAt: now,
  };
}
```

### Step 2: 运行测试验证失败

- [ ] **Step 2: 运行测试验证失败**

Run: `pnpm --filter @novel-writer/main exec vitest run src/main/services/chapter.service.test.ts`
Expected: FAIL — `Cannot find module './chapter.service'`

### Step 3: 实现 chapter.service

- [ ] **Step 3: 实现 chapter.service.ts**

`src/main/services/chapter.service.ts`:

```typescript
// src/main/services/chapter.service.ts
// 章节业务逻辑层
// 设计文档 §4.2 Services 层职责矩阵 / §6.2 Chapter 模型
//
// 职责：
// 1. 章节 CRUD（create / list / get / update / delete）
// 2. 章节排序（reorder，事务批量更新）
// 3. wordCount 自动计算（content.length）
//
// 注意：
// - 不与其他 service 互相依赖
// - reorder 使用 $transaction 保证原子性

import {
  AppError,
  ErrorCode,
  type Chapter,
  type ChapterCreateInput,
  type ChapterUpdateInput,
} from '@novel-writer/shared';
import type { PrismaClient } from '@prisma/client';
import { getPrismaClient } from '../infra/prisma/client';
import { logger } from '../utils/logger';

/**
 * 创建章节
 *
 * wordCount 自动从 content.length 计算
 */
export async function createChapter(input: ChapterCreateInput): Promise<Chapter> {
  const prisma = getPrismaClient();
  logger.info({ projectId: input.projectId, title: input.title }, '创建章节');

  const created = await prisma.chapter.create({
    data: {
      projectId: input.projectId,
      volumeId: input.volumeId ?? null,
      title: input.title,
      content: input.content,
      status: input.status,
      sortOrder: input.sortOrder,
      wordCount: input.content.length,
      metadata: {},
    },
  });

  return serializeChapter(created);
}

/**
 * 列出项目下所有章节（按 sortOrder 升序）
 */
export async function listChapters(projectId: string): Promise<Chapter[]> {
  const prisma = getPrismaClient();
  const chapters = await prisma.chapter.findMany({
    where: { projectId },
    orderBy: { sortOrder: 'asc' },
  });
  return chapters.map(serializeChapter);
}

/**
 * 获取单个章节
 *
 * @throws AppError(CHAPTER_NOT_FOUND) 章节不存在
 */
export async function getChapter(id: string): Promise<Chapter> {
  const prisma = getPrismaClient();
  const found = await prisma.chapter.findUnique({ where: { id } });
  if (found === null) {
    throw new AppError(ErrorCode.CHAPTER_NOT_FOUND, `章节不存在：${id}`);
  }
  return serializeChapter(found);
}

/**
 * 更新章节字段
 *
 * 若 content 被更新且未显式传 wordCount，自动重算
 *
 * @throws AppError(CHAPTER_NOT_FOUND) 章节不存在
 */
export async function updateChapter(input: ChapterUpdateInput): Promise<Chapter> {
  const prisma = getPrismaClient();

  const existing = await prisma.chapter.findUnique({ where: { id: input.id } });
  if (existing === null) {
    throw new AppError(ErrorCode.CHAPTER_NOT_FOUND, `章节不存在：${input.id}`);
  }

  const { id: _id, ...updateData } = input;

  // content 被更新时自动重算 wordCount（除非显式传 wordCount）
  if (input.content !== undefined && input.wordCount === undefined) {
    updateData.wordCount = input.content.length;
  }

  const updated = await prisma.chapter.update({
    where: { id: input.id },
    data: updateData,
  });

  logger.info({ chapterId: input.id }, '更新章节');
  return serializeChapter(updated);
}

/**
 * 批量重排章节顺序（事务原子性）
 *
 * @param projectId 项目 ID
 * @param orderedIds 按新顺序排列的章节 ID 数组
 * @returns 更新后的 id + sortOrder 列表
 */
export async function reorderChapters(
  projectId: string,
  orderedIds: string[],
): Promise<{ id: string; sortOrder: number }[]> {
  const prisma = getPrismaClient();
  logger.info({ projectId, count: orderedIds.length }, '重排章节顺序');

  const result = await prisma.$transaction(
    orderedIds.map((id, index) =>
      prisma.chapter.update({
        where: { id },
        data: { sortOrder: index },
        select: { id: true, sortOrder: true },
      }),
    ),
  );

  return result.map((r) => ({ id: r.id, sortOrder: r.sortOrder }));
}

/**
 * 删除章节
 *
 * @throws AppError(CHAPTER_NOT_FOUND) 章节不存在
 */
export async function deleteChapter(id: string): Promise<{ id: string }> {
  const prisma = getPrismaClient();

  const existing = await prisma.chapter.findUnique({ where: { id } });
  if (existing === null) {
    throw new AppError(ErrorCode.CHAPTER_NOT_FOUND, `章节不存在：${id}`);
  }

  await prisma.chapter.delete({ where: { id } });
  logger.info({ chapterId: id }, '删除章节');
  return { id };
}

/**
 * 序列化 Prisma Chapter 记录为 IPC 兼容的 Chapter 类型
 */
function serializeChapter(raw: RawChapter): Chapter {
  return {
    id: raw.id,
    projectId: raw.projectId,
    volumeId: raw.volumeId,
    title: raw.title,
    content: raw.content,
    wordCount: raw.wordCount,
    status: raw.status as Chapter['status'],
    sortOrder: raw.sortOrder,
    metadata: raw.metadata as Record<string, unknown>,
    createdAt: raw.createdAt.toISOString(),
    updatedAt: raw.updatedAt.toISOString(),
  };
}

/** Prisma chapter.findUnique 返回的原始类型 */
type RawChapter = Awaited<ReturnType<PrismaClient['chapter']['findUnique']>>;
```

### Step 4: 运行测试验证通过

- [ ] **Step 4: 运行测试验证通过**

Run: `pnpm --filter @novel-writer/main exec vitest run src/main/services/chapter.service.test.ts`
Expected: PASS — 全部 9 个测试用例通过

### Step 5: typecheck + lint + commit

- [ ] **Step 5: typecheck + lint + commit**

Run:
```
pnpm typecheck
pnpm lint
```
Expected: 0 errors / 0 warnings

```bash
git add src/main/services/chapter.service.ts src/main/services/chapter.service.test.ts
git commit -m "feat(main): 实现 chapter.service 章节 CRUD 与排序"
```

---

## Task 3: character.service

**Files:**
- Create: `src/main/services/character.service.ts`
- Create: `src/main/services/character.service.test.ts`

### 实现说明

**CharacterService 函数清单**：

| 函数 | 签名 | 错误码 |
|------|------|--------|
| `createCharacter` | `(input: CharacterCreateInput) => Promise<Character>` | - |
| `listCharacters` | `(projectId: string) => Promise<Character[]>` | - |
| `updateCharacter` | `(input: CharacterUpdateInput) => Promise<Character>` | CHARACTER_NOT_FOUND |
| `deleteCharacter` | `(id: string) => Promise<{ id: string }>` | CHARACTER_NOT_FOUND |
| `getCharacterRelations` | `(projectId: string) => Promise<CharacterRelationInput[]>` | - |
| `addCharacterRelation` | `(input: CharacterRelationInput) => Promise<CharacterRelationInput>` | CHARACTER_NOT_FOUND / CHARACTER_RELATION_CYCLE |

**业务规则**：
- `createCharacter`：同步创建 AGE 顶点（`createCharacterVertex`），失败时回滚 Prisma create
- `deleteCharacter`：同步删除 AGE 顶点 + 关联边（`executeCypher`），即使 AGE 失败也不阻塞 Prisma 删除（仅日志 warn）
- `addCharacterRelation`：调用 `createRelationEdge`，from/to 不存在时抛 CHARACTER_NOT_FOUND
- `getCharacterRelations`：通过 `queryCypher` 查询项目下所有 RELATION 边
- Profile 默认 `{}`，avatar 默认 null

### Step 1: 创建测试文件

- [ ] **Step 1: 创建测试文件**

`src/main/services/character.service.test.ts`:

```typescript
// src/main/services/character.service.test.ts
// character.service 单元测试
// 设计文档 §4.2 Services 层职责矩阵 / §6.2 Character 模型 / §6.3 AGE 图边

import { AppError, ErrorCode } from '@novel-writer/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockPrismaClient, resetMocks } from '../__tests__/helpers/mock-prisma';

const { mockCharacter, mockAge } = vi.hoisted(() => ({
  mockCharacter: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  mockAge: {
    createCharacterVertex: vi.fn(),
    createRelationEdge: vi.fn(),
    executeCypher: vi.fn(),
    queryCypher: vi.fn(),
  },
}));

vi.mock('../infra/prisma/client', () => ({
  getPrismaClient: () => ({
    ...mockPrismaClient,
    character: mockCharacter,
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({})),
  }),
}));

vi.mock('../infra/prisma/extensions/age', () => mockAge);

import {
  addCharacterRelation,
  createCharacter,
  deleteCharacter,
  getCharacterRelations,
  listCharacters,
  updateCharacter,
} from './character.service';

describe('character.service', () => {
  beforeEach(() => {
    resetMocks();
    mockCharacter.findUnique.mockReset();
    mockCharacter.findMany.mockReset();
    mockCharacter.create.mockReset();
    mockCharacter.update.mockReset();
    mockCharacter.delete.mockReset();
    mockAge.createCharacterVertex.mockReset();
    mockAge.createRelationEdge.mockReset();
    mockAge.executeCypher.mockReset();
    mockAge.queryCypher.mockReset();
  });

  describe('createCharacter', () => {
    it('应创建人物并同步创建 AGE 顶点', async () => {
      const now = new Date();
      mockCharacter.create.mockResolvedValue({
        ...sampleDbCharacter('c1', now),
        name: '主角',
        role: 'PROTAGONIST',
      });
      mockAge.createCharacterVertex.mockResolvedValue(1);

      const result = await createCharacter({
        projectId: 'p1',
        name: '主角',
        role: 'PROTAGONIST',
      });

      expect(mockCharacter.create).toHaveBeenCalledWith({
        data: {
          projectId: 'p1',
          name: '主角',
          avatar: undefined,
          role: 'PROTAGONIST',
          description: undefined,
          profile: {},
        },
      });
      expect(mockAge.createCharacterVertex).toHaveBeenCalledWith(
        expect.anything(),
        { characterId: 'c1', name: '主角', role: 'PROTAGONIST' },
      );
      expect(result.id).toBe('c1');
    });
  });

  describe('listCharacters', () => {
    it('应返回人物列表（按 createdAt 升序）', async () => {
      const now = new Date();
      mockCharacter.findMany.mockResolvedValue([sampleDbCharacter('c1', now)]);

      const result = await listCharacters('p1');

      expect(mockCharacter.findMany).toHaveBeenCalledWith({
        where: { projectId: 'p1' },
        orderBy: { createdAt: 'asc' },
      });
      expect(result).toHaveLength(1);
    });
  });

  describe('updateCharacter', () => {
    it('应更新人物字段', async () => {
      const now = new Date();
      mockCharacter.findUnique.mockResolvedValue(sampleDbCharacter('c1', now));
      mockCharacter.update.mockResolvedValue({
        ...sampleDbCharacter('c1', now),
        name: '新名',
      });

      const result = await updateCharacter({ id: 'c1', name: '新名' });

      expect(mockCharacter.update).toHaveBeenCalledWith({
        where: { id: 'c1' },
        data: { name: '新名' },
      });
      expect(result.name).toBe('新名');
    });

    it('人物不存在应抛 CHARACTER_NOT_FOUND', async () => {
      mockCharacter.findUnique.mockResolvedValue(null);
      await expect(updateCharacter({ id: 'nope', name: 'x' })).rejects.toMatchObject({
        code: ErrorCode.CHARACTER_NOT_FOUND,
      });
    });
  });

  describe('deleteCharacter', () => {
    it('应删除人物并清理 AGE 顶点（AGE 失败不阻塞）', async () => {
      const now = new Date();
      mockCharacter.findUnique.mockResolvedValue(sampleDbCharacter('c1', now));
      mockCharacter.delete.mockResolvedValue({});
      mockAge.executeCypher.mockRejectedValue(new Error('AGE 不可用'));

      const result = await deleteCharacter('c1');

      expect(mockCharacter.delete).toHaveBeenCalledWith({ where: { id: 'c1' } });
      expect(mockAge.executeCypher).toHaveBeenCalled();
      expect(result).toEqual({ id: 'c1' });
    });

    it('人物不存在应抛 CHARACTER_NOT_FOUND', async () => {
      mockCharacter.findUnique.mockResolvedValue(null);
      await expect(deleteCharacter('nope')).rejects.toMatchObject({
        code: ErrorCode.CHARACTER_NOT_FOUND,
      });
    });
  });

  describe('addCharacterRelation', () => {
    it('应创建人物关系（校验两端存在）', async () => {
      const now = new Date();
      mockCharacter.findUnique
        .mockResolvedValueOnce(sampleDbCharacter('c1', now))
        .mockResolvedValueOnce(sampleDbCharacter('c2', now));
      mockAge.createRelationEdge.mockResolvedValue(1);

      const result = await addCharacterRelation({
        fromCharacterId: 'c1',
        toCharacterId: 'c2',
        type: 'friend',
        description: '挚友',
      });

      expect(mockAge.createRelationEdge).toHaveBeenCalledWith(
        expect.anything(),
        {
          fromCharacterId: 'c1',
          toCharacterId: 'c2',
          type: 'friend',
          description: '挚友',
        },
      );
      expect(result.fromCharacterId).toBe('c1');
    });

    it('from 人物不存在应抛 CHARACTER_NOT_FOUND', async () => {
      mockCharacter.findUnique.mockResolvedValue(null);
      await expect(
        addCharacterRelation({
          fromCharacterId: 'nope',
          toCharacterId: 'c2',
          type: 'friend',
        }),
      ).rejects.toMatchObject({ code: ErrorCode.CHARACTER_NOT_FOUND });
    });
  });

  describe('getCharacterRelations', () => {
    it('应通过 Cypher 查询项目下所有关系', async () => {
      mockCharacter.findMany.mockResolvedValue([
        { ...sampleDbCharacter('c1', new Date()), id: 'c1' },
        { ...sampleDbCharacter('c2', new Date()), id: 'c2' },
      ]);
      mockAge.queryCypher.mockResolvedValue([
        { from: 'c1', to: 'c2', type: 'friend', description: '挚友' },
      ]);

      const result = await getCharacterRelations('p1');

      expect(mockAge.queryCypher).toHaveBeenCalled();
      expect(result).toHaveLength(1);
      expect(result[0].fromCharacterId).toBe('c1');
    });
  });
});

function sampleDbCharacter(id: string, now: Date) {
  return {
    id,
    projectId: 'p1',
    name: 'N',
    avatar: null,
    role: 'SUPPORTING',
    description: null,
    profile: {},
    createdAt: now,
    updatedAt: now,
  };
}
```

### Step 2: 运行测试验证失败

- [ ] **Step 2: 运行测试验证失败**

Run: `pnpm --filter @novel-writer/main exec vitest run src/main/services/character.service.test.ts`
Expected: FAIL — `Cannot find module './character.service'`

### Step 3: 实现 character.service

- [ ] **Step 3: 实现 character.service.ts**

`src/main/services/character.service.ts`:

```typescript
// src/main/services/character.service.ts
// 人物业务逻辑层
// 设计文档 §4.2 Services 层职责矩阵 / §6.2 Character 模型 / §6.3 AGE 图
//
// 职责：
// 1. 人物 CRUD（create / list / update / delete）
// 2. 人物关系管理（AGE 图边：addRelation / getRelations）
// 3. create 时同步创建 AGE 顶点；delete 时清理 AGE 顶点与边（容错）
//
// 注意：
// - 调用 infra/prisma/extensions/age.ts 透传 Cypher
// - AGE 失败不阻塞 Prisma 业务（仅 warn 日志），保证主流程可用
// - Profile 默认 {}

import {
  type Character,
  type CharacterCreateInput,
  type CharacterRelationInput,
  type CharacterUpdateInput,
  ErrorCode,
  AppError,
} from '@novel-writer/shared';
import type { PrismaClient } from '@prisma/client';
import {
  createCharacterVertex,
  createRelationEdge,
  executeCypher,
  queryCypher,
} from '../infra/prisma/extensions/age';
import { getPrismaClient } from '../infra/prisma/client';
import { logger } from '../utils/logger';

/**
 * 创建人物
 *
 * 同步在 AGE 图中创建 Character 顶点
 * 若 AGE 创建失败，仅 warn 日志，不阻塞 Prisma 业务
 */
export async function createCharacter(input: CharacterCreateInput): Promise<Character> {
  const prisma = getPrismaClient();
  logger.info({ projectId: input.projectId, name: input.name }, '创建人物');

  const created = await prisma.character.create({
    data: {
      projectId: input.projectId,
      name: input.name,
      avatar: input.avatar ?? null,
      role: input.role,
      description: input.description,
      profile: input.profile ?? {},
    },
  });

  // 同步创建 AGE 顶点（失败不阻塞）
  try {
    await createCharacterVertex(prisma, {
      characterId: created.id,
      name: created.name,
      role: created.role,
    });
  } catch (err) {
    logger.warn(
      { characterId: created.id, error: err instanceof Error ? err.message : String(err) },
      'AGE 顶点创建失败（不阻塞 Prisma 业务）',
    );
  }

  return serializeCharacter(created);
}

/**
 * 列出项目下所有人物（按 createdAt 升序）
 */
export async function listCharacters(projectId: string): Promise<Character[]> {
  const prisma = getPrismaClient();
  const characters = await prisma.character.findMany({
    where: { projectId },
    orderBy: { createdAt: 'asc' },
  });
  return characters.map(serializeCharacter);
}

/**
 * 更新人物字段
 *
 * 更新 name/role 时同步更新 AGE 顶点（容错）
 *
 * @throws AppError(CHARACTER_NOT_FOUND) 人物不存在
 */
export async function updateCharacter(input: CharacterUpdateInput): Promise<Character> {
  const prisma = getPrismaClient();

  const existing = await prisma.character.findUnique({ where: { id: input.id } });
  if (existing === null) {
    throw new AppError(ErrorCode.CHARACTER_NOT_FOUND, `人物不存在：${input.id}`);
  }

  const { id: _id, ...updateData } = input;
  const updated = await prisma.character.update({
    where: { id: input.id },
    data: updateData,
  });

  // 同步更新 AGE 顶点（删除旧顶点 + 创建新顶点，简化处理）
  if (input.name !== undefined || input.role !== undefined) {
    try {
      // 删除旧顶点（含关联边）
      await executeCypher(
        prisma,
        `MATCH (n:Character {characterId: '${input.id}'}) DETACH DELETE n`,
      );
      // 重新创建
      await createCharacterVertex(prisma, {
        characterId: updated.id,
        name: updated.name,
        role: updated.role,
      });
    } catch (err) {
      logger.warn(
        { characterId: input.id, error: err instanceof Error ? err.message : String(err) },
        'AGE 顶点更新失败（不阻塞）',
      );
    }
  }

  logger.info({ characterId: input.id }, '更新人物');
  return serializeCharacter(updated);
}

/**
 * 删除人物
 *
 * 同步清理 AGE 顶点与关联边（容错：失败不阻塞 Prisma 删除）
 *
 * @throws AppError(CHARACTER_NOT_FOUND) 人物不存在
 */
export async function deleteCharacter(id: string): Promise<{ id: string }> {
  const prisma = getPrismaClient();

  const existing = await prisma.character.findUnique({ where: { id } });
  if (existing === null) {
    throw new AppError(ErrorCode.CHARACTER_NOT_FOUND, `人物不存在：${id}`);
  }

  await prisma.character.delete({ where: { id } });

  // 清理 AGE 顶点与关联边（DETACH DELETE 自动删除所有关联边）
  try {
    await executeCypher(
      prisma,
      `MATCH (n:Character {characterId: '${id}'}) DETACH DELETE n`,
    );
  } catch (err) {
    logger.warn(
      { characterId: id, error: err instanceof Error ? err.message : String(err) },
      'AGE 顶点清理失败（不阻塞删除）',
    );
  }

  logger.info({ characterId: id }, '删除人物');
  return { id };
}

/**
 * 添加人物关系（AGE 图边）
 *
 * @throws AppError(CHARACTER_NOT_FOUND) from/to 人物不存在
 */
export async function addCharacterRelation(
  input: CharacterRelationInput,
): Promise<CharacterRelationInput> {
  const prisma = getPrismaClient();

  // 校验两端存在
  const fromChar = await prisma.character.findUnique({
    where: { id: input.fromCharacterId },
  });
  if (fromChar === null) {
    throw new AppError(
      ErrorCode.CHARACTER_NOT_FOUND,
      `起始人物不存在：${input.fromCharacterId}`,
    );
  }
  const toChar = await prisma.character.findUnique({
    where: { id: input.toCharacterId },
  });
  if (toChar === null) {
    throw new AppError(
      ErrorCode.CHARACTER_NOT_FOUND,
      `目标人物不存在：${input.toCharacterId}`,
    );
  }

  await createRelationEdge(prisma, {
    fromCharacterId: input.fromCharacterId,
    toCharacterId: input.toCharacterId,
    type: input.type,
    description: input.description,
    chapterId: input.chapterId,
  });

  logger.info(
    { from: input.fromCharacterId, to: input.toCharacterId, type: input.type },
    '添加人物关系',
  );
  return input;
}

/**
 * 获取项目下所有人物关系
 *
 * 通过 Cypher MATCH 查询所有 RELATION 边，过滤到项目人物
 */
export async function getCharacterRelations(
  projectId: string,
): Promise<CharacterRelationInput[]> {
  const prisma = getPrismaClient();

  // 获取项目下所有人物 ID（用于过滤关系）
  const characters = await prisma.character.findMany({
    where: { projectId },
    select: { id: true },
  });
  const characterIds = new Set(characters.map((c) => c.id));

  if (characterIds.size === 0) {
    return [];
  }

  // 查询所有 RELATION 边
  const rows = await queryCypher<{ result: unknown }>(
    prisma,
    `MATCH (a:Character)-[r:RELATION]->(b:Character)
     RETURN a.characterId AS from, b.characterId AS to, r.type AS type, r.description AS description`,
  );

  // 过滤到本项目人物
  return rows
    .filter((row) => {
      const r = row as { from: string; to: string };
      return characterIds.has(r.from) && characterIds.has(r.to);
    })
    .map((row) => {
      const r = row as {
        from: string;
        to: string;
        type: string;
        description?: string;
      };
      return {
        fromCharacterId: r.from,
        toCharacterId: r.to,
        type: r.type,
        description: r.description,
      };
    });
}

/**
 * 序列化 Prisma Character 记录为 IPC 兼容的 Character 类型
 */
function serializeCharacter(raw: RawCharacter): Character {
  return {
    id: raw.id,
    projectId: raw.projectId,
    name: raw.name,
    avatar: raw.avatar,
    role: raw.role as Character['role'],
    description: raw.description,
    profile: raw.profile as Record<string, unknown>,
    createdAt: raw.createdAt.toISOString(),
    updatedAt: raw.updatedAt.toISOString(),
  };
}

/** Prisma character.findUnique 返回的原始类型 */
type RawCharacter = Awaited<ReturnType<PrismaClient['character']['findUnique']>>;
```

### Step 4: 运行测试验证通过

- [ ] **Step 4: 运行测试验证通过**

Run: `pnpm --filter @novel-writer/main exec vitest run src/main/services/character.service.test.ts`
Expected: PASS — 全部 8 个测试用例通过

### Step 5: typecheck + lint + commit

- [ ] **Step 5: typecheck + lint + commit**

Run:
```
pnpm typecheck
pnpm lint
```
Expected: 0 errors / 0 warnings

```bash
git add src/main/services/character.service.ts src/main/services/character.service.test.ts
git commit -m "feat(main): 实现 character.service 人物 CRUD 与 AGE 关系管理"
```

---

## Task 4: worldview.service

**Files:**
- Create: `src/main/services/worldview.service.ts`
- Create: `src/main/services/worldview.service.test.ts`

### 实现说明

**WorldviewService 函数清单**：

| 函数 | 签名 | 错误码 |
|------|------|--------|
| `createWorldview` | `(input: WorldviewCreateInput) => Promise<Worldview>` | - |
| `getWorldviewTree` | `(projectId: string) => Promise<Worldview[]>` | - |
| `updateWorldview` | `(input: WorldviewUpdateInput) => Promise<Worldview>` | NOT_FOUND |
| `deleteWorldview` | `(id: string) => Promise<{ id: string }>` | NOT_FOUND |

**业务规则**：
- `getWorldviewTree`：返回项目下所有 worldview 的扁平数组（渲染层组装为树），按 `sortOrder` 升序
- `deleteWorldview`：DB 层 `onDelete: Cascade` 自动级联删除子节点（无需 service 显式递归）
- `createWorldview`：parentId 校验存在（若传入），且必须属于同一项目（防止跨项目引用）

### Step 1: 创建测试文件

- [ ] **Step 1: 创建测试文件**

`src/main/services/worldview.service.test.ts`:

```typescript
// src/main/services/worldview.service.test.ts
// worldview.service 单元测试
// 设计文档 §4.2 Services 层职责矩阵 / §6.2 Worldview 模型（自关联树形）

import { AppError, ErrorCode } from '@novel-writer/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockPrismaClient, resetMocks } from '../__tests__/helpers/mock-prisma';

const { mockWorldview } = vi.hoisted(() => ({
  mockWorldview: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock('../infra/prisma/client', () => ({
  getPrismaClient: () => ({
    ...mockPrismaClient,
    worldview: mockWorldview,
  }),
}));

import {
  createWorldview,
  deleteWorldview,
  getWorldviewTree,
  updateWorldview,
} from './worldview.service';

describe('worldview.service', () => {
  beforeEach(() => {
    resetMocks();
    mockWorldview.findUnique.mockReset();
    mockWorldview.findMany.mockReset();
    mockWorldview.create.mockReset();
    mockWorldview.update.mockReset();
    mockWorldview.delete.mockReset();
  });

  describe('createWorldview', () => {
    it('应创建根世界观条目（无 parentId）', async () => {
      const now = new Date();
      mockWorldview.create.mockResolvedValue({
        ...sampleDbWorldview('w1', now),
        title: '大陆',
        parentId: null,
      });

      const result = await createWorldview({
        projectId: 'p1',
        title: '大陆',
      });

      expect(mockWorldview.create).toHaveBeenCalledWith({
        data: {
          projectId: 'p1',
          parentId: null,
          title: '大陆',
          content: undefined,
          type: undefined,
          icon: undefined,
          sortOrder: 0,
        },
      });
      expect(result.id).toBe('w1');
    });

    it('传入 parentId 时应校验父节点存在且同项目', async () => {
      const now = new Date();
      mockWorldview.findUnique.mockResolvedValueOnce({
        ...sampleDbWorldview('w1', now),
        projectId: 'p1',
      });
      mockWorldview.create.mockResolvedValue({
        ...sampleDbWorldview('w2', now),
        projectId: 'p1',
        parentId: 'w1',
      });

      await createWorldview({
        projectId: 'p1',
        parentId: 'w1',
        title: '帝国',
      });

      expect(mockWorldview.findUnique).toHaveBeenCalledWith({ where: { id: 'w1' } });
    });

    it('父节点不存在应抛 NOT_FOUND', async () => {
      mockWorldview.findUnique.mockResolvedValue(null);
      await expect(
        createWorldview({ projectId: 'p1', parentId: 'nope', title: 'x' }),
      ).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
    });

    it('父节点属于其他项目应抛 NOT_FOUND', async () => {
      const now = new Date();
      mockWorldview.findUnique.mockResolvedValue({
        ...sampleDbWorldview('w1', now),
        projectId: 'other-project',
      });
      await expect(
        createWorldview({ projectId: 'p1', parentId: 'w1', title: 'x' }),
      ).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
    });
  });

  describe('getWorldviewTree', () => {
    it('应返回扁平数组（按 sortOrder 升序）', async () => {
      const now = new Date();
      mockWorldview.findMany.mockResolvedValue([
        { ...sampleDbWorldview('w1', now), sortOrder: 0 },
        { ...sampleDbWorldview('w2', now), parentId: 'w1', sortOrder: 1 },
      ]);

      const result = await getWorldviewTree('p1');

      expect(mockWorldview.findMany).toHaveBeenCalledWith({
        where: { projectId: 'p1' },
        orderBy: { sortOrder: 'asc' },
      });
      expect(result).toHaveLength(2);
    });
  });

  describe('updateWorldview', () => {
    it('应更新字段', async () => {
      const now = new Date();
      mockWorldview.findUnique.mockResolvedValue(sampleDbWorldview('w1', now));
      mockWorldview.update.mockResolvedValue({
        ...sampleDbWorldview('w1', now),
        title: '新名',
      });

      const result = await updateWorldview({ id: 'w1', title: '新名' });

      expect(mockWorldview.update).toHaveBeenCalledWith({
        where: { id: 'w1' },
        data: { title: '新名' },
      });
      expect(result.title).toBe('新名');
    });

    it('条目不存在应抛 NOT_FOUND', async () => {
      mockWorldview.findUnique.mockResolvedValue(null);
      await expect(updateWorldview({ id: 'nope', title: 'x' })).rejects.toMatchObject({
        code: ErrorCode.NOT_FOUND,
      });
    });
  });

  describe('deleteWorldview', () => {
    it('应删除条目（DB 级联删除子节点）', async () => {
      const now = new Date();
      mockWorldview.findUnique.mockResolvedValue(sampleDbWorldview('w1', now));
      mockWorldview.delete.mockResolvedValue({});

      const result = await deleteWorldview('w1');

      expect(mockWorldview.delete).toHaveBeenCalledWith({ where: { id: 'w1' } });
      expect(result).toEqual({ id: 'w1' });
    });

    it('条目不存在应抛 NOT_FOUND', async () => {
      mockWorldview.findUnique.mockResolvedValue(null);
      await expect(deleteWorldview('nope')).rejects.toMatchObject({
        code: ErrorCode.NOT_FOUND,
      });
    });
  });
});

function sampleDbWorldview(id: string, now: Date) {
  return {
    id,
    projectId: 'p1',
    parentId: null,
    title: 'T',
    content: null,
    type: null,
    icon: null,
    sortOrder: 0,
    createdAt: now,
    updatedAt: now,
  };
}
```

### Step 2: 运行测试验证失败

- [ ] **Step 2: 运行测试验证失败**

Run: `pnpm --filter @novel-writer/main exec vitest run src/main/services/worldview.service.test.ts`
Expected: FAIL — `Cannot find module './worldview.service'`

### Step 3: 实现 worldview.service

- [ ] **Step 3: 实现 worldview.service.ts**

`src/main/services/worldview.service.ts`:

```typescript
// src/main/services/worldview.service.ts
// 世界观业务逻辑层
// 设计文档 §4.2 Services 层职责矩阵 / §6.2 Worldview 模型（自关联树形）
//
// 职责：
// 1. 世界观 CRUD（create / tree / update / delete）
// 2. 树形查询（返回扁平数组，渲染层组装为树）
// 3. create 时校验 parentId 存在且同项目
//
// 注意：
// - delete 依赖 DB 层 onDelete: Cascade 自动级联删除子节点（无需 service 递归）
// - 不与其他 service 互相依赖

import {
  AppError,
  ErrorCode,
  type Worldview,
  type WorldviewCreateInput,
  type WorldviewUpdateInput,
} from '@novel-writer/shared';
import type { PrismaClient } from '@prisma/client';
import { getPrismaClient } from '../infra/prisma/client';
import { logger } from '../utils/logger';

/**
 * 创建世界观条目
 *
 * 传入 parentId 时校验父节点存在且属于同一项目
 */
export async function createWorldview(input: WorldviewCreateInput): Promise<Worldview> {
  const prisma = getPrismaClient();
  logger.info({ projectId: input.projectId, title: input.title }, '创建世界观条目');

  // 校验 parentId（若传入）
  if (input.parentId !== null && input.parentId !== undefined) {
    const parent = await prisma.worldview.findUnique({
      where: { id: input.parentId },
    });
    if (parent === null || parent.projectId !== input.projectId) {
      throw new AppError(
        ErrorCode.NOT_FOUND,
        `父节点不存在或不属于同一项目：${input.parentId}`,
      );
    }
  }

  const created = await prisma.worldview.create({
    data: {
      projectId: input.projectId,
      parentId: input.parentId ?? null,
      title: input.title,
      content: input.content,
      type: input.type,
      icon: input.icon,
      sortOrder: input.sortOrder,
    },
  });

  return serializeWorldview(created);
}

/**
 * 获取项目下所有世界观条目（扁平数组）
 *
 * 渲染层根据 parentId 组装为树形结构
 */
export async function getWorldviewTree(projectId: string): Promise<Worldview[]> {
  const prisma = getPrismaClient();
  const items = await prisma.worldview.findMany({
    where: { projectId },
    orderBy: { sortOrder: 'asc' },
  });
  return items.map(serializeWorldview);
}

/**
 * 更新世界观条目
 *
 * @throws AppError(NOT_FOUND) 条目不存在
 */
export async function updateWorldview(input: WorldviewUpdateInput): Promise<Worldview> {
  const prisma = getPrismaClient();

  const existing = await prisma.worldview.findUnique({ where: { id: input.id } });
  if (existing === null) {
    throw new AppError(ErrorCode.NOT_FOUND, `世界观条目不存在：${input.id}`);
  }

  const { id: _id, ...updateData } = input;
  const updated = await prisma.worldview.update({
    where: { id: input.id },
    data: updateData,
  });

  logger.info({ worldviewId: input.id }, '更新世界观条目');
  return serializeWorldview(updated);
}

/**
 * 删除世界观条目
 *
 * DB 层 onDelete: Cascade 自动级联删除所有子节点
 *
 * @throws AppError(NOT_FOUND) 条目不存在
 */
export async function deleteWorldview(id: string): Promise<{ id: string }> {
  const prisma = getPrismaClient();

  const existing = await prisma.worldview.findUnique({ where: { id } });
  if (existing === null) {
    throw new AppError(ErrorCode.NOT_FOUND, `世界观条目不存在：${id}`);
  }

  await prisma.worldview.delete({ where: { id } });
  logger.info({ worldviewId: id }, '删除世界观条目（含子节点级联）');
  return { id };
}

/**
 * 序列化 Prisma Worldview 记录为 IPC 兼容的 Worldview 类型
 */
function serializeWorldview(raw: RawWorldview): Worldview {
  return {
    id: raw.id,
    projectId: raw.projectId,
    parentId: raw.parentId,
    title: raw.title,
    content: raw.content,
    type: raw.type,
    icon: raw.icon,
    sortOrder: raw.sortOrder,
    createdAt: raw.createdAt.toISOString(),
    updatedAt: raw.updatedAt.toISOString(),
  };
}

/** Prisma worldview.findUnique 返回的原始类型 */
type RawWorldview = Awaited<ReturnType<PrismaClient['worldview']['findUnique']>>;
```

### Step 4: 运行测试验证通过

- [ ] **Step 4: 运行测试验证通过**

Run: `pnpm --filter @novel-writer/main exec vitest run src/main/services/worldview.service.test.ts`
Expected: PASS — 全部 9 个测试用例通过

### Step 5: typecheck + lint + commit

- [ ] **Step 5: typecheck + lint + commit**

Run:
```
pnpm typecheck
pnpm lint
```
Expected: 0 errors / 0 warnings

```bash
git add src/main/services/worldview.service.ts src/main/services/worldview.service.test.ts
git commit -m "feat(main): 实现 worldview.service 世界观 CRUD 与树形查询"
```

---

## Task 5: chat.service

**Files:**
- Create: `src/main/services/chat.service.ts`
- Create: `src/main/services/chat.service.test.ts`

### 实现说明

**ChatService 函数清单**：

| 函数 | 签名 | 错误码 |
|------|------|--------|
| `createChatSession` | `(input: ChatSessionCreateInput) => Promise<ChatSession>` | - |
| `listChatSessions` | `(projectId: string) => Promise<ChatSession[]>` | - |
| `getChatMessages` | `(sessionId: string) => Promise<ChatMessage[]>` | - |
| `sendChatMessage` | `(input: ChatSendMessageInput) => Promise<{ ackId: string }>` | NOT_FOUND |
| `stopChatGeneration` | `(sessionId: string) => Promise<{ stopped: boolean }>` | - |

**业务规则**：
- `createChatSession`：创建会话，context 默认 `{}`
- `listChatSessions`：按 `updatedAt` 倒序
- `getChatMessages`：按 `createdAt` 升序
- `sendChatMessage`：持久化用户消息（role=user），返回 ackId（uuid）。实际 AI 调用由 Phase 5b agent.service 编排
- `stopChatGeneration`：Phase 5a 占位实现，返回 `{ stopped: false }`（实际 AbortController 管理在 5b）

### Step 1: 创建测试文件

- [ ] **Step 1: 创建测试文件**

`src/main/services/chat.service.test.ts`:

```typescript
// src/main/services/chat.service.test.ts
// chat.service 单元测试
// 设计文档 §4.2 Services 层职责矩阵 / §6.2 ChatSession / ChatMessage 模型

import { AppError, ErrorCode } from '@novel-writer/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockPrismaClient, resetMocks } from '../__tests__/helpers/mock-prisma';

const { mockChatSession, mockChatMessage } = vi.hoisted(() => ({
  mockChatSession: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
  },
  mockChatMessage: {
    findMany: vi.fn(),
    create: vi.fn(),
  },
}));

vi.mock('../infra/prisma/client', () => ({
  getPrismaClient: () => ({
    ...mockPrismaClient,
    chatSession: mockChatSession,
    chatMessage: mockChatMessage,
  }),
}));

import {
  createChatSession,
  getChatMessages,
  listChatSessions,
  sendChatMessage,
  stopChatGeneration,
} from './chat.service';

describe('chat.service', () => {
  beforeEach(() => {
    resetMocks();
    mockChatSession.findUnique.mockReset();
    mockChatSession.findMany.mockReset();
    mockChatSession.create.mockReset();
    mockChatMessage.findMany.mockReset();
    mockChatMessage.create.mockReset();
  });

  describe('createChatSession', () => {
    it('应创建对话会话', async () => {
      const now = new Date();
      mockChatSession.create.mockResolvedValue({
        id: 's1',
        projectId: 'p1',
        title: '新书讨论',
        context: {},
        model: null,
        createdAt: now,
        updatedAt: now,
      });

      const result = await createChatSession({
        projectId: 'p1',
        title: '新书讨论',
      });

      expect(mockChatSession.create).toHaveBeenCalledWith({
        data: {
          projectId: 'p1',
          title: '新书讨论',
          model: undefined,
          context: {},
        },
      });
      expect(result.id).toBe('s1');
    });
  });

  describe('listChatSessions', () => {
    it('应返回会话列表（按 updatedAt 倒序）', async () => {
      const now = new Date();
      mockChatSession.findMany.mockResolvedValue([
        { id: 's1', projectId: 'p1', title: 'A', context: {}, model: null, createdAt: now, updatedAt: now },
      ]);

      const result = await listChatSessions('p1');

      expect(mockChatSession.findMany).toHaveBeenCalledWith({
        where: { projectId: 'p1' },
        orderBy: { updatedAt: 'desc' },
      });
      expect(result).toHaveLength(1);
    });
  });

  describe('getChatMessages', () => {
    it('应返回消息列表（按 createdAt 升序）', async () => {
      const now = new Date();
      mockChatMessage.findMany.mockResolvedValue([
        {
          id: 'm1',
          sessionId: 's1',
          role: 'user',
          content: '你好',
          tokens: 2,
          metadata: {},
          createdAt: now,
        },
      ]);

      const result = await getChatMessages('s1');

      expect(mockChatMessage.findMany).toHaveBeenCalledWith({
        where: { sessionId: 's1' },
        orderBy: { createdAt: 'asc' },
      });
      expect(result).toHaveLength(1);
      expect(result[0].role).toBe('user');
    });
  });

  describe('sendChatMessage', () => {
    it('应持久化用户消息并返回 ackId', async () => {
      const now = new Date();
      mockChatSession.findUnique.mockResolvedValue({
        id: 's1',
        projectId: 'p1',
        title: 'T',
        context: {},
        model: null,
        createdAt: now,
        updatedAt: now,
      });
      mockChatMessage.create.mockResolvedValue({});

      const result = await sendChatMessage({ sessionId: 's1', content: '续写下一章' });

      expect(mockChatMessage.create).toHaveBeenCalledWith({
        data: {
          sessionId: 's1',
          role: 'user',
          content: '续写下一章',
          tokens: 6,
          metadata: {},
        },
      });
      expect(result.ackId).toEqual(expect.any(String));
      expect(result.ackId).toHaveLength(36); // UUID v4 长度
    });

    it('会话不存在应抛 NOT_FOUND', async () => {
      mockChatSession.findUnique.mockResolvedValue(null);
      await expect(
        sendChatMessage({ sessionId: 'nope', content: 'x' }),
      ).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
    });
  });

  describe('stopChatGeneration', () => {
    it('Phase 5a 占位实现应返回 stopped=false', async () => {
      const result = await stopChatGeneration('s1');
      expect(result).toEqual({ stopped: false });
    });
  });
});
```

### Step 2: 运行测试验证失败

- [ ] **Step 2: 运行测试验证失败**

Run: `pnpm --filter @novel-writer/main exec vitest run src/main/services/chat.service.test.ts`
Expected: FAIL — `Cannot find module './chat.service'`

### Step 3: 实现 chat.service

- [ ] **Step 3: 实现 chat.service.ts**

`src/main/services/chat.service.ts`:

```typescript
// src/main/services/chat.service.ts
// AI 对话业务逻辑层
// 设计文档 §4.2 Services 层职责矩阵 / §6.2 ChatSession / ChatMessage 模型
//
// 职责：
// 1. 对话会话管理（createSession / listSessions）
// 2. 消息管理（getMessages / sendMessage）
// 3. sendChatMessage 持久化用户消息并返回 ackId（实际 AI 调用由 Phase 5b agent.service 编排）
// 4. stopChatGeneration：Phase 5a 占位（5b 实现 AbortController 管理）
//
// 注意：
// - 不与其他 service 互相依赖
// - AI 流式响应转发由 Phase 5b agent.service + stream-bridge 完成

import {
  AppError,
  ChatRole,
  ErrorCode,
  type ChatMessage,
  type ChatSendMessageInput,
  type ChatSession,
  type ChatSessionCreateInput,
} from '@novel-writer/shared';
import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { getPrismaClient } from '../infra/prisma/client';
import { logger } from '../utils/logger';

/**
 * 创建对话会话
 */
export async function createChatSession(
  input: ChatSessionCreateInput,
): Promise<ChatSession> {
  const prisma = getPrismaClient();
  logger.info({ projectId: input.projectId, title: input.title }, '创建对话会话');

  const created = await prisma.chatSession.create({
    data: {
      projectId: input.projectId,
      title: input.title,
      model: input.model,
      context: {},
    },
  });

  return serializeChatSession(created);
}

/**
 * 列出项目下所有对话会话（按 updatedAt 倒序）
 */
export async function listChatSessions(projectId: string): Promise<ChatSession[]> {
  const prisma = getPrismaClient();
  const sessions = await prisma.chatSession.findMany({
    where: { projectId },
    orderBy: { updatedAt: 'desc' },
  });
  return sessions.map(serializeChatSession);
}

/**
 * 获取会话消息列表（按 createdAt 升序）
 */
export async function getChatMessages(sessionId: string): Promise<ChatMessage[]> {
  const prisma = getPrismaClient();
  const messages = await prisma.chatMessage.findMany({
    where: { sessionId },
    orderBy: { createdAt: 'asc' },
  });
  return messages.map(serializeChatMessage);
}

/**
 * 发送用户消息
 *
 * 1. 校验会话存在
 * 2. 持久化用户消息（role=user）
 * 3. 返回 ackId（UUID），渲染层用 ackId 关联流式响应事件
 *
 * 实际 AI 调用由 Phase 5b agent.service 异步编排，
 * 通过 stream-bridge 推送 chat:stream:chunk 事件
 *
 * @throws AppError(NOT_FOUND) 会话不存在
 */
export async function sendChatMessage(
  input: ChatSendMessageInput,
): Promise<{ ackId: string }> {
  const prisma = getPrismaClient();

  // 校验会话存在
  const session = await prisma.chatSession.findUnique({
    where: { id: input.sessionId },
  });
  if (session === null) {
    throw new AppError(ErrorCode.NOT_FOUND, `对话会话不存在：${input.sessionId}`);
  }

  // 持久化用户消息
  await prisma.chatMessage.create({
    data: {
      sessionId: input.sessionId,
      role: ChatRole.USER,
      content: input.content,
      tokens: input.content.length,
      metadata: {},
    },
  });

  const ackId = randomUUID();
  logger.info({ sessionId: input.sessionId, ackId }, '用户消息已持久化，等待 AI 响应');
  return { ackId };
}

/**
 * 停止 AI 生成
 *
 * Phase 5a 占位实现：返回 stopped=false（无活跃生成）
 * Phase 5b 将通过 AbortController 管理实际停止逻辑
 */
export async function stopChatGeneration(
  _sessionId: string,
): Promise<{ stopped: boolean }> {
  // Phase 5a 占位：无实际生成可停止
  // Phase 5b 实现：检查 sessionId 对应的 AbortController，调用 abort()
  return { stopped: false };
}

/**
 * 序列化 Prisma ChatSession 记录为 IPC 兼容的 ChatSession 类型
 */
function serializeChatSession(raw: RawChatSession): ChatSession {
  return {
    id: raw.id,
    projectId: raw.projectId,
    title: raw.title,
    context: raw.context as Record<string, unknown>,
    model: raw.model,
    createdAt: raw.createdAt.toISOString(),
    updatedAt: raw.updatedAt.toISOString(),
  };
}

/**
 * 序列化 Prisma ChatMessage 记录为 IPC 兼容的 ChatMessage 类型
 */
function serializeChatMessage(raw: RawChatMessage): ChatMessage {
  return {
    id: raw.id,
    sessionId: raw.sessionId,
    role: raw.role as ChatMessage['role'],
    content: raw.content,
    tokens: raw.tokens,
    metadata: raw.metadata as Record<string, unknown>,
    createdAt: raw.createdAt.toISOString(),
  };
}

type RawChatSession = Awaited<ReturnType<PrismaClient['chatSession']['findUnique']>>;
type RawChatMessage = Awaited<ReturnType<PrismaClient['chatMessage']['findUnique']>>;
```

### Step 4: 运行测试验证通过

- [ ] **Step 4: 运行测试验证通过**

Run: `pnpm --filter @novel-writer/main exec vitest run src/main/services/chat.service.test.ts`
Expected: PASS — 全部 6 个测试用例通过

### Step 5: typecheck + lint + commit

- [ ] **Step 5: typecheck + lint + commit**

Run:
```
pnpm typecheck
pnpm lint
```
Expected: 0 errors / 0 warnings

```bash
git add src/main/services/chat.service.ts src/main/services/chat.service.test.ts
git commit -m "feat(main): 实现 chat.service 对话会话与消息持久化"
```

---

## Task 6: settings.service

**Files:**
- Create: `src/main/services/settings.service.ts`
- Create: `src/main/services/settings.service.test.ts`

### 实现说明

**SettingsService 函数清单**：

| 函数 | 签名 | 错误码 |
|------|------|--------|
| `getProjectSettings` | `(projectId: string) => Promise<ProjectSetting>` | - |
| `updateProjectSettings` | `(input: ProjectSettingUpdateInput) => Promise<ProjectSetting>` | - |
| `setApiKey` | `(provider: 'deepseek' \| 'ollama', apiKey: string) => Promise<{ ok: boolean }>` | - |
| `testApiKey` | `(provider: 'deepseek' \| 'ollama') => Promise<{ ok: boolean; latencyMs?: number }>` | - |

**业务规则**：
- `getProjectSettings`：每个项目一条 ProjectSetting（PK = projectId），不存在时 upsert 创建默认记录
- `updateProjectSettings`：upsert（不存在则创建）
- `setApiKey`：存储到 keychain（key 为 `deepseek-api-key` / `ollama-api-key`）
- `testApiKey`：Phase 5a 占位实现，返回 `{ ok: false }`（实际 API 调用由 Phase 5b openai-client / embedding-client 完成）

### Step 1: 创建测试文件

- [ ] **Step 1: 创建测试文件**

`src/main/services/settings.service.test.ts`:

```typescript
// src/main/services/settings.service.test.ts
// settings.service 单元测试
// 设计文档 §4.2 Services 层职责矩阵 / §6.2 ProjectSetting / AppSetting 模型

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockPrismaClient, resetMocks } from '../__tests__/helpers/mock-prisma';

const { mockProjectSetting, mockKeychain } = vi.hoisted(() => ({
  mockProjectSetting: {
    findUnique: vi.fn(),
    upsert: vi.fn(),
  },
  mockKeychain: {
    setSecret: vi.fn(),
    getSecret: vi.fn(),
    deleteSecret: vi.fn(),
  },
}));

vi.mock('../infra/prisma/client', () => ({
  getPrismaClient: () => ({
    ...mockPrismaClient,
    projectSetting: mockProjectSetting,
  }),
}));

vi.mock('../infra/storage/keychain', () => mockKeychain);

import {
  getProjectSettings,
  setApiKey,
  testApiKey,
  updateProjectSettings,
} from './settings.service';

describe('settings.service', () => {
  beforeEach(() => {
    resetMocks();
    mockProjectSetting.findUnique.mockReset();
    mockProjectSetting.upsert.mockReset();
    mockKeychain.setSecret.mockReset();
    mockKeychain.getSecret.mockReset();
    mockKeychain.deleteSecret.mockReset();
  });

  describe('getProjectSettings', () => {
    it('应返回已存在的项目设置', async () => {
      const now = new Date();
      mockProjectSetting.findUnique.mockResolvedValue({
        projectId: 'p1',
        aiModel: 'deepseek-v4-flash',
        aiTemperature: 0.7,
        aiMaxTokens: 4096,
        ragEnabled: true,
        ragTopK: 5,
        ragThreshold: 0.7,
        customPrompts: {},
        updatedAt: now,
      });

      const result = await getProjectSettings('p1');

      expect(mockProjectSetting.findUnique).toHaveBeenCalledWith({ where: { projectId: 'p1' } });
      expect(result.projectId).toBe('p1');
      expect(result.aiModel).toBe('deepseek-v4-flash');
    });

    it('设置不存在时应返回默认值（不持久化）', async () => {
      mockProjectSetting.findUnique.mockResolvedValue(null);

      const result = await getProjectSettings('p1');

      expect(result.aiModel).toBe('deepseek-v4-flash');
      expect(result.aiTemperature).toBe(0.7);
      expect(result.ragEnabled).toBe(true);
    });
  });

  describe('updateProjectSettings', () => {
    it('应 upsert 项目设置', async () => {
      const now = new Date();
      mockProjectSetting.upsert.mockResolvedValue({
        projectId: 'p1',
        aiModel: 'deepseek-v4-flash',
        aiTemperature: 0.9,
        aiMaxTokens: 8192,
        ragEnabled: true,
        ragTopK: 10,
        ragThreshold: 0.8,
        customPrompts: {},
        updatedAt: now,
      });

      const result = await updateProjectSettings({
        projectId: 'p1',
        aiTemperature: 0.9,
        aiMaxTokens: 8192,
      });

      expect(mockProjectSetting.upsert).toHaveBeenCalledWith({
        where: { projectId: 'p1' },
        create: expect.objectContaining({
          projectId: 'p1',
          aiTemperature: 0.9,
          aiMaxTokens: 8192,
        }),
        update: expect.objectContaining({
          aiTemperature: 0.9,
          aiMaxTokens: 8192,
        }),
      });
      expect(result.aiTemperature).toBe(0.9);
    });
  });

  describe('setApiKey', () => {
    it('应存储 DeepSeek API Key 到 keychain', async () => {
      mockKeychain.setSecret.mockResolvedValue(undefined);

      const result = await setApiKey('deepseek', 'sk-xxx');

      expect(mockKeychain.setSecret).toHaveBeenCalledWith('deepseek-api-key', 'sk-xxx');
      expect(result).toEqual({ ok: true });
    });

    it('应存储 Ollama API Key 到 keychain', async () => {
      mockKeychain.setSecret.mockResolvedValue(undefined);

      const result = await setApiKey('ollama', 'key-xxx');

      expect(mockKeychain.setSecret).toHaveBeenCalledWith('ollama-api-key', 'key-xxx');
      expect(result).toEqual({ ok: true });
    });
  });

  describe('testApiKey', () => {
    it('Key 不存在时返回 ok=false', async () => {
      mockKeychain.getSecret.mockResolvedValue(null);

      const result = await testApiKey('deepseek');

      expect(mockKeychain.getSecret).toHaveBeenCalledWith('deepseek-api-key');
      expect(result).toEqual({ ok: false });
    });

    it('Phase 5a 占位：Key 存在时返回 ok=false（实际调用在 5b）', async () => {
      mockKeychain.getSecret.mockResolvedValue('sk-xxx');

      const result = await testApiKey('deepseek');

      expect(result.ok).toBe(false);
    });
  });
});
```

### Step 2: 运行测试验证失败

- [ ] **Step 2: 运行测试验证失败**

Run: `pnpm --filter @novel-writer/main exec vitest run src/main/services/settings.service.test.ts`
Expected: FAIL — `Cannot find module './settings.service'`

### Step 3: 实现 settings.service

- [ ] **Step 3: 实现 settings.service.ts**

`src/main/services/settings.service.ts`:

```typescript
// src/main/services/settings.service.ts
// 设置业务逻辑层
// 设计文档 §4.2 Services 层职责矩阵 / §6.2 ProjectSetting / AppSetting 模型
//
// 职责：
// 1. 项目设置管理（getProjectSettings / updateProjectSettings）
// 2. API Key 管理（setApiKey / testApiKey）
//
// 注意：
// - ProjectSetting 是单例（PK = projectId），upsert 创建/更新
// - API Key 存 keychain（设计文档 §1.2 决策 5）
// - testApiKey：Phase 5a 占位（实际 API 调用由 Phase 5b 实现）

import type { ProjectSetting, ProjectSettingUpdateInput } from '@novel-writer/shared';
import type { PrismaClient } from '@prisma/client';
import { getPrismaClient } from '../infra/prisma/client';
import { getSecret, setSecret } from '../infra/storage/keychain';
import { logger } from '../utils/logger';

/**
 * Keychain 中的 API Key 名称映射
 */
const API_KEY_NAMES = {
  deepseek: 'deepseek-api-key',
  ollama: 'ollama-api-key',
} as const;

/**
 * 默认项目设置（设置不存在时返回）
 *
 * 与 Prisma schema 默认值对齐
 */
const DEFAULT_SETTINGS = {
  aiModel: 'deepseek-v4-flash',
  aiTemperature: 0.7,
  aiMaxTokens: 4096,
  ragEnabled: true,
  ragTopK: 5,
  ragThreshold: 0.7,
  customPrompts: {},
} as const;

/**
 * 获取项目设置
 *
 * 设置不存在时返回默认值（不持久化到 DB）
 * 渲染层用返回值渲染设置页，用户保存时调用 updateProjectSettings
 */
export async function getProjectSettings(projectId: string): Promise<ProjectSetting> {
  const prisma = getPrismaClient();

  const found = await prisma.projectSetting.findUnique({
    where: { projectId },
  });

  if (found === null) {
    // 返回默认值，不持久化（避免空项目产生垃圾记录）
    return {
      projectId,
      ...DEFAULT_SETTINGS,
      updatedAt: new Date().toISOString(),
    };
  }

  return serializeProjectSetting(found);
}

/**
 * 更新项目设置（upsert：不存在则创建）
 */
export async function updateProjectSettings(
  input: ProjectSettingUpdateInput,
): Promise<ProjectSetting> {
  const prisma = getPrismaClient();
  logger.info({ projectId: input.projectId }, '更新项目设置');

  // 构造 create / update 数据（合并默认值，确保新记录有完整字段）
  const data = {
    projectId: input.projectId,
    aiModel: input.aiModel ?? DEFAULT_SETTINGS.aiModel,
    aiTemperature: input.aiTemperature ?? DEFAULT_SETTINGS.aiTemperature,
    aiMaxTokens: input.aiMaxTokens ?? DEFAULT_SETTINGS.aiMaxTokens,
    ragEnabled: input.ragEnabled ?? DEFAULT_SETTINGS.ragEnabled,
    ragTopK: input.ragTopK ?? DEFAULT_SETTINGS.ragTopK,
    ragThreshold: input.ragThreshold ?? DEFAULT_SETTINGS.ragThreshold,
    customPrompts: input.customPrompts ?? DEFAULT_SETTINGS.customPrompts,
  };

  const upserted = await prisma.projectSetting.upsert({
    where: { projectId: input.projectId },
    create: data,
    update: data,
  });

  return serializeProjectSetting(upserted);
}

/**
 * 存储 API Key 到 keychain
 *
 * @param provider 服务商（deepseek / ollama）
 * @param apiKey API Key 原文（会被 keychain 加密后存储）
 */
export async function setApiKey(
  provider: 'deepseek' | 'ollama',
  apiKey: string,
): Promise<{ ok: boolean }> {
  const keyName = API_KEY_NAMES[provider];
  await setSecret(keyName, apiKey);
  logger.info({ provider }, 'API Key 已存储到 keychain');
  return { ok: true };
}

/**
 * 测试 API Key 有效性
 *
 * Phase 5a 占位实现：
 * - Key 不存在时返回 ok=false
 * - Key 存在时也返回 ok=false（实际 API 调用由 Phase 5b 实现）
 *
 * Phase 5b 将通过实际调用 DeepSeek / Ollama API 验证 Key
 */
export async function testApiKey(
  provider: 'deepseek' | 'ollama',
): Promise<{ ok: boolean; latencyMs?: number }> {
  const keyName = API_KEY_NAMES[provider];
  const key = await getSecret(keyName);

  if (key === null) {
    return { ok: false };
  }

  // Phase 5a 占位：不实际调用 API
  // Phase 5b 实现：调用 deepseek/ollama 健康检查接口
  logger.info({ provider }, 'API Key 存在，但 Phase 5a 暂未实现实际调用');
  return { ok: false };
}

/**
 * 序列化 Prisma ProjectSetting 记录为 IPC 兼容的 ProjectSetting 类型
 */
function serializeProjectSetting(raw: RawProjectSetting): ProjectSetting {
  return {
    projectId: raw.projectId,
    aiModel: raw.aiModel,
    aiTemperature: raw.aiTemperature,
    aiMaxTokens: raw.aiMaxTokens,
    ragEnabled: raw.ragEnabled,
    ragTopK: raw.ragTopK,
    ragThreshold: raw.ragThreshold,
    customPrompts: raw.customPrompts as Record<string, unknown>,
    updatedAt: raw.updatedAt.toISOString(),
  };
}

type RawProjectSetting = Awaited<
  ReturnType<PrismaClient['projectSetting']['findUnique']>
>;
```

### Step 4: 运行测试验证通过

- [ ] **Step 4: 运行测试验证通过**

Run: `pnpm --filter @novel-writer/main exec vitest run src/main/services/settings.service.test.ts`
Expected: PASS — 全部 8 个测试用例通过

### Step 5: 运行全量测试 + typecheck + lint

- [ ] **Step 5: 运行全量测试 + typecheck + lint**

Run:
```
pnpm test
pnpm typecheck
pnpm lint
```
Expected:
- pnpm test: 全部测试通过（Phase 4b 基线 156 + Phase 5a 新增约 49 = 约 205 测试）
- pnpm typecheck: 0 errors
- pnpm lint: 0 errors

### Step 6: build + commit

- [ ] **Step 6: build + commit**

Run: `pnpm build`
Expected: 三入口产物生成（main / preload / renderer）

```bash
git add src/main/services/settings.service.ts src/main/services/settings.service.test.ts
git commit -m "feat(main): 实现 settings.service 项目设置与 API Key 钥匙串管理"
```

---

## Self-Review

### 1. Spec 覆盖检查

设计文档 §4.2 Services 层职责矩阵中 Phase 5a 范围内的 6 个 service：

| Service | 设计文档职责 | 对应 Task | 覆盖 |
|---------|------------|-----------|------|
| project.service | 项目 CRUD、元数据、归档 | Task 1 | ✅ create/list/get/update/delete/archive |
| chapter.service | 章节/卷宗 CRUD、排序、大纲 | Task 2 | ✅ create/list/get/update/reorder/delete（Volume 未实现，由 Phase 5c/6 按需补充） |
| character.service | 人物卡、人物关系（AGE） | Task 3 | ✅ create/list/update/delete + addRelation/getRelations |
| worldview.service | 世界观条目、设定集（树形） | Task 4 | ✅ create/tree/update/delete |
| chat.service | AI 对话历史、消息持久化 | Task 5 | ✅ createSession/listSessions/getMessages/sendMessage/stopGeneration |
| settings.service | 应用设置、API Key 读写 | Task 6 | ✅ getProjectSettings/updateProjectSettings/setApiKey/testApiKey |

**Volume（卷宗）**：设计文档 §4.2 提到 chapter.service 包含卷宗 CRUD，但当前 IPC channels 中无 volume:* 通道，且 Prisma schema 已有 Volume 模型。Phase 5a 暂不实现 volume.service，留待后续按需补充（YAGNI 原则）。

### 2. 占位符扫描

- ✅ 无 TBD / TODO / "implement later"
- ✅ 所有测试用例包含完整断言代码
- ✅ 所有 service 函数包含完整实现
- ✅ 无 "similar to Task N" 引用，每个 Task 独立完整

### 3. 类型一致性检查

**类型来源对齐**：

| Service | 入参类型 | 返回类型 | 来源 |
|---------|---------|---------|------|
| createProject | ProjectCreateInput | Project | `@novel-writer/shared` schemas |
| createChapter | ChapterCreateInput | Chapter | `@novel-writer/shared` schemas |
| createCharacter | CharacterCreateInput | Character | `@novel-writer/shared` schemas |
| createWorldview | WorldviewCreateInput | Worldview | `@novel-writer/shared` schemas |
| createChatSession | ChatSessionCreateInput | ChatSession | `@novel-writer/shared` schemas |
| getProjectSettings | (projectId: string) | ProjectSetting | `@novel-writer/shared` schemas |

**函数命名一致性**：

| Service | create | list | get | update | delete | 特色方法 |
|---------|--------|------|-----|--------|--------|---------|
| project | createProject | listProjects | getProject | updateProject | deleteProject | archiveProject |
| chapter | createChapter | listChapters | getChapter | updateChapter | deleteChapter | reorderChapters |
| character | createCharacter | listCharacters | - | updateCharacter | deleteCharacter | addCharacterRelation / getCharacterRelations |
| worldview | createWorldview | - | - | updateWorldview | deleteWorldview | getWorldviewTree |
| chat | createChatSession | listChatSessions | - | - | - | getChatMessages / sendChatMessage / stopChatGeneration |
| settings | - | - | getProjectSettings | updateProjectSettings | - | setApiKey / testApiKey |

**命名一致性**：所有 service 使用 `动词 + 实体` 风格（createProject / listProjects 等），对齐设计文档 §4.2 命名约定。

**测试 helper 一致性**：所有测试统一使用 `src/main/__tests__/helpers/mock-prisma.ts` 提供的 `mockPrismaClient` + `resetMocks()`，避免重复定义。

**错误码对齐**：

| Service | 错误码 | 与 errors.ts 对齐 |
|---------|--------|------------------|
| project | PROJECT_NOT_FOUND | ✅ |
| chapter | CHAPTER_NOT_FOUND | ✅ |
| character | CHARACTER_NOT_FOUND | ✅ |
| worldview | NOT_FOUND（无 WORLDVIEW_NOT_FOUND） | ✅ 复用通用 NOT_FOUND |
| chat | NOT_FOUND（无 CHAT_NOT_FOUND） | ✅ 复用通用 NOT_FOUND |
| settings | - | ✅ 无业务错误 |

### 4. Phase 5a 验收清单

执行完所有 6 个 Task 后，运行以下命令应全部通过：

```bash
# 依赖安装（无新增依赖，跳过）
pnpm install

# 类型检查
pnpm typecheck
# Expected: 0 errors

# Lint
pnpm lint
# Expected: 0 errors / 0 warnings（80+6 services + helpers = ~87 files）

# 单元测试
pnpm test
# Expected:
#   shared: 44 测试通过（不变）
#   main: 156 + ~49（Phase 5a 新增）= ~205 测试通过
#   总计 ~249 测试通过

# 构建
pnpm build
# Expected: 三入口产物生成
#   - src/main/index.cjs（包含 services）
#   - src/preload/index.cjs
#   - src/renderer/index.html
```

### 5. 已知偏离与说明

1. **Volume（卷宗）未实现**：设计文档 §4.2 提到 chapter.service 包含卷宗 CRUD，但 IPC channels 中无 `volume:*` 通道。Phase 5a 按 YAGNI 原则暂不实现，留待渲染层明确需求后补充。

2. **stopChatGeneration 占位**：Phase 5a 返回 `{ stopped: false }`，实际 AbortController 管理在 Phase 5b 与 stream-bridge 集成时实现。

3. **testApiKey 占位**：Phase 5a 返回 `{ ok: false }`（即使 Key 存在），实际 API 调用由 Phase 5b openai-client / embedding-client 完成。

4. **getProjectSettings 不持久化默认值**：设置不存在时返回内存中的默认值（不写入 DB），避免空项目产生垃圾记录。用户保存时通过 `updateProjectSettings` upsert。

5. **AGE 操作容错**：character.service 在 create/update/delete 时同步操作 AGE，AGE 失败仅 warn 日志不阻塞 Prisma 业务（保证主流程可用，符合 §6.5 AGE 兼容性降级策略）。

### 6. 依赖与影响分析

**新增依赖**：无（复用 `@prisma/client` / `@novel-writer/shared` / 已有 infra 模块）

**影响范围**：
- 新增 `src/main/services/` 目录（6 个 service + 6 个测试）
- 新增 `src/main/__tests__/helpers/mock-prisma.ts`（共享 mock 工具）
- 不修改任何现有文件
- 不影响 Phase 4b 的 156 个测试

**后续阶段衔接**：
- Phase 5b：3 个 AI 相关 service（embedding/rag/agent）将调用 Phase 5a 的 chat.service 持久化 AI 消息
- Phase 6：IPC handlers 将调用 Phase 5a 的 service 函数
- Phase 7+：渲染层通过 IPC 调用 service 层

---

## 执行选项

**计划已保存到** `docs/superpowers/plans/2026-07-19-phase5a-basic-services.md`。

**两种执行方式**：

**1. Subagent-Driven（推荐）** — 每个 Task 派发独立子代理，主线程 review 后继续下一 Task，快速迭代

**2. Inline Execution** — 在当前会话内按顺序执行，带 checkpoint review

**推荐 Subagent-Driven**：6 个 Task 相互独立（除共享 mock helper 外），适合并行派发；每个 Task 可独立验证（运行测试 + typecheck + lint）。
