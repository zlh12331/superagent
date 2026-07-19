# Phase 5b: AI Service 层实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 embedding / rag / agent 3 个 AI 相关 Service，并补全 Phase 5a 遗留的 chat.service.stopChatGeneration 与 settings.service.testApiKey 两个占位实现，打通「RAG 检索 → Prompt 编排 → DeepSeek 流式生成 → StreamBridge 推送 → 消息持久化 → 用量日志」完整链路。

**Architecture:** Service 层仍为纯函数模块。`embedding.service` 包装 infra 层 embedding-client（Ollama）；`rag.service` 负责文档切片 + 向量入库（raw SQL 写 halfvec）+ 余弦相似度检索（raw SQL 读）；`agent.service` 是唯一允许编排其他 service 的模块（设计文档 §4.4），负责构造 prompt、调用 openai-client 流式生成、通过 StreamBridge 单例推送到渲染层、流结束后持久化结果。AI 用量统一写入 `ai_usage_logs` 表（status: ok/error）。WebContents 由 Phase 6 IPC handler 注入，service 不自行获取窗口。

**Tech Stack:**
- openai 5 SDK（DeepSeek 聊天流式 + Ollama 嵌入，均已在 infra 层封装）
- Prisma 7（`$executeRawUnsafe` / `$queryRawUnsafe` 操作 halfvec 向量）
- pgvector halfvec(2048) + 余弦距离运算符 `<=>`
- Vitest 4（colocation 测试，mock openai-client / embedding-client / stream-bridge / 其他 service）
- Biome 2.5.4 / TypeScript 6.0

---

## 文件结构

| 路径 | 职责 | 创建/修改 |
|------|------|----------|
| `src/main/services/ai-usage.ts` | AI 用量日志写入（ai_usage_logs 表） | Create |
| `src/main/services/ai-usage.test.ts` | 用量日志单元测试 | Create |
| `src/main/services/embedding.service.ts` | 嵌入向量生成 + Ollama 连接测试 | Create |
| `src/main/services/embedding.service.test.ts` | 嵌入 service 单元测试 | Create |
| `src/main/services/rag.service.ts` | 文档切片 + 向量入库 + 相似检索 + 文档管理 | Create |
| `src/main/services/rag.service.test.ts` | RAG service 单元测试 | Create |
| `src/main/infra/ai/stream-bridge.ts` | 新增 getStreamBridge 单例访问器（活跃流注册表必须全进程共享） | Modify |
| `src/main/__tests__/stream-bridge.test.ts` | 单例访问器测试 | Modify |
| `src/main/services/chat.service.ts` | stopChatGeneration 真实化 + saveAssistantMessage 新增 | Modify |
| `src/main/services/chat.service.test.ts` | 对应测试更新 | Modify |
| `src/main/services/agent.service.ts` | 写作 Agent 编排（对话/续写/改写/扩写大纲） | Create |
| `src/main/services/agent.service.test.ts` | Agent service 单元测试 | Create |
| `src/main/services/settings.service.ts` | testApiKey 真实 API 调用 | Modify |
| `src/main/services/settings.service.test.ts` | 对应测试更新 | Modify |

**设计原则**：

1. **编排隔离**：仅 `agent.service` 可调用其他 service（chat/rag/chapter/character/worldview + settings 数据），其余 service 互不依赖（设计文档 §4.4）
2. **向量不出主进程**：embedding 向量只在 rag.service 内部通过 raw SQL 读写，不跨 IPC、不出现在任何返回值中
3. **流式三段式**：`openai stream → 提取文本 chunk（async generator）→ StreamBridge 推送`，stream-bridge 的 `chunkToString` 对 openai 原始 chunk 对象会 JSON.stringify，因此 agent 必须先映射为纯文本 chunk
4. **ackId 即流 ID**：agent 的 3 个生成方法先返回 `{ ackId }`（UUID v4），后台异步执行流式生成，渲染层用 ackId 关联 `chat:stream:*` 事件（ackId 作为 StreamBridge 的 sessionId）
5. **用量必记**：每次 AI 调用（成功或失败）都写 `ai_usage_logs`，失败时 status='error' + error 消息，写日志本身失败仅 warn 不阻塞
6. **测试 mock 边界**：service 测试 mock infra 层（openai-client / embedding-client / stream-bridge）与其他 service（agent 测试中 mock chat/rag 等），不 mock PrismaClient 以外的内部实现

**通用约定**（延续 Phase 5a）：

- Prisma Date 字段在 service 边界 `.toISOString()` 序列化
- `exactOptionalPropertyTypes: true`：可选字段用条件展开 `...(x !== undefined ? { x } : {})`
- Prisma Json 字段赋值用 `as never`（与 5a 既有模式一致）
- `noUncheckedIndexedAccess: true`：数组下标访问需可选链
- vi.mock 用 `vi.hoisted` 模式避免 TDZ
- commitlint subject 不大写开头（用中文开头）；scope 白名单：`main / renderer / preload / shared / ipc / prisma / ai / rag / pg / e2e / deps`

---

## Task 1: ai-usage + embedding.service

**Files:**
- Create: `src/main/services/ai-usage.ts`
- Create: `src/main/services/ai-usage.test.ts`
- Create: `src/main/services/embedding.service.ts`
- Create: `src/main/services/embedding.service.test.ts`

### 实现说明

**ai-usage 函数清单**（独立小模块，供 embedding / agent 复用，避免互相 import）：

| 函数 | 签名 | 说明 |
|------|------|------|
| `logAiUsage` | `(input: LogAiUsageInput) => Promise<void>` | 写 ai_usage_logs，失败仅 warn |

```typescript
interface LogAiUsageInput {
  provider: string;      // 'deepseek' | 'ollama'
  model: string;
  inputTokens?: number;  // 默认 0
  outputTokens?: number; // 默认 0
  durationMs?: number;   // 默认 0
  status: 'ok' | 'error';
  error?: string;        // status=error 时的错误消息
}
```

**embedding.service 函数清单**：

| 函数 | 签名 | 错误码 |
|------|------|--------|
| `embedTexts` | `(texts: string[]) => Promise<number[][]>` | RAG_EMBEDDING_FAILED |
| `testEmbeddingConnection` | `() => Promise<{ ok: boolean; latencyMs?: number }>` | 不抛出，失败返回 ok=false |

**业务规则**：
- `embedTexts`：空数组直接返回 `[]`（不发请求）；调用 infra `embed()`，任何异常包装为 `AppError(RAG_EMBEDDING_FAILED)`；成功后 `logAiUsage({ provider: 'ollama', status: 'ok' })`（inputTokens 用文本总字符数估算）；失败也记 `status: 'error'` 后 rethrow
- `testEmbeddingConnection`：用 `embed(['ping'])` 做健康检查，记录耗时；任何异常返回 `{ ok: false }`（不抛出），供 settings.testApiKey('ollama') 使用

### Step 1: 创建测试文件

- [ ] **Step 1: 创建测试文件**

`src/main/services/ai-usage.test.ts`:

```typescript
// src/main/services/ai-usage.test.ts
// ai-usage 单元测试
// 设计文档 §6.2 AiUsageLog 模型

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockPrismaClient, resetMocks } from '../__tests__/helpers/mock-prisma';

const { mockAiUsageLog } = vi.hoisted(() => ({
  mockAiUsageLog: {
    create: vi.fn(),
  },
}));

vi.mock('../infra/prisma/client', () => ({
  getPrismaClient: () => ({
    ...mockPrismaClient,
    aiUsageLog: mockAiUsageLog,
  }),
}));

import { logAiUsage } from './ai-usage';

describe('ai-usage', () => {
  beforeEach(() => {
    resetMocks();
    mockAiUsageLog.create.mockReset();
  });

  describe('logAiUsage', () => {
    it('应写入成功用量记录', async () => {
      mockAiUsageLog.create.mockResolvedValue({});

      await logAiUsage({
        provider: 'deepseek',
        model: 'deepseek-v4-flash',
        inputTokens: 100,
        outputTokens: 200,
        durationMs: 1500,
        status: 'ok',
      });

      expect(mockAiUsageLog.create).toHaveBeenCalledWith({
        data: {
          provider: 'deepseek',
          model: 'deepseek-v4-flash',
          inputTokens: 100,
          outputTokens: 200,
          durationMs: 1500,
          status: 'ok',
        },
      });
    });

    it('可选字段缺省时应用默认值 0', async () => {
      mockAiUsageLog.create.mockResolvedValue({});

      await logAiUsage({ provider: 'ollama', model: 'nemotron-3-embed-1b-bf16', status: 'ok' });

      expect(mockAiUsageLog.create).toHaveBeenCalledWith({
        data: {
          provider: 'ollama',
          model: 'nemotron-3-embed-1b-bf16',
          inputTokens: 0,
          outputTokens: 0,
          durationMs: 0,
          status: 'ok',
        },
      });
    });

    it('status=error 时应写入 error 字段', async () => {
      mockAiUsageLog.create.mockResolvedValue({});

      await logAiUsage({
        provider: 'deepseek',
        model: 'deepseek-v4-flash',
        status: 'error',
        error: 'HTTP 429',
      });

      expect(mockAiUsageLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ status: 'error', error: 'HTTP 429' }),
      });
    });

    it('DB 写入失败时应吞掉异常（仅 warn，不阻塞业务流程）', async () => {
      mockAiUsageLog.create.mockRejectedValue(new Error('DB down'));

      await expect(
        logAiUsage({ provider: 'deepseek', model: 'm', status: 'ok' }),
      ).resolves.toBeUndefined();
    });
  });
});
```

`src/main/services/embedding.service.test.ts`:

```typescript
// src/main/services/embedding.service.test.ts
// embedding.service 单元测试
// 设计文档 §4.2 embedding.service / §6.6 Ollama 嵌入

import { AppError, ErrorCode } from '@novel-writer/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockEmbed, mockLogAiUsage } = vi.hoisted(() => ({
  mockEmbed: vi.fn(),
  mockLogAiUsage: vi.fn(),
}));

vi.mock('../infra/ai/embedding-client', () => ({
  embed: mockEmbed,
}));

vi.mock('./ai-usage', () => ({
  logAiUsage: mockLogAiUsage,
}));

import { embedTexts, testEmbeddingConnection } from './embedding.service';

describe('embedding.service', () => {
  beforeEach(() => {
    mockEmbed.mockReset();
    mockLogAiUsage.mockReset();
    mockLogAiUsage.mockResolvedValue(undefined);
  });

  describe('embedTexts', () => {
    it('空数组应直接返回空，不调用 infra embed', async () => {
      const result = await embedTexts([]);

      expect(result).toEqual([]);
      expect(mockEmbed).not.toHaveBeenCalled();
    });

    it('应调用 infra embed 并返回向量，同时记录用量', async () => {
      const vectors = [
        [0.1, 0.2],
        [0.3, 0.4],
      ];
      mockEmbed.mockResolvedValue(vectors);

      const result = await embedTexts(['你好', '世界']);

      expect(mockEmbed).toHaveBeenCalledWith(['你好', '世界']);
      expect(result).toEqual(vectors);
      expect(mockLogAiUsage).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: 'ollama',
          status: 'ok',
          inputTokens: 4, // '你好'.length + '世界'.length
        }),
      );
    });

    it('infra embed 失败应包装为 RAG_EMBEDDING_FAILED 并记录 error 用量', async () => {
      mockEmbed.mockRejectedValue(new Error('connection refused'));

      await expect(embedTexts(['x'])).rejects.toMatchObject({
        code: ErrorCode.RAG_EMBEDDING_FAILED,
      });
      expect(mockLogAiUsage).toHaveBeenCalledWith(
        expect.objectContaining({ provider: 'ollama', status: 'error', error: 'connection refused' }),
      );
    });

    it('非 Error 异常应转为字符串记录', async () => {
      mockEmbed.mockRejectedValue('字符串异常');

      await expect(embedTexts(['x'])).rejects.toBeInstanceOf(AppError);
      expect(mockLogAiUsage).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'error', error: '字符串异常' }),
      );
    });
  });

  describe('testEmbeddingConnection', () => {
    it('embed 成功应返回 ok=true 与 latencyMs', async () => {
      mockEmbed.mockResolvedValue([[0.1]]);

      const result = await testEmbeddingConnection();

      expect(mockEmbed).toHaveBeenCalledWith(['ping']);
      expect(result.ok).toBe(true);
      expect(result.latencyMs).toEqual(expect.any(Number));
    });

    it('embed 失败应返回 ok=false（不抛出异常）', async () => {
      mockEmbed.mockRejectedValue(new Error('ollama down'));

      const result = await testEmbeddingConnection();

      expect(result).toEqual({ ok: false });
    });
  });
});
```

### Step 2: 运行测试验证失败

- [ ] **Step 2: 运行测试验证失败**

Run: `pnpm --filter @novel-writer/main exec vitest run src/main/services/ai-usage.test.ts src/main/services/embedding.service.test.ts`
Expected: FAIL — `Cannot find module './ai-usage'` / `Cannot find module './embedding.service'`

### Step 3: 实现 ai-usage + embedding.service

- [ ] **Step 3: 实现 ai-usage.ts**

`src/main/services/ai-usage.ts`:

```typescript
// src/main/services/ai-usage.ts
// AI 用量日志模块（ai_usage_logs 表）
// 设计文档 §6.2 AiUsageLog 模型
//
// 职责：
// 1. 统一记录每次 AI 调用（DeepSeek 聊天 / Ollama 嵌入）的 token 与耗时
// 2. 成功（status=ok）与失败（status=error）都记录，用于成本与稳定性分析
//
// 注意：
// - 独立小模块，供 embedding.service / agent.service 复用（避免 service 互相 import）
// - 写日志失败仅 warn，不阻塞业务流程（用量丢失可接受，业务中断不可接受）

import { getPrismaClient } from '../infra/prisma/client';
import { logger } from '../utils/logger';

/** logAiUsage 入参 */
export interface LogAiUsageInput {
  /** 服务商（deepseek / ollama） */
  readonly provider: string;
  /** 模型名（deepseek-v4-flash / nemotron-3-embed-1b-bf16） */
  readonly model: string;
  /** 输入 token 数（估算值，缺省 0） */
  readonly inputTokens?: number;
  /** 输出 token 数（估算值，缺省 0） */
  readonly outputTokens?: number;
  /** 调用耗时（毫秒，缺省 0） */
  readonly durationMs?: number;
  /** 调用结果状态 */
  readonly status: 'ok' | 'error';
  /** 错误消息（status=error 时传入） */
  readonly error?: string;
}

/**
 * 写入 AI 用量日志
 *
 * 失败容错：DB 写入异常时仅 warn 日志，不抛出（不阻塞 AI 业务流程）
 */
export async function logAiUsage(input: LogAiUsageInput): Promise<void> {
  const prisma = getPrismaClient();

  try {
    await prisma.aiUsageLog.create({
      data: {
        provider: input.provider,
        model: input.model,
        inputTokens: input.inputTokens ?? 0,
        outputTokens: input.outputTokens ?? 0,
        durationMs: input.durationMs ?? 0,
        status: input.status,
        // exactOptionalPropertyTypes：error 仅在传入时写入
        ...(input.error !== undefined ? { error: input.error } : {}),
      },
    });
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'AI 用量日志写入失败（不阻塞业务）',
    );
  }
}
```

- [ ] **Step 4: 实现 embedding.service.ts**

`src/main/services/embedding.service.ts`:

```typescript
// src/main/services/embedding.service.ts
// 嵌入向量业务逻辑层
// 设计文档 §4.2 embedding.service / §6.6 Ollama 本地嵌入
//
// 职责：
// 1. embedTexts：批量生成嵌入向量（包装 infra embedding-client，加错误码与用量日志）
// 2. testEmbeddingConnection：Ollama 嵌入服务健康检查（供 settings.testApiKey 使用）
//
// 注意：
// - 向量维度 2048（nemotron-3-embed-1b-bf16），由 infra 层 config 管理
// - 本 service 不做切片，切片在 rag.service 完成
// - 不与其他 service 互相依赖（ai-usage 是共享工具模块，非业务 service）

import { AppError, ErrorCode } from '@novel-writer/shared';
import { getAppConfig } from '../config';
import { embed } from '../infra/ai/embedding-client';
import { logger } from '../utils/logger';
import { logAiUsage } from './ai-usage';

/**
 * 批量生成嵌入向量
 *
 * - 空数组直接返回 []（不发请求）
 * - infra embed 异常统一包装为 AppError(RAG_EMBEDDING_FAILED)
 * - 成功/失败都写用量日志（inputTokens 用文本总字符数估算）
 *
 * @param texts 已切片的文本数组
 * @returns 与输入等长的 2048 维向量数组
 * @throws AppError(RAG_EMBEDDING_FAILED) Ollama 调用失败
 */
export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) {
    return [];
  }

  const embedModel = getAppConfig().ollama.embedModel;
  const start = Date.now();

  try {
    const vectors = await embed(texts);

    // 成功用量（token 用字符数估算，嵌入模型无官方 tokenizer 暴露）
    void logAiUsage({
      provider: 'ollama',
      model: embedModel,
      inputTokens: texts.reduce((sum, t) => sum + t.length, 0),
      durationMs: Date.now() - start,
      status: 'ok',
    });

    return vectors;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    void logAiUsage({
      provider: 'ollama',
      model: embedModel,
      durationMs: Date.now() - start,
      status: 'error',
      error: message,
    });

    logger.error({ err: message, count: texts.length }, '嵌入向量生成失败');
    throw new AppError(ErrorCode.RAG_EMBEDDING_FAILED, `嵌入向量生成失败：${message}`);
  }
}

/**
 * 测试 Ollama 嵌入服务连通性
 *
 * 用 embed(['ping']) 做最小化健康检查。
 * 不抛出异常：失败返回 { ok: false }（供 settings.testApiKey 聚合结果）
 */
export async function testEmbeddingConnection(): Promise<{ ok: boolean; latencyMs?: number }> {
  const start = Date.now();

  try {
    await embed(['ping']);
    return { ok: true, latencyMs: Date.now() - start };
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'Ollama 嵌入服务连通性检查失败',
    );
    return { ok: false };
  }
}
```

### Step 5: 运行测试验证通过

- [ ] **Step 5: 运行测试验证通过**

Run: `pnpm --filter @novel-writer/main exec vitest run src/main/services/ai-usage.test.ts src/main/services/embedding.service.test.ts`
Expected: PASS — 4 + 6 = 10 个测试用例通过

### Step 6: typecheck + lint + commit

- [ ] **Step 6: typecheck + lint + commit**

Run:
```
pnpm typecheck
pnpm lint
```
Expected: 0 errors / 0 warnings

```bash
git add src/main/services/ai-usage.ts src/main/services/ai-usage.test.ts src/main/services/embedding.service.ts src/main/services/embedding.service.test.ts
git commit -m "feat(main): 实现 ai-usage 用量日志与 embedding.service 嵌入服务"
```

---

## Task 2: rag.service

**Files:**
- Create: `src/main/services/rag.service.ts`
- Create: `src/main/services/rag.service.test.ts`

### 实现说明

**RagService 函数清单**：

| 函数 | 签名 | 错误码 |
|------|------|--------|
| `ingestDocument` | `(input: RagIngestDocumentInput) => Promise<{ documentId: string; chunksCount: number }>` | RAG_DOCUMENT_TOO_LARGE / RAG_EMBEDDING_FAILED / INTERNAL_ERROR |
| `searchSimilarChunks` | `(input: RagSearchInput) => Promise<RagSearchResultItem[]>` | RAG_EMBEDDING_FAILED |
| `listRagDocuments` | `(projectId: string) => Promise<RagDocument[]>` | - |
| `deleteRagDocument` | `(id: string) => Promise<{ id: string }>` | NOT_FOUND |

**切片规则**（`chunkText`，模块私有）：

- 按空行（`/\n{2,}/`）切分段落
- 顺序累加段落，单 chunk 不超过 `MAX_CHUNK_SIZE = 800` 字符；超过则截断当前 chunk 入库，开启新 chunk
- 单段落超过 800 字符时按 800 字符硬切（多个连续 chunk）
- 过滤纯空白段落；全文无有效段落时返回 `[]`
- 入参 `fileContent.length > MAX_DOCUMENT_SIZE = 200_000` 时抛 `AppError(RAG_DOCUMENT_TOO_LARGE)`

**入库流程**（`ingestDocument`）：

1. 大小校验 → 2. `chunkText` 切片 → 3. `embedTexts(chunks)` 批量生成向量 → 4. `prisma.ragDocument.create` 创建文档记录 → 5. 逐 chunk `$executeRawUnsafe` 插入（embedding 是 `Unsupported("halfvec(2048)")`，Prisma Client 无法写入，必须 raw SQL；向量数组转 halfvec 字面量格式 `'[0.1,0.2,...]'::halfvec`）→ 6. 更新 `chunksCount` → 返回 `{ documentId, chunksCount }`

**检索流程**（`searchSimilarChunks`）：

1. `embedTexts([query])` 生成查询向量（取 `vectors[0]`，`noUncheckedIndexedAccess` 下需判空，为空抛 `AppError(INTERNAL_ERROR)`）
2. `$queryRawUnsafe` 余弦距离检索：

```sql
SELECT c.id AS "chunkId", c."documentId", c.content,
       1 - (c.embedding <=> $1::halfvec) AS score
FROM rag_document_chunks c
JOIN rag_documents d ON d.id = c."documentId"
WHERE d."projectId" = $2
ORDER BY c.embedding <=> $1::halfvec
LIMIT $3
```

3. 在 JS 侧过滤 `score >= threshold` 并映射为 `RagSearchResultItem[]`（空结果返回 `[]`，不抛 RAG_NO_RESULTS —— 该错误码留给渲染层按需使用）

**业务规则**：
- `listRagDocuments`：按 `createdAt` 倒序
- `deleteRagDocument`：先查存在（不存在抛 NOT_FOUND），DB `onDelete: Cascade` 自动级联删除 chunks
- raw SQL 中的表名/列名用双引号（`@@map` 后是 snake_case 表名 + camelCase 列名，PostgreSQL 大小写敏感）

### Step 1: 创建测试文件

- [ ] **Step 1: 创建测试文件**

`src/main/services/rag.service.test.ts`:

```typescript
// src/main/services/rag.service.test.ts
// rag.service 单元测试
// 设计文档 §4.2 rag.service / §6.2 RagDocument / RagDocumentChunk 模型

import { AppError, ErrorCode } from '@novel-writer/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockPrismaClient, resetMocks } from '../__tests__/helpers/mock-prisma';

const { mockRagDocument, mockEmbedTexts, mockExecuteRaw, mockQueryRaw } = vi.hoisted(() => ({
  mockRagDocument: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  mockEmbedTexts: vi.fn(),
  mockExecuteRaw: vi.fn(),
  mockQueryRaw: vi.fn(),
}));

vi.mock('../infra/prisma/client', () => ({
  getPrismaClient: () => ({
    ...mockPrismaClient,
    ragDocument: mockRagDocument,
    $executeRawUnsafe: mockExecuteRaw,
    $queryRawUnsafe: mockQueryRaw,
  }),
}));

vi.mock('./embedding.service', () => ({
  embedTexts: mockEmbedTexts,
}));

import {
  deleteRagDocument,
  ingestDocument,
  listRagDocuments,
  searchSimilarChunks,
} from './rag.service';

describe('rag.service', () => {
  beforeEach(() => {
    resetMocks();
    mockRagDocument.findUnique.mockReset();
    mockRagDocument.findMany.mockReset();
    mockRagDocument.create.mockReset();
    mockRagDocument.update.mockReset();
    mockRagDocument.delete.mockReset();
    mockEmbedTexts.mockReset();
    mockExecuteRaw.mockReset();
    mockQueryRaw.mockReset();
  });

  describe('ingestDocument', () => {
    it('应按段落切片 → 嵌入 → 建文档 → 逐 chunk raw SQL 插入 → 更新 chunksCount', async () => {
      // 3 个短段落 → 1 个 chunk（累加后未超 800 字符）
      const fileContent = '第一段内容。\n\n第二段内容。\n\n第三段内容。';
      mockEmbedTexts.mockResolvedValue([[0.1, 0.2, 0.3]]);
      mockRagDocument.create.mockResolvedValue({
        id: 'doc1',
        projectId: 'p1',
        title: '设定集',
        source: null,
        mimeType: null,
        chunksCount: 0,
        metadata: {},
        createdAt: new Date(),
      });
      mockExecuteRaw.mockResolvedValue(1);
      mockRagDocument.update.mockResolvedValue({});

      const result = await ingestDocument({
        projectId: 'p1',
        title: '设定集',
        fileContent,
      });

      // 切片结果：3 段落累加为 1 chunk（'第一段内容。\n\n第二段内容。\n\n第三段内容。'）
      expect(mockEmbedTexts).toHaveBeenCalledWith(['第一段内容。\n\n第二段内容。\n\n第三段内容。']);
      expect(mockRagDocument.create).toHaveBeenCalledWith({
        data: {
          projectId: 'p1',
          title: '设定集',
          mimeType: null,
          source: null,
          metadata: {},
        },
      });
      // 1 个 chunk → 1 次 raw SQL 插入
      expect(mockExecuteRaw).toHaveBeenCalledTimes(1);
      const [sql, docId, content, chunkIndex, vectorLiteral] = mockExecuteRaw.mock.calls[0] as [
        string,
        string,
        string,
        number,
        string,
      ];
      expect(sql).toContain('INSERT INTO rag_document_chunks');
      expect(sql).toContain('::halfvec');
      expect(docId).toBe('doc1');
      expect(content).toBe('第一段内容。\n\n第二段内容。\n\n第三段内容。');
      expect(chunkIndex).toBe(0);
      expect(vectorLiteral).toBe('[0.1,0.2,0.3]');
      // chunksCount 更新
      expect(mockRagDocument.update).toHaveBeenCalledWith({
        where: { id: 'doc1' },
        data: { chunksCount: 1 },
      });
      expect(result).toEqual({ documentId: 'doc1', chunksCount: 1 });
    });

    it('长文档应切分为多个 chunk（累加超 800 字符时截断）', async () => {
      // 构造 3 个 500 字符段落：段落1+段落2 累加超 800 → chunk1=段落1, chunk2=段落2, 段落3 → chunk3
      const para = '字'.repeat(500);
      const fileContent = `${para}\n\n${para}\n\n${para}`;
      mockEmbedTexts.mockResolvedValue([
        [0.1],
        [0.2],
        [0.3],
      ]);
      mockRagDocument.create.mockResolvedValue({ id: 'doc1' });
      mockExecuteRaw.mockResolvedValue(1);
      mockRagDocument.update.mockResolvedValue({});

      const result = await ingestDocument({ projectId: 'p1', title: 'T', fileContent });

      expect(mockEmbedTexts).toHaveBeenCalledWith([para, para, para]);
      expect(mockExecuteRaw).toHaveBeenCalledTimes(3);
      expect(result.chunksCount).toBe(3);
    });

    it('单段落超 800 字符应硬切为多个连续 chunk', async () => {
      const fileContent = '字'.repeat(1700); // 1700 / 800 → 3 chunk（800 + 800 + 100）
      mockEmbedTexts.mockResolvedValue([[0.1], [0.2], [0.3]]);
      mockRagDocument.create.mockResolvedValue({ id: 'doc1' });
      mockExecuteRaw.mockResolvedValue(1);
      mockRagDocument.update.mockResolvedValue({});

      const result = await ingestDocument({ projectId: 'p1', title: 'T', fileContent });

      const chunks = mockEmbedTexts.mock.calls[0]?.[0] as string[];
      expect(chunks).toHaveLength(3);
      expect(chunks[0]).toHaveLength(800);
      expect(chunks[1]).toHaveLength(800);
      expect(chunks[2]).toHaveLength(100);
      expect(result.chunksCount).toBe(3);
    });

    it('文档超过 200_000 字符应抛 RAG_DOCUMENT_TOO_LARGE（不调用嵌入）', async () => {
      const fileContent = '字'.repeat(200_001);

      await expect(
        ingestDocument({ projectId: 'p1', title: 'T', fileContent }),
      ).rejects.toMatchObject({ code: ErrorCode.RAG_DOCUMENT_TOO_LARGE });
      expect(mockEmbedTexts).not.toHaveBeenCalled();
      expect(mockRagDocument.create).not.toHaveBeenCalled();
    });

    it('切片后无有效内容应返回 chunksCount=0（不调用嵌入）', async () => {
      mockRagDocument.create.mockResolvedValue({ id: 'doc1' });
      mockRagDocument.update.mockResolvedValue({});

      const result = await ingestDocument({
        projectId: 'p1',
        title: 'T',
        fileContent: '\n\n\n\n', // 纯空行
      });

      expect(mockEmbedTexts).not.toHaveBeenCalled();
      expect(mockExecuteRaw).not.toHaveBeenCalled();
      expect(result).toEqual({ documentId: 'doc1', chunksCount: 0 });
    });
  });

  describe('searchSimilarChunks', () => {
    it('应生成查询向量 → raw SQL 检索 → 按 threshold 过滤映射', async () => {
      mockEmbedTexts.mockResolvedValue([[0.9, 0.8]]);
      mockQueryRaw.mockResolvedValue([
        { chunkId: 'c1', documentId: 'd1', content: '片段一', score: 0.95 },
        { chunkId: 'c2', documentId: 'd1', content: '片段二', score: 0.5 }, // 低于默认 threshold 0.7
      ]);

      const result = await searchSimilarChunks({ projectId: 'p1', query: '主角身世', topK: 5, threshold: 0.7 });

      expect(mockEmbedTexts).toHaveBeenCalledWith(['主角身世']);
      const [sql, vectorLiteral, projectId, topK] = mockQueryRaw.mock.calls[0] as [
        string,
        string,
        string,
        number,
      ];
      expect(sql).toContain('embedding <=>');
      expect(sql).toContain('rag_document_chunks');
      expect(vectorLiteral).toBe('[0.9,0.8]');
      expect(projectId).toBe('p1');
      expect(topK).toBe(5);
      // 只保留 score >= 0.7 的结果
      expect(result).toEqual([
        { chunkId: 'c1', documentId: 'd1', content: '片段一', score: 0.95 },
      ]);
    });

    it('检索结果为空应返回空数组（不抛异常）', async () => {
      mockEmbedTexts.mockResolvedValue([[0.1]]);
      mockQueryRaw.mockResolvedValue([]);

      const result = await searchSimilarChunks({ projectId: 'p1', query: 'q', topK: 5, threshold: 0.7 });

      expect(result).toEqual([]);
    });

    it('嵌入返回空向量数组应抛 INTERNAL_ERROR', async () => {
      mockEmbedTexts.mockResolvedValue([]);

      await expect(
        searchSimilarChunks({ projectId: 'p1', query: 'q', topK: 5, threshold: 0.7 }),
      ).rejects.toMatchObject({ code: ErrorCode.INTERNAL_ERROR });
    });
  });

  describe('listRagDocuments', () => {
    it('应返回文档列表（按 createdAt 倒序）', async () => {
      const now = new Date();
      mockRagDocument.findMany.mockResolvedValue([
        {
          id: 'd1',
          projectId: 'p1',
          title: '设定集',
          source: null,
          mimeType: 'text/plain',
          chunksCount: 3,
          metadata: {},
          createdAt: now,
        },
      ]);

      const result = await listRagDocuments('p1');

      expect(mockRagDocument.findMany).toHaveBeenCalledWith({
        where: { projectId: 'p1' },
        orderBy: { createdAt: 'desc' },
      });
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        id: 'd1',
        title: '设定集',
        chunksCount: 3,
        createdAt: now.toISOString(),
      });
    });
  });

  describe('deleteRagDocument', () => {
    it('应删除文档（DB 级联删除 chunks）', async () => {
      mockRagDocument.findUnique.mockResolvedValue({ id: 'd1' });
      mockRagDocument.delete.mockResolvedValue({});

      const result = await deleteRagDocument('d1');

      expect(mockRagDocument.delete).toHaveBeenCalledWith({ where: { id: 'd1' } });
      expect(result).toEqual({ id: 'd1' });
    });

    it('文档不存在应抛 NOT_FOUND', async () => {
      mockRagDocument.findUnique.mockResolvedValue(null);

      await expect(deleteRagDocument('nope')).rejects.toMatchObject({
        code: ErrorCode.NOT_FOUND,
      });
    });
  });
});
```

### Step 2: 运行测试验证失败

- [ ] **Step 2: 运行测试验证失败**

Run: `pnpm --filter @novel-writer/main exec vitest run src/main/services/rag.service.test.ts`
Expected: FAIL — `Cannot find module './rag.service'`

### Step 3: 实现 rag.service

- [ ] **Step 3: 实现 rag.service.ts**

`src/main/services/rag.service.ts`:

```typescript
// src/main/services/rag.service.ts
// RAG 业务逻辑层
// 设计文档 §4.2 rag.service / §6.2 RagDocument / RagDocumentChunk 模型 / §6.4 HNSW 索引
//
// 职责：
// 1. 文档切片（按段落 + 最大长度硬切）
// 2. 向量入库（embedding 是 Unsupported("halfvec(2048)")，必须 raw SQL 写入）
// 3. 相似检索（pgvector 余弦距离 <=>）
// 4. 文档管理（list / delete）
//
// 注意：
// - 向量只在主进程内流转，不跨 IPC、不出现在返回值中
// - 调用 embedding.service 生成向量（设计文档 §4.2 允许 rag.service 依赖 embedding.service）
// - 表名 snake_case（rag_document_chunks），列名 camelCase（"documentId"），raw SQL 需注意双引号

import {
  AppError,
  ErrorCode,
  type RagDocument,
  type RagIngestDocumentInput,
  type RagSearchInput,
  type RagSearchResultItem,
} from '@novel-writer/shared';
import type { PrismaClient } from '@prisma/client';
import { getPrismaClient } from '../infra/prisma/client';
import { logger } from '../utils/logger';
import { embedTexts } from './embedding.service';

/** 单 chunk 最大字符数（中文按字符计，约 400 token） */
const MAX_CHUNK_SIZE = 800;

/** 入库文档最大字符数（防止超大文档撑爆嵌入与 DB） */
const MAX_DOCUMENT_SIZE = 200_000;

/**
 * 文档入库
 *
 * 流程：大小校验 → 切片 → 批量嵌入 → 建文档记录 → 逐 chunk raw SQL 插入 → 更新 chunksCount
 *
 * @throws AppError(RAG_DOCUMENT_TOO_LARGE) 文档超过 200_000 字符
 * @throws AppError(RAG_EMBEDDING_FAILED) 嵌入失败（由 embedding.service 抛出）
 */
export async function ingestDocument(
  input: RagIngestDocumentInput,
): Promise<{ documentId: string; chunksCount: number }> {
  const prisma = getPrismaClient();
  logger.info({ projectId: input.projectId, title: input.title, size: input.fileContent.length }, '文档入库');

  // 1. 大小校验
  if (input.fileContent.length > MAX_DOCUMENT_SIZE) {
    throw new AppError(
      ErrorCode.RAG_DOCUMENT_TOO_LARGE,
      `文档过大（${input.fileContent.length} 字符，上限 ${MAX_DOCUMENT_SIZE}）`,
    );
  }

  // 2. 切片
  const chunks = chunkText(input.fileContent);

  // 3. 创建文档记录（先建记录拿到 documentId，再插 chunks）
  const document = await prisma.ragDocument.create({
    data: {
      projectId: input.projectId,
      title: input.title,
      mimeType: input.mimeType ?? null,
      source: null,
      metadata: {},
    },
  });

  // 4. 无有效切片：直接返回空文档
  if (chunks.length === 0) {
    logger.warn({ documentId: document.id }, '文档切片后无有效内容');
    return { documentId: document.id, chunksCount: 0 };
  }

  // 5. 批量嵌入
  const vectors = await embedTexts(chunks);

  // 6. 逐 chunk raw SQL 插入（embedding 字段 Prisma Client 不支持，必须 raw SQL）
  for (const [index, chunkContent] of chunks.entries()) {
    const vector = vectors[index];
    if (vector === undefined) {
      throw new AppError(ErrorCode.INTERNAL_ERROR, `嵌入向量数量与切片数量不一致（index=${index}）`);
    }
    const vectorLiteral = `[${vector.join(',')}]`;
    await prisma.$executeRawUnsafe(
      `INSERT INTO rag_document_chunks (id, "documentId", content, "chunkIndex", embedding, metadata, "createdAt")
       VALUES (gen_random_uuid()::text, $1, $2, $3, $4::halfvec, '{}', NOW())`,
      document.id,
      chunkContent,
      index,
      vectorLiteral,
    );
  }

  // 7. 更新 chunksCount
  await prisma.ragDocument.update({
    where: { id: document.id },
    data: { chunksCount: chunks.length },
  });

  logger.info({ documentId: document.id, chunksCount: chunks.length }, '文档入库完成');
  return { documentId: document.id, chunksCount: chunks.length };
}

/**
 * 相似检索
 *
 * 流程：查询向量化 → 余弦距离检索（全表按 projectId JOIN 过滤）→ JS 侧 threshold 过滤
 *
 * 注意：空结果返回 []，不抛 RAG_NO_RESULTS（检索不到是正常业务情况，非错误）
 *
 * @throws AppError(RAG_EMBEDDING_FAILED) 查询向量化失败（由 embedding.service 抛出）
 * @throws AppError(INTERNAL_ERROR) 嵌入返回空向量数组
 */
export async function searchSimilarChunks(input: RagSearchInput): Promise<RagSearchResultItem[]> {
  const prisma = getPrismaClient();
  logger.debug({ projectId: input.projectId, query: input.query, topK: input.topK }, 'RAG 相似检索');

  // 1. 查询向量化
  const vectors = await embedTexts([input.query]);
  const queryVector = vectors[0];
  if (queryVector === undefined) {
    throw new AppError(ErrorCode.INTERNAL_ERROR, '嵌入服务返回空向量数组');
  }
  const vectorLiteral = `[${queryVector.join(',')}]`;

  // 2. 余弦距离检索（<=> 返回距离，1 - 距离 = 相似度 score）
  const rows = await prisma.$queryRawUnsafe<
    { chunkId: string; documentId: string; content: string; score: number }[]
  >(
    `SELECT c.id AS "chunkId", c."documentId", c.content,
            1 - (c.embedding <=> $1::halfvec) AS score
     FROM rag_document_chunks c
     JOIN rag_documents d ON d.id = c."documentId"
     WHERE d."projectId" = $2
     ORDER BY c.embedding <=> $1::halfvec
     LIMIT $3`,
    vectorLiteral,
    input.projectId,
    input.topK,
  );

  // 3. threshold 过滤 + 映射
  return rows
    .filter((row) => row.score >= input.threshold)
    .map((row) => ({
      chunkId: row.chunkId,
      documentId: row.documentId,
      content: row.content,
      score: row.score,
    }));
}

/**
 * 列出项目下所有 RAG 文档（按 createdAt 倒序）
 */
export async function listRagDocuments(projectId: string): Promise<RagDocument[]> {
  const prisma = getPrismaClient();
  const documents = await prisma.ragDocument.findMany({
    where: { projectId },
    orderBy: { createdAt: 'desc' },
  });
  return documents.map(serializeRagDocument);
}

/**
 * 删除 RAG 文档
 *
 * DB 层 onDelete: Cascade 自动级联删除所有 chunks
 *
 * @throws AppError(NOT_FOUND) 文档不存在
 */
export async function deleteRagDocument(id: string): Promise<{ id: string }> {
  const prisma = getPrismaClient();

  const existing = await prisma.ragDocument.findUnique({ where: { id } });
  if (existing === null) {
    throw new AppError(ErrorCode.NOT_FOUND, `RAG 文档不存在：${id}`);
  }

  await prisma.ragDocument.delete({ where: { id } });
  logger.info({ documentId: id }, '删除 RAG 文档（含 chunks 级联）');
  return { id };
}

/**
 * 文本切片
 *
 * 规则：
 * 1. 按空行分段（/\n{2,}/）
 * 2. 顺序累加段落，单 chunk 不超 MAX_CHUNK_SIZE；超过则截断当前 chunk，开新 chunk
 * 3. 单段落超 MAX_CHUNK_SIZE 时硬切为多个连续 chunk
 * 4. 过滤纯空白段落
 *
 * @returns 切片数组（可能为空）
 */
function chunkText(text: string): string[] {
  const paragraphs = text.split(/\n{2,}/).filter((p) => p.trim().length > 0);
  const chunks: string[] = [];
  let current = '';

  for (const paragraph of paragraphs) {
    // 单段落超限：先 flush 当前 chunk，再对段落硬切
    if (paragraph.length > MAX_CHUNK_SIZE) {
      if (current.length > 0) {
        chunks.push(current);
        current = '';
      }
      for (let i = 0; i < paragraph.length; i += MAX_CHUNK_SIZE) {
        chunks.push(paragraph.slice(i, i + MAX_CHUNK_SIZE));
      }
      continue;
    }

    // 累加超限：flush 当前 chunk，段落作为新 chunk 起点
    if (current.length > 0 && current.length + 2 + paragraph.length > MAX_CHUNK_SIZE) {
      chunks.push(current);
      current = paragraph;
      continue;
    }

    // 正常累加（段落间保留空行分隔）
    current = current.length > 0 ? `${current}\n\n${paragraph}` : paragraph;
  }

  if (current.length > 0) {
    chunks.push(current);
  }

  return chunks;
}

/**
 * 序列化 Prisma RagDocument 记录为 IPC 兼容的 RagDocument 类型
 */
function serializeRagDocument(raw: RawRagDocument): RagDocument {
  return {
    id: raw.id,
    projectId: raw.projectId,
    title: raw.title,
    source: raw.source,
    mimeType: raw.mimeType,
    chunksCount: raw.chunksCount,
    metadata: raw.metadata as Record<string, unknown>,
    createdAt: raw.createdAt.toISOString(),
  };
}

/** Prisma ragDocument.findUnique 返回的原始类型 */
type RawRagDocument = NonNullable<Awaited<ReturnType<PrismaClient['ragDocument']['findUnique']>>>;
```

### Step 4: 运行测试验证通过

- [ ] **Step 4: 运行测试验证通过**

Run: `pnpm --filter @novel-writer/main exec vitest run src/main/services/rag.service.test.ts`
Expected: PASS — 全部 10 个测试用例通过

### Step 5: typecheck + lint + commit

- [ ] **Step 5: typecheck + lint + commit**

Run:
```
pnpm typecheck
pnpm lint
```
Expected: 0 errors / 0 warnings

```bash
git add src/main/services/rag.service.ts src/main/services/rag.service.test.ts
git commit -m "feat(main): 实现 rag.service 文档切片向量入库与相似检索"
```

---

## Task 3: stream-bridge 单例访问器 + chat.service 补全（stopChatGeneration 真实化 + saveAssistantMessage）

**Files:**
- Modify: `src/main/infra/ai/stream-bridge.ts`
- Modify: `src/main/__tests__/stream-bridge.test.ts`
- Modify: `src/main/services/chat.service.ts`
- Modify: `src/main/services/chat.service.test.ts`

### 实现说明

**前置变更（infra 层）**：stream-bridge.ts 目前只导出 `StreamBridge` 类，没有单例访问器。但活跃流注册表（`activeStreams` Map）必须在全主进程共享——否则 chat.service 的 `stopChatGeneration` 与 agent.service 的 `streamToWebContents` 各持实例，abort 永远无法生效。因此先给 stream-bridge.ts 追加 `getStreamBridge()` / `resetStreamBridge()`（与 getPrismaClient / getOpenAIClient 单例模式一致）。

**chat.service 变更点**：

| 函数 | 变更 | 说明 |
|------|------|------|
| `stopChatGeneration` | 占位 → 真实实现 | 调 StreamBridge 单例：`has(sessionId)` 为 true 时 `abort(sessionId)` 并返回 `{ stopped: true }`，否则 `{ stopped: false }` |
| `saveAssistantMessage` | 新增 | 供 agent.service 在流结束后持久化 assistant 消息（tokens 用 content.length 估算） |

**设计决策**：`saveAssistantMessage` 放在 chat.service（而非 agent.service 直接写 prisma.chatMessage），因为消息持久化是 chat 域职责（高内聚）；agent.service 通过调用它完成编排（设计文档允许 agent 编排其他 service）。

### Step 1: stream-bridge 追加单例访问器

- [ ] **Step 1: 修改 stream-bridge.ts + 补充单例测试**

**修改 1**：`src/main/infra/ai/stream-bridge.ts` 文件头注释第 6 行后补充一句职责说明：

```typescript
// 6. getStreamBridge 单例访问器（活跃流注册表必须全进程共享，否则跨模块 abort 失效）
```

**修改 2**：`src/main/infra/ai/stream-bridge.ts` 文件末尾（`chunkToString` 函数之后）追加：

```typescript
/** 缓存的 StreamBridge 单例 */
let cachedBridge: StreamBridge | null = null;

/**
 * 获取 StreamBridge 单例
 *
 * activeStreams 注册表必须全主进程共享：
 * agent.service 发起的流注册在单例内，chat.service 的 stopChatGeneration
 * 才能通过同一注册表找到并 abort 对应 sessionId 的流。
 */
export function getStreamBridge(): StreamBridge {
  if (cachedBridge === null) {
    cachedBridge = new StreamBridge();
  }
  return cachedBridge;
}

/**
 * 重置 StreamBridge 单例（仅测试用）
 */
export function resetStreamBridge(): void {
  cachedBridge = null;
}
```

**修改 3**：`src/main/__tests__/stream-bridge.test.ts` 的 import 行改为：

```typescript
import { getStreamBridge, resetStreamBridge, StreamBridge } from '../infra/ai/stream-bridge';
```

**修改 4**：`src/main/__tests__/stream-bridge.test.ts` 文件末尾追加：

```typescript
describe('getStreamBridge 单例', () => {
  it('多次调用应返回同一实例', () => {
    resetStreamBridge();
    const a = getStreamBridge();
    const b = getStreamBridge();
    expect(a).toBe(b);
  });

  it('resetStreamBridge 后应返回新实例', () => {
    resetStreamBridge();
    const a = getStreamBridge();
    resetStreamBridge();
    const b = getStreamBridge();
    expect(a).not.toBe(b);
  });
});
```

- [ ] **Step 2: 运行 stream-bridge 测试验证通过**

Run: `pnpm --filter @novel-writer/main exec vitest run src/main/__tests__/stream-bridge.test.ts`
Expected: PASS — 原有用例 + 新增 2 个单例用例全部通过

### Step 3: 更新 chat.service 测试文件

- [ ] **Step 3: 更新 chat.service.test.ts**

在现有测试文件基础上做三处修改：

**修改 1**：文件头部 vi.hoisted 块与 vi.mock 区域，新增 StreamBridge mock：

```typescript
const { mockChatSession, mockChatMessage, mockStreamBridge } = vi.hoisted(() => ({
  mockChatSession: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
  },
  mockChatMessage: {
    findMany: vi.fn(),
    create: vi.fn(),
  },
  mockStreamBridge: {
    has: vi.fn(),
    abort: vi.fn(),
  },
}));

vi.mock('../infra/prisma/client', () => ({
  getPrismaClient: () => ({
    ...mockPrismaClient,
    chatSession: mockChatSession,
    chatMessage: mockChatMessage,
  }),
}));

vi.mock('../infra/ai/stream-bridge', () => ({
  getStreamBridge: () => mockStreamBridge,
}));
```

import 列表新增 `saveAssistantMessage`。

**修改 2**：beforeEach 中新增 `mockStreamBridge.has.mockReset()` 与 `mockStreamBridge.abort.mockReset()`。

**修改 3**：替换原 `stopChatGeneration` describe 块（删除 Phase 5a 占位用例），并新增 `saveAssistantMessage` describe：

```typescript
  describe('stopChatGeneration', () => {
    it('有活跃流时应调用 abort 并返回 stopped=true', async () => {
      mockStreamBridge.has.mockReturnValue(true);

      const result = await stopChatGeneration('s1');

      expect(mockStreamBridge.has).toHaveBeenCalledWith('s1');
      expect(mockStreamBridge.abort).toHaveBeenCalledWith('s1');
      expect(result).toEqual({ stopped: true });
    });

    it('无活跃流时应返回 stopped=false（不调用 abort）', async () => {
      mockStreamBridge.has.mockReturnValue(false);

      const result = await stopChatGeneration('s1');

      expect(mockStreamBridge.abort).not.toHaveBeenCalled();
      expect(result).toEqual({ stopped: false });
    });
  });

  describe('saveAssistantMessage', () => {
    it('应持久化 assistant 消息（tokens 按 content.length 估算）', async () => {
      const now = new Date();
      mockChatMessage.create.mockResolvedValue({
        id: 'm2',
        sessionId: 's1',
        role: 'assistant',
        content: 'AI 回复内容',
        tokens: 7,
        metadata: {},
        createdAt: now,
      });

      const result = await saveAssistantMessage('s1', 'AI 回复内容');

      expect(mockChatMessage.create).toHaveBeenCalledWith({
        data: {
          sessionId: 's1',
          role: 'assistant',
          content: 'AI 回复内容',
          tokens: 7, // 'AI 回复内容'.length === 7
          metadata: {},
        },
      });
      expect(result.role).toBe('assistant');
      expect(result.createdAt).toBe(now.toISOString());
    });
  });
```

注意：`'AI 回复内容'.length === 7`（A、I、空格、回、复、内、容）。

### Step 4: 运行测试验证失败

- [ ] **Step 4: 运行测试验证失败**

Run: `pnpm --filter @novel-writer/main exec vitest run src/main/services/chat.service.test.ts`
Expected: FAIL — `saveAssistantMessage is not a function`（stopChatGeneration 新用例也会因未接 StreamBridge 而失败）

### Step 5: 修改 chat.service

- [ ] **Step 5: 修改 chat.service.ts**

**修改 1**：文件头注释更新（第 8-9 行附近）：

```typescript
// 3. sendChatMessage 持久化用户消息并返回 ackId（实际 AI 调用由 agent.service 编排）
// 4. stopChatGeneration 通过 StreamBridge 单例中断活跃流
// 5. saveAssistantMessage 供 agent.service 在流结束后持久化 assistant 消息
```

**修改 2**：import 区域新增：

```typescript
import { getStreamBridge } from '../infra/ai/stream-bridge';
```

**修改 3**：替换 `stopChatGeneration` 函数整体：

```typescript
/**
 * 停止 AI 生成
 *
 * 通过 StreamBridge 单例检查并中断 sessionId 对应的活跃流：
 * - 有活跃流：调用 abort()，返回 { stopped: true }
 * - 无活跃流：返回 { stopped: false }
 *
 * @param sessionId 会话 ID（即 StreamBridge 的流 ID）
 */
export async function stopChatGeneration(sessionId: string): Promise<{ stopped: boolean }> {
  const bridge = getStreamBridge();
  if (!bridge.has(sessionId)) {
    return { stopped: false };
  }

  bridge.abort(sessionId);
  logger.info({ sessionId }, '已请求中断 AI 生成');
  return { stopped: true };
}
```

**修改 4**：在 `stopChatGeneration` 之后新增 `saveAssistantMessage`：

```typescript
/**
 * 持久化 assistant 消息
 *
 * 供 agent.service 在流式响应结束后调用。
 * tokens 用 content.length 估算（中文按字符计，与 sendChatMessage 一致）。
 *
 * @param sessionId 会话 ID
 * @param content AI 完整回复文本
 * @returns 持久化后的消息
 */
export async function saveAssistantMessage(
  sessionId: string,
  content: string,
): Promise<ChatMessage> {
  const prisma = getPrismaClient();

  const created = await prisma.chatMessage.create({
    data: {
      sessionId,
      role: ChatRole.ASSISTANT,
      content,
      tokens: content.length,
      metadata: {},
    },
  });

  logger.info({ sessionId, length: content.length }, 'assistant 消息已持久化');
  return serializeChatMessage(created);
}
```

**注意**：`ChatRole.ASSISTANT === 'assistant'`（已核实 packages/shared/src/types/enums.ts：ChatRole 枚举值是小写字符串，与 5a sendChatMessage 用 `ChatRole.USER` 断言 `role: 'user'` 的模式一致）。

### Step 6: 运行测试验证通过

- [ ] **Step 6: 运行测试验证通过**

Run: `pnpm --filter @novel-writer/main exec vitest run src/main/services/chat.service.test.ts`
Expected: PASS — 全部 8 个测试用例通过（原 6 - 占位 1 + 新 3）

### Step 7: typecheck + lint + commit

- [ ] **Step 7: typecheck + lint + commit**

Run:
```
pnpm typecheck
pnpm lint
```
Expected: 0 errors / 0 warnings

```bash
git add src/main/infra/ai/stream-bridge.ts src/main/__tests__/stream-bridge.test.ts src/main/services/chat.service.ts src/main/services/chat.service.test.ts
git commit -m "feat(main): stream-bridge 单例化并补全 chat.service 停止与持久化"
```

---

## Task 4: agent.service

**Files:**
- Create: `src/main/services/agent.service.ts`
- Create: `src/main/services/agent.service.test.ts`

### 实现说明

**AgentService 函数清单**：

| 函数 | 签名 | 说明 |
|------|------|------|
| `runChatGeneration` | `(input: { sessionId: string; webContents: WebContents }) => Promise<void>` | 对话流式生成（chat:sendMessage 后由 IPC handler 调用） |
| `generateChapter` | `(input: { projectId: string; prevChapterId?: string; prompt?: string; webContents: WebContents }) => Promise<{ ackId: string }>` | 续写下一章，流结束后自动创建章节 |
| `rewriteChapter` | `(input: { chapterId: string; instruction: string; webContents: WebContents }) => Promise<{ ackId: string }>` | 改写章节，流结束后自动更新章节内容 |
| `expandOutline` | `(input: { projectId: string; outline: string; webContents: WebContents }) => Promise<{ ackId: string }>` | 扩写大纲（仅流式返回，不持久化） |

**核心流程**（`streamChat` 私有方法，4 个公共函数共用）：

1. 组装 messages（system prompt + 历史 / 任务 prompt）
2. `getOpenAIClient()` 获取客户端（可能抛 AI_API_KEY_MISSING，向上传播）
3. `client.chat.completions.create({ model, messages, temperature, max_tokens, stream: true })`
4. 用私有 async generator `textChunks(stream)` 提取 `chunk.choices[0]?.delta?.content` 纯文本
5. `getStreamBridge().streamToWebContents({ sessionId, webContents, stream: textChunks(...), chunkChannel/endChannel/errorChannel })` 推送并返回 fullText
6. 成功：`logAiUsage({ status: 'ok', outputTokens: fullText.length })`
7. 异常：`bridge` 已推 error 事件（stream-bridge 职责），记 `logAiUsage({ status: 'error' })` 后吞掉异常（不再 rethrow —— 渲染层已通过 error 事件感知）

**各函数编排**：

- `runChatGeneration`：读 session（不存在记 warn 直接返回）→ 读 projectSetting（ragEnabled/topK/threshold/model/temperature/maxTokens，无记录用默认值）→ ragEnabled 时 `searchSimilarChunks` 检索（失败仅 warn 降级为无 RAG）→ 取历史消息（`getChatMessages`）→ system prompt 注入 RAG 片段 → streamChat → fullText 非空时 `saveAssistantMessage`
- `generateChapter`：prevChapterId 传入时 `getChapter` 取前文（取尾部 2000 字符）→ `listCharacters` 取人物 → `searchSimilarChunks` 检索（失败降级）→ 组装续写 prompt → streamChat → fullText 非空时 `createChapter({ projectId, title: 自动生成, content: fullText })`
- `rewriteChapter`：`getChapter` 取原文 → 组装改写 prompt → streamChat → fullText 非空时 `updateChapter({ id, content: fullText })`
- `expandOutline`：组装扩写 prompt → streamChat（不持久化）

**公共约定**：

- ackId = `randomUUID()`，作为 StreamBridge 的 sessionId；函数立即返回 `{ ackId }`，流式生成在后台 Promise 中执行（`.catch` 兜底记 error 日志，防止未处理 Promise rejection）
- 自动章节标题：`'第X章'`（X = 现有章节数 + 1，通过 `listChapters(projectId).length` 计算）；generateChapter 标题前缀 `AI 续写：` 改为该格式
- 前文截断：取 `content.slice(-2000)`（尾部 2000 字符）
- temperature / maxTokens 从 projectSetting 读取，无记录用默认（0.7 / 4096）

### Step 1: 创建测试文件

- [ ] **Step 1: 创建测试文件**

`src/main/services/agent.service.test.ts`:

```typescript
// src/main/services/agent.service.test.ts
// agent.service 单元测试
// 设计文档 §4.2 agent.service / §5.1 场景 3 / 场景 5

import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockGetOpenAIClient,
  mockCreate,
  mockStreamBridge,
  mockLogAiUsage,
  mockSearchSimilarChunks,
  mockGetChatMessages,
  mockSaveAssistantMessage,
  mockGetChapter,
  mockCreateChapter,
  mockUpdateChapter,
  mockListChapters,
  mockListCharacters,
  mockChatSession,
  mockProjectSetting,
} = vi.hoisted(() => ({
  mockGetOpenAIClient: vi.fn(),
  mockCreate: vi.fn(),
  mockStreamBridge: {
    streamToWebContents: vi.fn(),
    has: vi.fn(),
    abort: vi.fn(),
  },
  mockLogAiUsage: vi.fn(),
  mockSearchSimilarChunks: vi.fn(),
  mockGetChatMessages: vi.fn(),
  mockSaveAssistantMessage: vi.fn(),
  mockGetChapter: vi.fn(),
  mockCreateChapter: vi.fn(),
  mockUpdateChapter: vi.fn(),
  mockListChapters: vi.fn(),
  mockListCharacters: vi.fn(),
  mockChatSession: { findUnique: vi.fn() },
  mockProjectSetting: { findUnique: vi.fn() },
}));

vi.mock('../infra/prisma/client', () => ({
  getPrismaClient: () => ({
    chatSession: mockChatSession,
    projectSetting: mockProjectSetting,
  }),
}));

vi.mock('../infra/ai/openai-client', () => ({
  getOpenAIClient: mockGetOpenAIClient,
}));

vi.mock('../infra/ai/stream-bridge', () => ({
  getStreamBridge: () => mockStreamBridge,
}));

vi.mock('./ai-usage', () => ({
  logAiUsage: mockLogAiUsage,
}));

vi.mock('./rag.service', () => ({
  searchSimilarChunks: mockSearchSimilarChunks,
}));

vi.mock('./chat.service', () => ({
  getChatMessages: mockGetChatMessages,
  saveAssistantMessage: mockSaveAssistantMessage,
}));

vi.mock('./chapter.service', () => ({
  getChapter: mockGetChapter,
  createChapter: mockCreateChapter,
  updateChapter: mockUpdateChapter,
  listChapters: mockListChapters,
}));

vi.mock('./character.service', () => ({
  listCharacters: mockListCharacters,
}));

import {
  expandOutline,
  generateChapter,
  rewriteChapter,
  runChatGeneration,
} from './agent.service';

/** 构造 openai 流式 chunk 的 async generator */
async function* fakeOpenAiStream(chunks: string[]) {
  for (const content of chunks) {
    yield { choices: [{ delta: { content } }] };
  }
}

/** 模拟 webContents（仅类型占位，bridge 被 mock 不会真实调用其方法） */
const fakeWebContents = { isDestroyed: () => false, send: vi.fn() } as never;

describe('agent.service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLogAiUsage.mockResolvedValue(undefined);
    // 默认：openai client 返回流；bridge 消费流并返回拼接文本
    mockGetOpenAIClient.mockResolvedValue({
      chat: { completions: { create: mockCreate } },
    });
    mockStreamBridge.streamToWebContents.mockImplementation(
      async ({ stream }: { stream: AsyncIterable<string> }) => {
        let fullText = '';
        for await (const chunk of stream) {
          fullText += chunk;
        }
        return fullText;
      },
    );
  });

  describe('runChatGeneration', () => {
    it('完整链路：RAG 检索 + 历史 + 流式生成 + 持久化 assistant 消息 + 用量记录', async () => {
      mockChatSession.findUnique.mockResolvedValue({
        id: 's1',
        projectId: 'p1',
        title: '讨论',
        context: {},
        model: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      mockProjectSetting.findUnique.mockResolvedValue({
        projectId: 'p1',
        aiModel: 'deepseek-v4-flash',
        aiTemperature: 0.7,
        aiMaxTokens: 4096,
        ragEnabled: true,
        ragTopK: 5,
        ragThreshold: 0.7,
        customPrompts: {},
        updatedAt: new Date(),
      });
      mockSearchSimilarChunks.mockResolvedValue([
        { chunkId: 'c1', documentId: 'd1', content: '主角设定：孤儿', score: 0.9 },
      ]);
      mockGetChatMessages.mockResolvedValue([
        {
          id: 'm1',
          sessionId: 's1',
          role: 'user',
          content: '续写',
          tokens: 2,
          metadata: {},
          createdAt: '2026-07-19T00:00:00.000Z',
        },
      ]);
      mockCreate.mockResolvedValue(fakeOpenAiStream(['林', '逸', '睁', '开', '眼']));
      mockSaveAssistantMessage.mockResolvedValue({});

      await runChatGeneration({ sessionId: 's1', webContents: fakeWebContents });

      // RAG 检索
      expect(mockSearchSimilarChunks).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: 'p1', query: '续写' }),
      );
      // openai 调用：system（含 RAG 片段）+ 历史 user 消息
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'deepseek-v4-flash',
          temperature: 0.7,
          max_tokens: 4096,
          stream: true,
        }),
      );
      const messages = (mockCreate.mock.calls[0]?.[0] as { messages: { role: string; content: string }[] })
        .messages;
      expect(messages[0]?.role).toBe('system');
      expect(messages[0]?.content).toContain('主角设定：孤儿');
      expect(messages[1]).toEqual({ role: 'user', content: '续写' });
      // bridge 推送（sessionId 即流 ID）
      expect(mockStreamBridge.streamToWebContents).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 's1', webContents: fakeWebContents }),
      );
      // assistant 消息持久化
      expect(mockSaveAssistantMessage).toHaveBeenCalledWith('s1', '林逸睁开眼');
      // 用量记录
      expect(mockLogAiUsage).toHaveBeenCalledWith(
        expect.objectContaining({ provider: 'deepseek', status: 'ok', outputTokens: 5 }),
      );
    });

    it('会话不存在时应记 warn 直接返回（不调用 openai）', async () => {
      mockChatSession.findUnique.mockResolvedValue(null);

      await runChatGeneration({ sessionId: 'nope', webContents: fakeWebContents });

      expect(mockCreate).not.toHaveBeenCalled();
    });

    it('ragEnabled=false 时应跳过 RAG 检索', async () => {
      mockChatSession.findUnique.mockResolvedValue({
        id: 's1',
        projectId: 'p1',
        title: 'T',
        context: {},
        model: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      mockProjectSetting.findUnique.mockResolvedValue({
        projectId: 'p1',
        aiModel: 'deepseek-v4-flash',
        aiTemperature: 0.7,
        aiMaxTokens: 4096,
        ragEnabled: false,
        ragTopK: 5,
        ragThreshold: 0.7,
        customPrompts: {},
        updatedAt: new Date(),
      });
      mockGetChatMessages.mockResolvedValue([
        {
          id: 'm1',
          sessionId: 's1',
          role: 'user',
          content: 'hi',
          tokens: 2,
          metadata: {},
          createdAt: '2026-07-19T00:00:00.000Z',
        },
      ]);
      mockCreate.mockResolvedValue(fakeOpenAiStream(['ok']));
      mockSaveAssistantMessage.mockResolvedValue({});

      await runChatGeneration({ sessionId: 's1', webContents: fakeWebContents });

      expect(mockSearchSimilarChunks).not.toHaveBeenCalled();
    });

    it('RAG 检索失败应降级为无 RAG 继续生成（仅 warn）', async () => {
      mockChatSession.findUnique.mockResolvedValue({
        id: 's1',
        projectId: 'p1',
        title: 'T',
        context: {},
        model: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      mockProjectSetting.findUnique.mockResolvedValue(null); // 无设置 → 默认 ragEnabled=true
      mockSearchSimilarChunks.mockRejectedValue(new Error('ollama down'));
      mockGetChatMessages.mockResolvedValue([
        {
          id: 'm1',
          sessionId: 's1',
          role: 'user',
          content: 'hi',
          tokens: 2,
          metadata: {},
          createdAt: '2026-07-19T00:00:00.000Z',
        },
      ]);
      mockCreate.mockResolvedValue(fakeOpenAiStream(['ok']));
      mockSaveAssistantMessage.mockResolvedValue({});

      await runChatGeneration({ sessionId: 's1', webContents: fakeWebContents });

      // 即使 RAG 失败，生成仍继续
      expect(mockCreate).toHaveBeenCalled();
      expect(mockSaveAssistantMessage).toHaveBeenCalledWith('s1', 'ok');
    });

    it('openai 流异常应记录 error 用量（不 rethrow）', async () => {
      mockChatSession.findUnique.mockResolvedValue({
        id: 's1',
        projectId: 'p1',
        title: 'T',
        context: {},
        model: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      mockProjectSetting.findUnique.mockResolvedValue(null);
      mockGetChatMessages.mockResolvedValue([
        {
          id: 'm1',
          sessionId: 's1',
          role: 'user',
          content: 'hi',
          tokens: 2,
          metadata: {},
          createdAt: '2026-07-19T00:00:00.000Z',
        },
      ]);
      mockSearchSimilarChunks.mockResolvedValue([]);
      mockCreate.mockRejectedValue(new Error('HTTP 429'));

      await expect(
        runChatGeneration({ sessionId: 's1', webContents: fakeWebContents }),
      ).resolves.toBeUndefined();

      expect(mockLogAiUsage).toHaveBeenCalledWith(
        expect.objectContaining({ provider: 'deepseek', status: 'error', error: 'HTTP 429' }),
      );
      expect(mockSaveAssistantMessage).not.toHaveBeenCalled();
    });
  });

  describe('generateChapter', () => {
    it('应立即返回 ackId，后台完成：前文+人物+RAG → 流式 → 自动建章', async () => {
      mockGetChapter.mockResolvedValue({
        id: 'ch1',
        projectId: 'p1',
        volumeId: null,
        title: '第一章',
        content: '前文内容',
        wordCount: 4,
        status: 'COMPLETED',
        sortOrder: 0,
        metadata: {},
        createdAt: '2026-07-19T00:00:00.000Z',
        updatedAt: '2026-07-19T00:00:00.000Z',
      });
      mockListChapters.mockResolvedValue([{ id: 'ch1' }]);
      mockListCharacters.mockResolvedValue([
        {
          id: 'c1',
          projectId: 'p1',
          name: '林逸',
          avatar: null,
          role: 'PROTAGONIST',
          description: '主角',
          profile: {},
          createdAt: '2026-07-19T00:00:00.000Z',
          updatedAt: '2026-07-19T00:00:00.000Z',
        },
      ]);
      mockSearchSimilarChunks.mockResolvedValue([
        { chunkId: 'k1', documentId: 'd1', content: '世界观：灵气复苏', score: 0.88 },
      ]);
      mockProjectSetting.findUnique.mockResolvedValue(null);
      mockCreate.mockResolvedValue(fakeOpenAiStream(['新章', '内容']));
      mockCreateChapter.mockResolvedValue({});

      const result = await generateChapter({
        projectId: 'p1',
        prevChapterId: 'ch1',
        webContents: fakeWebContents,
      });

      // 立即返回 ackId（36 位 UUID）
      expect(result.ackId).toHaveLength(36);

      // 等待后台 Promise 完成（ackId 返回后生成仍在进行，这里等微任务+宏任务冲刷）
      await vi.waitFor(() => {
        expect(mockCreateChapter).toHaveBeenCalled();
      });

      // prompt 中应包含前文 / 人物 / RAG 片段
      const messages = (mockCreate.mock.calls[0]?.[0] as { messages: { role: string; content: string }[] })
        .messages;
      const userPrompt = messages.find((m) => m.role === 'user')?.content ?? '';
      expect(userPrompt).toContain('前文内容');
      expect(userPrompt).toContain('林逸');
      expect(userPrompt).toContain('世界观：灵气复苏');

      // 自动创建章节（标题 = 第2章）
      expect(mockCreateChapter).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: 'p1', title: '第2章', content: '新章内容' }),
      );
      // 用量记录
      expect(mockLogAiUsage).toHaveBeenCalledWith(
        expect.objectContaining({ provider: 'deepseek', status: 'ok' }),
      );
    });

    it('prevChapterId 未传时应跳过前文获取', async () => {
      mockListChapters.mockResolvedValue([]);
      mockListCharacters.mockResolvedValue([]);
      mockSearchSimilarChunks.mockResolvedValue([]);
      mockProjectSetting.findUnique.mockResolvedValue(null);
      mockCreate.mockResolvedValue(fakeOpenAiStream(['x']));
      mockCreateChapter.mockResolvedValue({});

      const result = await generateChapter({ projectId: 'p1', webContents: fakeWebContents });

      expect(result.ackId).toHaveLength(36);
      await vi.waitFor(() => {
        expect(mockCreateChapter).toHaveBeenCalled();
      });
      expect(mockGetChapter).not.toHaveBeenCalled();
      expect(mockCreateChapter).toHaveBeenCalledWith(
        expect.objectContaining({ title: '第1章' }),
      );
    });
  });

  describe('rewriteChapter', () => {
    it('应取原文 → 改写 prompt → 流式 → 更新章节内容', async () => {
      mockGetChapter.mockResolvedValue({
        id: 'ch1',
        projectId: 'p1',
        volumeId: null,
        title: '第一章',
        content: '原始内容',
        wordCount: 4,
        status: 'DRAFT',
        sortOrder: 0,
        metadata: {},
        createdAt: '2026-07-19T00:00:00.000Z',
        updatedAt: '2026-07-19T00:00:00.000Z',
      });
      mockProjectSetting.findUnique.mockResolvedValue(null);
      mockCreate.mockResolvedValue(fakeOpenAiStream(['改写后']));
      mockUpdateChapter.mockResolvedValue({});

      const result = await rewriteChapter({
        chapterId: 'ch1',
        instruction: '加强打斗描写',
        webContents: fakeWebContents,
      });

      expect(result.ackId).toHaveLength(36);
      await vi.waitFor(() => {
        expect(mockUpdateChapter).toHaveBeenCalled();
      });

      const messages = (mockCreate.mock.calls[0]?.[0] as { messages: { role: string; content: string }[] })
        .messages;
      const userPrompt = messages.find((m) => m.role === 'user')?.content ?? '';
      expect(userPrompt).toContain('原始内容');
      expect(userPrompt).toContain('加强打斗描写');
      expect(mockUpdateChapter).toHaveBeenCalledWith({ id: 'ch1', content: '改写后' });
    });
  });

  describe('expandOutline', () => {
    it('应流式扩写大纲（不持久化任何内容）', async () => {
      mockProjectSetting.findUnique.mockResolvedValue(null);
      mockCreate.mockResolvedValue(fakeOpenAiStream(['详细', '大纲']));

      const result = await expandOutline({
        projectId: 'p1',
        outline: '主角下山历练',
        webContents: fakeWebContents,
      });

      expect(result.ackId).toHaveLength(36);
      await vi.waitFor(() => {
        expect(mockLogAiUsage).toHaveBeenCalledWith(
          expect.objectContaining({ status: 'ok' }),
        );
      });

      const messages = (mockCreate.mock.calls[0]?.[0] as { messages: { role: string; content: string }[] })
        .messages;
      const userPrompt = messages.find((m) => m.role === 'user')?.content ?? '';
      expect(userPrompt).toContain('主角下山历练');
      // 不持久化
      expect(mockCreateChapter).not.toHaveBeenCalled();
      expect(mockUpdateChapter).not.toHaveBeenCalled();
      expect(mockSaveAssistantMessage).not.toHaveBeenCalled();
    });
  });
});
```

### Step 2: 运行测试验证失败

- [ ] **Step 2: 运行测试验证失败**

Run: `pnpm --filter @novel-writer/main exec vitest run src/main/services/agent.service.test.ts`
Expected: FAIL — `Cannot find module './agent.service'`

### Step 3: 实现 agent.service

- [ ] **Step 3: 实现 agent.service.ts**

`src/main/services/agent.service.ts`:

```typescript
// src/main/services/agent.service.ts
// 写作 Agent 编排层
// 设计文档 §4.2 agent.service / §5.1 场景 3（AI 流式对话）/ 场景 5（Agent 章节生成）
//
// 职责：
// 1. runChatGeneration：对话流式生成（RAG + 历史 → DeepSeek 流式 → 持久化 assistant 消息）
// 2. generateChapter：续写下一章（前文 + 人物 + RAG → 流式 → 自动建章）
// 3. rewriteChapter：改写章节（原文 + 指令 → 流式 → 自动更新）
// 4. expandOutline：扩写大纲（仅流式返回，不持久化）
//
// 注意：
// - 本模块是设计文档 §4.4 唯一允许编排其他 service 的模块
// - 流式三段式：openai stream → textChunks 提取纯文本 → StreamBridge 推送
// - ackId（UUID）作为 StreamBridge 的流 ID，函数立即返回，生成在后台执行
// - 流异常由 StreamBridge 推 error 事件，本层记 error 用量后吞掉（不 rethrow）

import { randomUUID } from 'node:crypto';
import type { WebContents } from 'electron';
import type { ChatStreamChunkPayload } from '@novel-writer/shared';
import { IPC_CHANNELS } from '@novel-writer/shared';
import { getAppConfig } from '../config';
import { getOpenAIClient } from '../infra/ai/openai-client';
import { getStreamBridge } from '../infra/ai/stream-bridge';
import { getPrismaClient } from '../infra/prisma/client';
import { logger } from '../utils/logger';
import { logAiUsage } from './ai-usage';
import { createChapter, getChapter, listChapters, updateChapter } from './chapter.service';
import { listCharacters } from './character.service';
import { getChatMessages, saveAssistantMessage } from './chat.service';
import { searchSimilarChunks } from './rag.service';

/** 前文截断长度（取尾部 N 字符，控制 prompt 体积） */
const PREV_CONTENT_TAIL_LENGTH = 2000;

/** 系统 prompt（对话与创作共用基础人设） */
const SYSTEM_PROMPT = `你是一位专业的中文网络小说写作助手。你的职责：
1. 根据用户提供的上下文（章节、人物、世界观、检索片段）进行创作辅助
2. 输出流畅、符合网文风格的中文文本
3. 严格保持与既有设定一致（人物性格、世界观规则）`;

/** openai chat message 项 */
interface ChatMessageItem {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** 项目 AI 设置（projectSetting 表 + 默认值兜底） */
interface ResolvedAiSettings {
  aiModel: string;
  aiTemperature: number;
  aiMaxTokens: number;
  ragEnabled: boolean;
  ragTopK: number;
  ragThreshold: number;
}

/** streamChat 入参 */
interface StreamChatInput {
  /** 流 ID（ackId / sessionId） */
  readonly streamId: string;
  readonly webContents: WebContents;
  readonly messages: ChatMessageItem[];
  readonly settings: ResolvedAiSettings;
}

/**
 * 对话流式生成
 *
 * chat:sendMessage 持久化用户消息后，由 IPC handler 调用本函数。
 * 流程：读 session → 读设置 → RAG 检索（失败降级）→ 取历史 → 流式生成 → 持久化 assistant 消息
 */
export async function runChatGeneration(input: {
  sessionId: string;
  webContents: WebContents;
}): Promise<void> {
  const prisma = getPrismaClient();
  const { sessionId, webContents } = input;

  // 1. 校验会话存在（不存在记 warn 直接返回，属异常时序：消息已发但会话被删）
  const session = await prisma.chatSession.findUnique({ where: { id: sessionId } });
  if (session === null) {
    logger.warn({ sessionId }, 'runChatGeneration：会话不存在，跳过生成');
    return;
  }

  // 2. 读取项目 AI 设置
  const settings = await resolveAiSettings(session.projectId);

  // 3. 取历史消息
  const history = await getChatMessages(sessionId);
  const lastUserMessage = [...history].reverse().find((m) => m.role === 'user');

  // 4. RAG 检索（失败降级为无 RAG，仅 warn）
  let ragContext = '';
  if (settings.ragEnabled && lastUserMessage !== undefined) {
    try {
      const chunks = await searchSimilarChunks({
        projectId: session.projectId,
        query: lastUserMessage.content,
        topK: settings.ragTopK,
        threshold: settings.ragThreshold,
      });
      if (chunks.length > 0) {
        ragContext = `\n\n# 检索到的相关片段\n${chunks
          .map((c) => `- [相关度 ${c.score.toFixed(2)}] ${c.content}`)
          .join('\n')}`;
      }
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'RAG 检索失败，降级为无 RAG 生成',
      );
    }
  }

  // 5. 组装 messages（system 注入 RAG 上下文 + 全部历史）
  const messages: ChatMessageItem[] = [
    { role: 'system', content: SYSTEM_PROMPT + ragContext },
    ...history.map((m) => ({ role: m.role, content: m.content })),
  ];

  // 6. 流式生成 + 持久化
  const fullText = await streamChat({ streamId: sessionId, webContents, messages, settings });
  if (fullText.length > 0) {
    await saveAssistantMessage(sessionId, fullText);
  }
}

/**
 * 续写下一章
 *
 * 立即返回 { ackId }，后台流式生成，fullText 非空时自动创建章节。
 */
export async function generateChapter(input: {
  projectId: string;
  prevChapterId?: string;
  prompt?: string;
  webContents: WebContents;
}): Promise<{ ackId: string }> {
  const ackId = randomUUID();

  // 后台异步执行（catch 兜底防止未处理 rejection）
  void doGenerateChapter(ackId, input).catch((err: unknown) => {
    logger.error(
      { ackId, err: err instanceof Error ? err.message : String(err) },
      'generateChapter 后台执行异常',
    );
  });

  return { ackId };
}

/** generateChapter 后台执行体 */
async function doGenerateChapter(
  ackId: string,
  input: {
    projectId: string;
    prevChapterId?: string;
    prompt?: string;
    webContents: WebContents;
  },
): Promise<void> {
  const settings = await resolveAiSettings(input.projectId);

  // 1. 前文（取尾部 PREV_CONTENT_TAIL_LENGTH 字符）
  let prevSection = '（无前文，从第一章开始）';
  if (input.prevChapterId !== undefined) {
    const prev = await getChapter(input.prevChapterId);
    prevSection = `标题：${prev.title}\n内容（尾部截断）：\n${prev.content.slice(-PREV_CONTENT_TAIL_LENGTH)}`;
  }

  // 2. 人物列表
  const characters = await listCharacters(input.projectId);
  const characterSection =
    characters.length > 0
      ? characters.map((c) => `- ${c.name}（${c.role}）：${c.description ?? '无描述'}`).join('\n')
      : '（暂无人物）';

  // 3. RAG 检索（失败降级）
  let ragSection = '（无检索片段）';
  if (settings.ragEnabled) {
    try {
      const chunks = await searchSimilarChunks({
        projectId: input.projectId,
        query: input.prompt ?? '续写下一章',
        topK: settings.ragTopK,
        threshold: settings.ragThreshold,
      });
      if (chunks.length > 0) {
        ragSection = chunks.map((c) => `- ${c.content}`).join('\n');
      }
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'RAG 检索失败，降级');
    }
  }

  // 4. 组装 prompt
  const userPrompt = `# 任务：续写下一章

## 前文章节
${prevSection}

## 主要人物
${characterSection}

## 相关检索片段
${ragSection}

## 用户要求
${input.prompt ?? '无额外要求，自由发挥'}

请直接输出章节正文（不要输出标题，不要解释）。`;

  // 5. 流式生成
  const fullText = await streamChat({
    streamId: ackId,
    webContents: input.webContents,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
    settings,
  });

  // 6. 自动建章（标题 = 第 N 章）
  if (fullText.length > 0) {
    const existing = await listChapters(input.projectId);
    await createChapter({
      projectId: input.projectId,
      title: `第${existing.length + 1}章`,
      content: fullText,
    });
    logger.info({ ackId, projectId: input.projectId, length: fullText.length }, 'AI 续写章节已创建');
  }
}

/**
 * 改写章节
 *
 * 立即返回 { ackId }，后台流式生成，fullText 非空时自动更新章节内容。
 */
export async function rewriteChapter(input: {
  chapterId: string;
  instruction: string;
  webContents: WebContents;
}): Promise<{ ackId: string }> {
  const ackId = randomUUID();

  void doRewriteChapter(ackId, input).catch((err: unknown) => {
    logger.error(
      { ackId, err: err instanceof Error ? err.message : String(err) },
      'rewriteChapter 后台执行异常',
    );
  });

  return { ackId };
}

/** rewriteChapter 后台执行体 */
async function doRewriteChapter(
  ackId: string,
  input: { chapterId: string; instruction: string; webContents: WebContents },
): Promise<void> {
  const chapter = await getChapter(input.chapterId);
  const settings = await resolveAiSettings(chapter.projectId);

  const userPrompt = `# 任务：改写章节片段

## 原文
${chapter.content}

## 改写要求
${input.instruction}

请输出改写后的完整正文（不要解释）。`;

  const fullText = await streamChat({
    streamId: ackId,
    webContents: input.webContents,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
    settings,
  });

  if (fullText.length > 0) {
    await updateChapter({ id: input.chapterId, content: fullText });
    logger.info({ ackId, chapterId: input.chapterId }, 'AI 改写已更新章节');
  }
}

/**
 * 扩写大纲
 *
 * 立即返回 { ackId }，后台流式生成，结果仅通过流式事件返回（不持久化）。
 */
export async function expandOutline(input: {
  projectId: string;
  outline: string;
  webContents: WebContents;
}): Promise<{ ackId: string }> {
  const ackId = randomUUID();

  void doExpandOutline(ackId, input).catch((err: unknown) => {
    logger.error(
      { ackId, err: err instanceof Error ? err.message : String(err) },
      'expandOutline 后台执行异常',
    );
  });

  return { ackId };
}

/** expandOutline 后台执行体 */
async function doExpandOutline(
  ackId: string,
  input: { projectId: string; outline: string; webContents: WebContents },
): Promise<void> {
  const settings = await resolveAiSettings(input.projectId);

  const userPrompt = `# 任务：扩写大纲

## 原始大纲
${input.outline}

请扩写为详细分章大纲（每章 3-5 个要点）。`;

  await streamChat({
    streamId: ackId,
    webContents: input.webContents,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
    settings,
  });
}

/**
 * 流式生成核心（4 个公共函数共用）
 *
 * 流程：openai 流式创建 → textChunks 提取纯文本 → StreamBridge 推送 → 用量记录
 *
 * @returns 完整生成文本（被 abort 时返回已生成的部分文本）
 *
 * 异常处理：openai 调用或流迭代异常时，StreamBridge 已推 error 事件，
 * 本函数记 error 用量后返回空字符串（不 rethrow —— 渲染层已通过 error 事件感知）
 */
async function streamChat(input: StreamChatInput): Promise<string> {
  const { streamId, webContents, messages, settings } = input;
  const start = Date.now();

  try {
    const client = await getOpenAIClient();
    const stream = await client.chat.completions.create({
      model: settings.aiModel,
      messages,
      temperature: settings.aiTemperature,
      max_tokens: settings.aiMaxTokens,
      stream: true,
    });

    const fullText = await getStreamBridge().streamToWebContents({
      sessionId: streamId,
      webContents,
      stream: textChunks(stream),
      chunkChannel: IPC_CHANNELS.CHAT_STREAM_CHUNK,
      endChannel: IPC_CHANNELS.CHAT_STREAM_END,
      errorChannel: IPC_CHANNELS.CHAT_STREAM_ERROR,
    });

    void logAiUsage({
      provider: 'deepseek',
      model: settings.aiModel,
      inputTokens: messages.reduce((sum, m) => sum + m.content.length, 0),
      outputTokens: fullText.length,
      durationMs: Date.now() - start,
      status: 'ok',
    });

    return fullText;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    void logAiUsage({
      provider: 'deepseek',
      model: settings.aiModel,
      durationMs: Date.now() - start,
      status: 'error',
      error: message,
    });
    logger.error({ streamId, err: message }, '流式生成失败');
    return '';
  }
}

/**
 * openai 流 → 纯文本 chunk 提取
 *
 * stream-bridge 的 chunkToString 对对象会 JSON.stringify，
 * 因此必须先把 openai chunk 映射为纯文本 delta，否则渲染层收到的是 JSON 字符串。
 */
async function* textChunks(
  stream: AsyncIterable<{
    choices?: { delta?: { content?: string | null } | null }[];
  }>,
): AsyncGenerator<string> {
  for await (const chunk of stream) {
    const content = chunk.choices?.[0]?.delta?.content;
    if (typeof content === 'string' && content.length > 0) {
      yield content;
    }
  }
}

/**
 * 读取项目 AI 设置（无记录时用 Prisma schema 默认值兜底）
 */
async function resolveAiSettings(projectId: string): Promise<ResolvedAiSettings> {
  const prisma = getPrismaClient();
  const found = await prisma.projectSetting.findUnique({ where: { projectId } });

  if (found === null) {
    const config = getAppConfig();
    return {
      aiModel: config.deepseek.model,
      aiTemperature: 0.7,
      aiMaxTokens: 4096,
      ragEnabled: true,
      ragTopK: 5,
      ragThreshold: 0.7,
    };
  }

  return {
    aiModel: found.aiModel,
    aiTemperature: found.aiTemperature,
    aiMaxTokens: found.aiMaxTokens,
    ragEnabled: found.ragEnabled,
    ragTopK: found.ragTopK,
    ragThreshold: found.ragThreshold,
  };
}
```

**注意**：`ChatStreamChunkPayload` import 仅用于类型参考，若 lint 报未使用则删除该行 import（以实际 lint 结果为准，子代理执行时自行处理）。

### Step 4: 运行测试验证通过

- [ ] **Step 4: 运行测试验证通过**

Run: `pnpm --filter @novel-writer/main exec vitest run src/main/services/agent.service.test.ts`
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
git add src/main/services/agent.service.ts src/main/services/agent.service.test.ts
git commit -m "feat(main): 实现 agent.service 写作编排与流式生成"
```

---

## Task 5: settings.service 补全（testApiKey 真实 API 调用）

**Files:**
- Modify: `src/main/services/settings.service.ts`
- Modify: `src/main/services/settings.service.test.ts`

### 实现说明

**变更点**：`testApiKey` 从占位实现改为真实 API 调用。

| provider | 实现 | 说明 |
|----------|------|------|
| `deepseek` | `getOpenAIClient({ apiKey: key })` 创建临时客户端 → `client.models.list()` 验证连通性 | Key 不存在返回 `{ ok: false }`；调用成功返回 `{ ok: true, latencyMs }`；调用失败返回 `{ ok: false }` |
| `ollama` | `testEmbeddingConnection()`（embedding.service） | Ollama 不校验 API Key，跳过 keychain 检查直接测连通性 |

### Step 1: 更新测试文件

- [ ] **Step 1: 更新 settings.service.test.ts**

**修改 1**：vi.hoisted 块新增两个 mock，并新增两个 vi.mock：

```typescript
const { mockProjectSetting, mockKeychain, mockGetOpenAIClient, mockTestEmbeddingConnection } =
  vi.hoisted(() => ({
    mockProjectSetting: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
    mockKeychain: {
      setSecret: vi.fn(),
      getSecret: vi.fn(),
      deleteSecret: vi.fn(),
    },
    mockGetOpenAIClient: vi.fn(),
    mockTestEmbeddingConnection: vi.fn(),
  }));

vi.mock('../infra/prisma/client', () => ({
  getPrismaClient: () => ({
    ...mockPrismaClient,
    projectSetting: mockProjectSetting,
  }),
}));

vi.mock('../infra/storage/keychain', () => mockKeychain);

vi.mock('../infra/ai/openai-client', () => ({
  getOpenAIClient: mockGetOpenAIClient,
}));

vi.mock('./embedding.service', () => ({
  testEmbeddingConnection: mockTestEmbeddingConnection,
}));
```

**修改 2**：beforeEach 新增 `mockGetOpenAIClient.mockReset()` 与 `mockTestEmbeddingConnection.mockReset()`。

**修改 3**：替换原 `testApiKey` describe 块（删除 5a 占位用例「Key 存在时返回 ok=false」）：

```typescript
  describe('testApiKey', () => {
    it('deepseek Key 不存在时返回 ok=false', async () => {
      mockKeychain.getSecret.mockResolvedValue(null);

      const result = await testApiKey('deepseek');

      expect(mockKeychain.getSecret).toHaveBeenCalledWith('deepseek-api-key');
      expect(result).toEqual({ ok: false });
      expect(mockGetOpenAIClient).not.toHaveBeenCalled();
    });

    it('deepseek 调用成功应返回 ok=true 与 latencyMs', async () => {
      mockKeychain.getSecret.mockResolvedValue('sk-xxx');
      const mockList = vi.fn().mockResolvedValue({ data: [] });
      mockGetOpenAIClient.mockResolvedValue({ models: { list: mockList } });

      const result = await testApiKey('deepseek');

      expect(mockGetOpenAIClient).toHaveBeenCalledWith({ apiKey: 'sk-xxx' });
      expect(mockList).toHaveBeenCalled();
      expect(result.ok).toBe(true);
      expect(result.latencyMs).toEqual(expect.any(Number));
    });

    it('deepseek 调用失败应返回 ok=false（不抛出）', async () => {
      mockKeychain.getSecret.mockResolvedValue('sk-bad');
      mockGetOpenAIClient.mockRejectedValue(new Error('HTTP 401'));

      const result = await testApiKey('deepseek');

      expect(result).toEqual({ ok: false });
    });

    it('ollama 应跳过 keychain 直接测连通性（成功）', async () => {
      mockTestEmbeddingConnection.mockResolvedValue({ ok: true, latencyMs: 42 });

      const result = await testApiKey('ollama');

      expect(mockKeychain.getSecret).not.toHaveBeenCalled();
      expect(result).toEqual({ ok: true, latencyMs: 42 });
    });

    it('ollama 连通性检查失败应返回 ok=false', async () => {
      mockTestEmbeddingConnection.mockResolvedValue({ ok: false });

      const result = await testApiKey('ollama');

      expect(result).toEqual({ ok: false });
    });
  });
```

### Step 2: 运行测试验证失败

- [ ] **Step 2: 运行测试验证失败**

Run: `pnpm --filter @novel-writer/main exec vitest run src/main/services/settings.service.test.ts`
Expected: FAIL — 新用例断言 `mockGetOpenAIClient` 被调用，但当前实现未调用

### Step 3: 修改 settings.service

- [ ] **Step 3: 修改 settings.service.ts**

**修改 1**：文件头注释更新（第 12 行）：

```typescript
// - testApiKey：deepseek 走 models.list 验证，ollama 走嵌入连通性检查
```

**修改 2**：import 区域新增：

```typescript
import { getOpenAIClient } from '../infra/ai/openai-client';
import { testEmbeddingConnection } from './embedding.service';
```

**修改 3**：替换 `testApiKey` 函数整体：

```typescript
/**
 * 测试 API Key 有效性
 *
 * - deepseek：从 keychain 读 Key → 创建临时 OpenAI 客户端 → models.list() 验证
 *   Key 不存在或调用失败均返回 { ok: false }
 * - ollama：本地服务不校验 Key，跳过 keychain，直接测嵌入连通性
 */
export async function testApiKey(
  provider: 'deepseek' | 'ollama',
): Promise<{ ok: boolean; latencyMs?: number }> {
  // ollama：本地服务无 Key 概念，直接测连通性
  if (provider === 'ollama') {
    return testEmbeddingConnection();
  }

  // deepseek：读 Key → 真实调用
  const key = await getSecret(API_KEY_NAMES.deepseek);
  if (key === null) {
    return { ok: false };
  }

  const start = Date.now();
  try {
    // 显式传入 apiKey 创建临时客户端（不污染单例缓存）
    const client = await getOpenAIClient({ apiKey: key });
    await client.models.list();
    logger.info({ provider, latencyMs: Date.now() - start }, 'API Key 验证成功');
    return { ok: true, latencyMs: Date.now() - start };
  } catch (err) {
    logger.warn(
      { provider, err: err instanceof Error ? err.message : String(err) },
      'API Key 验证失败',
    );
    return { ok: false };
  }
}
```

### Step 4: 运行测试验证通过

- [ ] **Step 4: 运行测试验证通过**

Run: `pnpm --filter @novel-writer/main exec vitest run src/main/services/settings.service.test.ts`
Expected: PASS — 全部 11 个测试用例通过（原 8 - 占位 2 + 新 5）

### Step 5: 全量验证 + build + commit

- [ ] **Step 5: 全量验证 + build + commit**

Run:
```
pnpm test
pnpm typecheck
pnpm lint
pnpm build
```
Expected:
- pnpm test: 全部测试通过（Phase 5a 基线 163 + Phase 5b 新增约 21 = 约 184）
- pnpm typecheck: 0 errors
- pnpm lint: 0 errors
- pnpm build: 三入口产物生成

```bash
git add src/main/services/settings.service.ts src/main/services/settings.service.test.ts
git commit -m "feat(main): settings.testApiKey 接入真实 API 调用"
```

---

## Self-Review

### 1. Spec 覆盖检查

设计文档 §4.2 中 Phase 5b 范围内的 3 个 service + 5a 遗留 2 个占位：

| Service | 设计文档职责 | 对应 Task | 覆盖 |
|---------|------------|-----------|------|
| embedding.service | 调云端生成嵌入向量 | Task 1 | ✅ embedTexts + testEmbeddingConnection |
| rag.service | 文档切片、向量入库、相似检索 | Task 2 | ✅ ingestDocument + searchSimilarChunks + listRagDocuments + deleteRagDocument |
| agent.service | 写作 Agent 编排：续写/改写/扩写/章节生成 | Task 4 | ✅ runChatGeneration + generateChapter + rewriteChapter + expandOutline |
| chat.service.stopChatGeneration | 5a 占位 → 真实实现 | Task 3 | ✅ StreamBridge has/abort |
| settings.service.testApiKey | 5a 占位 → 真实实现 | Task 5 | ✅ deepseek models.list + ollama 连通性 |

IPC channel ↔ service 函数对齐（§5.3）：

| Channel | Service 函数 | Task |
|---------|-------------|------|
| rag:ingestDocument | ingestDocument | 2 |
| rag:search | searchSimilarChunks | 2 |
| rag:listDocuments | listRagDocuments | 2 |
| rag:deleteDocument | deleteRagDocument | 2 |
| agent:generateChapter | generateChapter | 4 |
| agent:rewrite | rewriteChapter | 4 |
| agent:expandOutline | expandOutline | 4 |
| chat:stopGeneration | stopChatGeneration | 3 |
| settings:testApiKey | testApiKey | 5 |

场景对齐（§5.1）：场景 3（AI 流式对话）→ Task 4 runChatGeneration；场景 4（RAG 文档入库）→ Task 2 ingestDocument；场景 5（Agent 章节生成）→ Task 4 generateChapter。

### 2. 占位符扫描

- ✅ 无 TBD / TODO / "implement later"
- ✅ 所有测试用例包含完整断言代码（含 mock 数据与调用断言）
- ✅ 所有 service 函数包含完整实现代码
- ✅ 无 "similar to Task N" 引用
- 唯一例外说明：Task 4 末尾注明 `ChatStreamChunkPayload` import 若 lint 未使用则删除 —— 这是明确的条件处理指令，非占位符

### 3. 类型一致性检查

**函数命名一致性**（延续 5a 动词+实体风格）：

| 域 | 函数 |
|----|------|
| embedding | embedTexts / testEmbeddingConnection |
| rag | ingestDocument / searchSimilarChunks / listRagDocuments / deleteRagDocument |
| agent | runChatGeneration / generateChapter / rewriteChapter / expandOutline |
| chat（新增） | saveAssistantMessage / stopChatGeneration |
| ai-usage | logAiUsage |

**入参/返回类型对齐**：

| 函数 | 入参类型 | 返回类型 | 来源 |
|------|---------|---------|------|
| ingestDocument | RagIngestDocumentInput | `{ documentId, chunksCount }` | rag.schema + payloads.ts |
| searchSimilarChunks | RagSearchInput | RagSearchResultItem[] | rag.schema + payloads.ts |
| listRagDocuments | projectId: string | RagDocument[] | rag.schema + payloads.ts |
| generateChapter | `{ projectId, prevChapterId?, prompt?, webContents }` | `{ ackId }` | payloads.ts + webContents 注入 |
| rewriteChapter | `{ chapterId, instruction, webContents }` | `{ ackId }` | payloads.ts |
| expandOutline | `{ projectId, outline, webContents }` | `{ ackId }` | payloads.ts |
| testApiKey | provider | `{ ok, latencyMs? }` | payloads.ts |

**跨 Task 引用一致性**：
- Task 2 调用 Task 1 的 `embedTexts`（签名 `(texts: string[]) => Promise<number[][]>`）✅
- Task 4 调用 Task 1 的 `logAiUsage`、Task 2 的 `searchSimilarChunks`、Task 3 的 `saveAssistantMessage` ✅
- Task 5 调用 Task 1 的 `testEmbeddingConnection` ✅
- Task 3 的 `getStreamBridge` 来源 `../infra/ai/stream-bridge`（Phase 3b 只导出了 `StreamBridge` 类，单例访问器由本阶段 Task 3 Step 1 补充）✅
- agent.service 的 `ResolvedAiSettings` 字段与 Prisma projectSetting 模型字段（aiModel/aiTemperature/aiMaxTokens/ragEnabled/ragTopK/ragThreshold）一一对应 ✅

**错误码对齐**：RAG_EMBEDDING_FAILED / RAG_DOCUMENT_TOO_LARGE / NOT_FOUND / INTERNAL_ERROR 均存在于 `packages/shared/src/constants/errors.ts` ✅（注意：错误码枚举是 `INTERNAL_ERROR`，不是 `INTERNAL`）

### 3.1 实地验证修正记录

计划初稿完成后对照代码库逐项核实接口签名，发现并修复 3 处计划 bug：

| # | 问题 | 修正 |
|---|------|------|
| 1 | `getStreamBridge()` 在 stream-bridge.ts 中不存在（Phase 3b 只导出 `StreamBridge` 类），而 chat.service 与 agent.service 必须共享同一活跃流注册表 | Task 3 新增 Step 1：stream-bridge.ts 追加 `getStreamBridge()` / `resetStreamBridge()` 单例访问器 + 2 个单例测试用例 |
| 2 | 计划中 3 处 `ErrorCode.INTERNAL` 不存在于 errors.ts（实际枚举名为 `INTERNAL_ERROR`） | Task 2 测试 1 处 + rag.service 实现 2 处全部改为 `INTERNAL_ERROR` |
| 3 | agent.service.test.ts mock 章节 `status: 'PUBLISHED'` 不是合法 ChapterStatus（DRAFT/OUTLINE/WRITING/COMPLETED/REVISION） | 改为 `'COMPLETED'` |

已核实无误的关键签名：`embed(texts)` / `getOpenAIClient({ apiKey })` / `streamToWebContents(options)` / `getChapter(id)` / `createChapter({projectId,title,content})` / `updateChapter({id,content})` / `listChapters(projectId)` / `listCharacters(projectId)` / `getChatMessages(sessionId)` / `ChatRole.ASSISTANT === 'assistant'` / RagIngestDocumentInput / RagSearchInput / RagSearchResultItem。

### 4. Phase 5b 验收清单

```bash
# 依赖安装（无新增依赖，跳过）
pnpm install

# 类型检查
pnpm typecheck
# Expected: 0 errors

# Lint
pnpm lint
# Expected: 0 errors / 0 warnings（95 + 7 = ~102 files）

# 单元测试
pnpm test
# Expected:
#   shared: 44 测试通过（不变）
#   main: 119 + 10（ai-usage/embedding）+ 10（rag）+ 2（stream-bridge 单例）+ 2（chat 净增）+ 8（agent）+ 3（settings 净增）≈ 154
#   总计 ≈ 198 测试通过

# 构建
pnpm build
# Expected: 三入口产物生成
```

### 5. 已知偏离与说明

1. **token 计数用字符数估算**：无官方 tokenizer 暴露，inputTokens/outputTokens 用 `content.length` 估算（与 5a sendChatMessage 的 tokens 计算一致），后续可接 tiktoken 精确化。

2. **agent 流异常不 rethrow**：StreamBridge 已推 error 事件到渲染层，service 记 error 用量后返回空字符串。若 rethrow 会导致后台 Promise rejection 难以追踪（`void promise.catch` 已在公共函数层兜底）。

3. **RAG 检索失败降级**：runChatGeneration/generateChapter 中 RAG 失败仅 warn 继续生成（Ollama 未启动不应阻塞纯云端对话），符合「主流程可用」原则。

4. **ollama testApiKey 跳过 keychain**：Ollama 本地服务无 Key 概念（设计文档 §6.6：apiKey 任意值），故不检查 keychain 直接测连通性。`setApiKey('ollama', ...)` 保留以兼容 IPC 契约，但 testApiKey 不读它。

5. **ingestDocument 逐 chunk 插入而非事务**：embedding 是 Unsupported 类型，Prisma `$transaction` 数组形式混用 Client 方法 + raw SQL 较复杂；逐条插入失败时文档记录已存在但 chunksCount=0，属于可接受的中间态（用户可删除重传）。批量性能在 MAX_DOCUMENT_SIZE=200k（约 250 chunk）下可接受。

6. **generateChapter 自动建章标题**：`第N章`（N = 现有章节数 + 1），sortOrder 由 chapter.service createChapter 默认值处理（5a 已实现 `sortOrder` 入参默认）。

7. **webContents 由调用方注入**：service 不 import `BrowserWindow`，WebContents 由 Phase 6 IPC handler 从 event.sender 获取注入，保持 service 可测试性与低耦合。

### 6. 依赖与影响分析

**新增依赖**：无（复用 openai SDK / @prisma/client / @novel-writer/shared / 已有 infra 模块）

**影响范围**：
- 新增 4 个 service 文件 + 4 个测试文件（ai-usage / embedding / rag / agent）
- 修改 2 个 5a service + 2 个测试文件（chat / settings）
- 修改 1 个 infra 文件 + 1 个测试文件（stream-bridge.ts 追加 getStreamBridge 单例访问器，不改既有类行为）
- 复用 Phase 3b 的 openai-client / embedding-client（不改动）
- 不影响 Phase 5a 的 163 个测试（chat/settings 测试修改为替换占位用例，净增 5 个用例）

**后续阶段衔接**：
- Phase 6：IPC handlers 将注入 webContents 调用 agent.service 4 个函数；chat:sendMessage handler 在拿到 ackId 后调用 runChatGeneration
- Phase 7+：渲染层通过 window.api.agent.* / window.api.rag.* 调用

---

## 执行选项

**计划已保存到** `docs/superpowers/plans/2026-07-19-phase5b-ai-services.md`。

**两种执行方式**：

**1. Subagent-Driven（推荐）** — 每个 Task 派发独立子代理，主线程 review 后继续下一 Task，快速迭代

**2. Inline Execution** — 在当前会话内按顺序执行，带 checkpoint review

**推荐 Subagent-Driven**：Task 1/2/3 相互独立可并行（Task 4 agent 依赖 1/2/3 的接口但 mock 已隔离，Task 5 依赖 Task 1 接口），每个 Task 可独立验证。
