# Phase 2: packages/shared 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 `@novel-writer/shared` 工作空间包，提供跨进程共享的错误码、业务实体类型、Zod schema 与 IPC 类型契约，作为后续所有 Phase 的类型单一来源。

**Architecture:** 纯类型 + 纯逻辑包，无运行时副作用（不依赖 Electron / Prisma / Node 原生模块）。类型定义独立于 Prisma 生成类型，避免 Phase 4 数据库层引入前的循环依赖。Zod 4 schema 同时承担运行时校验和类型派生双重职责（`z.infer<>`），实现 Single Source of Truth。

**Tech Stack:** TypeScript 6.0（strict + isolatedDeclarations）、Zod 4、Vitest 4（colocation 单测）、pnpm 10 workspace。

**Spec Reference:**
- 设计文档 §5 数据流与 IPC 契约（api.ts / channels.ts / payloads.ts）
- 设计文档 §6.2 Prisma Schema（业务实体字段来源）
- 设计文档 §7.2-7.4 错误处理（ErrorCode 枚举 / AppError / IpcResponse）

---

## 文件结构总览

执行完成后 `packages/shared/` 目录形态（**仅列出本 Phase 新建/修改文件**）：

```
packages/shared/
├── package.json                          # Modify: 添加 zod / vitest 依赖
├── tsconfig.json                         # Modify: 添加 vitest 类型 + 调整
├── vitest.config.ts                      # Create: Vitest 配置（packages/shared 范围）
├── src/
│   ├── index.ts                          # Modify: 统一导出
│   ├── constants/
│   │   └── errors.ts                     # Create: ErrorCode 枚举 + ERROR_META + AppError
│   ├── types/
│   │   ├── enums.ts                      # Create: ProjectStatus / ChapterStatus 等
│   │   └── models.ts                     # Create: 业务实体类型（Project / Chapter 等）
│   ├── schemas/
│   │   ├── project.schema.ts            # Create: Project Zod schema + Input
│   │   ├── chapter.schema.ts             # Create: Chapter Zod schema + Input
│   │   ├── character.schema.ts          # Create: Character Zod schema + Input
│   │   ├── worldview.schema.ts           # Create: Worldview Zod schema + Input
│   │   ├── chat.schema.ts                # Create: ChatSession / ChatMessage schema
│   │   ├── rag.schema.ts                 # Create: RagDocument schema
│   │   ├── settings.schema.ts            # Create: ProjectSetting / AppSetting schema
│   │   └── index.ts                      # Create: 统一导出
│   ├── ipc/
│   │   ├── channels.ts                   # Create: IPC_CHANNELS 常量
│   │   ├── response.ts                   # Create: IpcResponse / IpcError / IpcContext
│   │   ├── payloads.ts                   # Create: 请求/响应/事件 payload 类型
│   │   └── api.ts                        # Create: IpcApi 接口（window.api 形状）
│   └── __tests__/
│       ├── errors.test.ts                # Create: AppError / ErrorCode 测试
│       ├── project.schema.test.ts        # Create: Project Zod schema 测试
│       ├── chapter.schema.test.ts        # Create: Chapter Zod schema 测试
│       ├── character.schema.test.ts     # Create: Character Zod schema 测试
│       ├── channels.test.ts             # Create: IPC_CHANNELS 完整性测试
│       └── api.test.ts                   # Create: IpcApi 类型结构测试
```

**职责划分：**
- `constants/errors.ts`：错误码单一来源，AppError 类供主进程抛出
- `types/enums.ts` + `types/models.ts`：业务实体 TS 类型（独立于 Prisma，Phase 4 后 Prisma 类型可 alias 到这里）
- `schemas/*.schema.ts`：Zod schema（运行时校验 + `z.infer` 派生类型，避免类型与校验分离）
- `ipc/channels.ts`：IPC channel 字符串常量（防止拼写错误）
- `ipc/response.ts`：IPC 统一返回结构 `{ data } | { error }` + IpcContext（含 traceId）
- `ipc/payloads.ts`：每个 channel 的请求/响应/事件 payload 类型
- `ipc/api.ts`：`window.api` 形状，preload 实现此接口，渲染层消费此接口

**依赖方向（严格遵守）：**
- `ipc/*` 可依赖 `types/*` + `schemas/*` + `constants/*`
- `schemas/*` 可依赖 `types/enums.ts`（仅枚举，不依赖 models，因为 schema 自身派生 models）
- `types/models.ts` 依赖 `types/enums.ts`
- `constants/errors.ts` 无内部依赖
- `index.ts` 统一 re-export

---

## Task 1: 安装依赖 + 配置 Vitest

**Files:**
- Modify: `packages/shared/package.json`
- Modify: `packages/shared/tsconfig.json`
- Create: `packages/shared/vitest.config.ts`
- Modify: `package.json`（根，更新 test script）

- [ ] **Step 1: 在 packages/shared/package.json 添加 zod 和 vitest 依赖**

修改 `f:\TraeProjects\1\packages\shared\package.json`，完整新内容：

```json
{
  "name": "@novel-writer/shared",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "zod": "^4.0.0"
  },
  "devDependencies": {
    "@novel-writer/tsconfig": "workspace:*",
    "vitest": "^4.0.0"
  }
}
```

- [ ] **Step 2: 修改 packages/shared/tsconfig.json，添加 vitest 类型支持 + 调整 isolatedDeclarations**

修改 `f:\TraeProjects\1\packages\shared\tsconfig.json`，完整新内容：

```json
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "extends": "@novel-writer/tsconfig/base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src",
    "noEmit": false,
    "emitDeclarationOnly": true,
    "types": ["vitest/globals"],
    "isolatedDeclarations": false
  },
  "include": ["src/**/*.ts"]
}
```

**关于 `isolatedDeclarations: false` 的说明：**
base.json 启用 `isolatedDeclarations: true` 是为了让主进程 / 渲染层代码（有显式类型注解）能生成 .d.ts。但 `@novel-writer/shared` 大量使用 Zod schema 推断类型（`z.infer<typeof ProjectSchema>`），Zod 的 `z.object({...})` 返回类型是 `ZodObject<ZodRawShape, ...>` 复杂泛型，无法在不调用类型推断的情况下生成 .d.ts。

`@novel-writer/shared` 的 `package.json` 配置 `"exports": { ".": "./src/index.ts" }`，消费方（主进程 / preload / 渲染层）直接引用源码而非 `dist/*.d.ts`，因此本包不需要生成 .d.ts。`emitDeclarationOnly: true` 仅为满足 Project References 的 TS6310 约束（被引用项目不能完全 disable emit），实际生成的 .d.ts 不被消费。

此处 override `isolatedDeclarations: false` 是合理的局部妥协，不影响主进程 / 渲染层的规范。

- [ ] **Step 3: 创建 packages/shared/vitest.config.ts**

新建 `f:\TraeProjects\1\packages\shared\vitest.config.ts`，内容：

```ts
// packages/shared/vitest.config.ts
// Vitest 配置：@novel-writer/shared 工作空间包单测
// 参考 Vitest 4 官方文档 https://vitest.dev/config/
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 启用 globals：允许 describe/it/expect 无需显式 import
    globals: true,
    // 测试文件位置：与源码同目录（colocation 模式，设计文档 §8.2）
    include: ['src/**/*.test.ts'],
    // 覆盖率收集（Phase 9 才接入阈值，此处先开收集）
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
    },
  },
});
```

- [ ] **Step 4: 修改根 package.json 的 test script**

把根 `package.json` 的 `"test"` 脚本从占位改为递归跑所有 workspace 包的测试：

```json
"test": "pnpm -r --filter '@novel-writer/*' run test"
```

- [ ] **Step 5: 安装依赖**

Run: `pnpm install`
Expected: 无错误无警告，pnpm-lock.yaml 更新。

- [ ] **Step 6: 验证 Vitest 可启动（写一个最小测试占位）**

临时在 `packages/shared/src/__tests__/setup.test.ts` 写：

```ts
import { describe, expect, it } from 'vitest';

describe('setup', () => {
  it('vitest works', () => {
    expect(1 + 1).toBe(2);
  });
});
```

Run: `pnpm --filter @novel-writer/shared test`
Expected: 1 test passed。

- [ ] **Step 7: 删除占位测试文件**

删除 `packages/shared/src/__tests__/setup.test.ts`（后续 task 会创建真实测试）。

- [ ] **Step 8: 验证 typecheck + lint 全绿**

Run: `pnpm typecheck && pnpm lint`
Expected: 0 errors 0 warnings。

- [ ] **Step 9: Commit**

```bash
git add packages/shared/package.json packages/shared/tsconfig.json packages/shared/vitest.config.ts package.json pnpm-lock.yaml
git commit -m "build(shared): 引入 zod 4 与 vitest 4 依赖"
```

注意：Husky pre-commit 会自动触发 lint-staged + codegraph sync，无需手动。

---

## Task 2: 错误码枚举 + AppError 类（TDD）

**Files:**
- Create: `packages/shared/src/constants/errors.ts`
- Create: `packages/shared/src/__tests__/errors.test.ts`

参考设计文档 §7.2（错误码枚举）、§7.3（AppError 类）、§7.10（用户友好提示）。

- [ ] **Step 1: 写失败测试 — ErrorCode 完整性**

创建 `f:\TraeProjects\1\packages\shared\src\__tests__\errors.test.ts`：

```ts
// packages/shared/src/__tests__/errors.test.ts
// AppError 与 ErrorCode 单元测试
import { describe, expect, it } from 'vitest';
import { AppError, ERROR_META, ErrorCode } from '../constants/errors';

describe('ErrorCode', () => {
  it('包含所有设计文档 §7.2 规定的错误码', () => {
    // 通用
    expect(ErrorCode.UNKNOWN).toBe('UNKNOWN');
    expect(ErrorCode.INTERNAL_ERROR).toBe('INTERNAL_ERROR');
    expect(ErrorCode.INVALID_INPUT).toBe('INVALID_INPUT');
    expect(ErrorCode.NOT_FOUND).toBe('NOT_FOUND');
    expect(ErrorCode.UNAUTHORIZED).toBe('UNAUTHORIZED');
    expect(ErrorCode.RATE_LIMITED).toBe('RATE_LIMITED');
    // IPC
    expect(ErrorCode.IPC_SENDER_INVALID).toBe('IPC_SENDER_INVALID');
    expect(ErrorCode.IPC_CHANNEL_NOT_FOUND).toBe('IPC_CHANNEL_NOT_FOUND');
    // 项目
    expect(ErrorCode.PROJECT_NOT_FOUND).toBe('PROJECT_NOT_FOUND');
    expect(ErrorCode.PROJECT_NAME_EXISTS).toBe('PROJECT_NAME_EXISTS');
    // AI
    expect(ErrorCode.AI_API_KEY_MISSING).toBe('AI_API_KEY_MISSING');
    expect(ErrorCode.AI_RATE_LIMITED).toBe('AI_RATE_LIMITED');
    // RAG
    expect(ErrorCode.RAG_EMBEDDING_FAILED).toBe('RAG_EMBEDDING_FAILED');
    // PG
    expect(ErrorCode.PG_CRASHED).toBe('PG_CRASHED');
    // Ollama
    expect(ErrorCode.OLLAMA_NOT_INSTALLED).toBe('OLLAMA_NOT_INSTALLED');
    expect(ErrorCode.OLLAMA_MODEL_NOT_FOUND).toBe('OLLAMA_MODEL_NOT_FOUND');
  });

  it('每个错误码都有对应的 ERROR_META 条目', () => {
    for (const code of Object.values(ErrorCode)) {
      expect(ERROR_META[code]).toBeDefined();
      expect(ERROR_META[code].userMessage).toBeTypeOf('string');
      expect(ERROR_META[code].userMessage.length).toBeGreaterThan(0);
      expect(typeof ERROR_META[code].retryable).toBe('boolean');
      expect(ERROR_META[code].severity).toMatch(/info|warn|error|fatal/);
    }
  });
});

describe('AppError', () => {
  it('默认 message 来自 ERROR_META', () => {
    const err = new AppError(ErrorCode.PROJECT_NOT_FOUND);
    expect(err.message).toBe(ERROR_META[ErrorCode.PROJECT_NOT_FOUND].userMessage);
    expect(err.code).toBe(ErrorCode.PROJECT_NOT_FOUND);
  });

  it('自定义 message 优先于 ERROR_META', () => {
    const err = new AppError(ErrorCode.INVALID_INPUT, '字段 name 必填');
    expect(err.message).toBe('字段 name 必填');
  });

  it('toIpcError 返回可序列化结构', () => {
    const err = new AppError(ErrorCode.INVALID_INPUT, '校验失败', undefined, { field: 'name' });
    const ipcErr = err.toIpcError();
    expect(ipcErr).toEqual({
      code: 'INVALID_INPUT',
      message: '校验失败',
      details: { field: 'name' },
    });
  });

  it('retryable 与 severity 来自 ERROR_META', () => {
    const retryable = new AppError(ErrorCode.AI_RATE_LIMITED);
    expect(retryable.retryable).toBe(true);

    const fatal = new AppError(ErrorCode.PG_CRASHED);
    expect(fatal.severity).toBe('error');
  });

  it('支持 cause 链', () => {
    const root = new Error('PostgreSQL 进程退出码 1');
    const err = new AppError(ErrorCode.PG_CRASHED, undefined, root);
    expect(err.cause).toBe(root);
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm --filter @novel-writer/shared test`
Expected: 编译错误 `Cannot find module '../constants/errors'`。

- [ ] **Step 3: 实现 errors.ts**

创建 `f:\TraeProjects\1\packages\shared\src\constants\errors.ts`：

```ts
// packages/shared/src/constants/errors.ts
// 统一错误码 + AppError 类：跨进程共享的错误处理基础设施
// 设计文档 §7.2（错误码枚举）、§7.3（AppError）、§7.10（用户友好提示）

/**
 * 错误码枚举
 *
 * 命名规范：{域}_{动作/状态}，全大写下划线分隔
 * 域：UNKNOWN/INTERNAL/IPC/PROJECT/CHAPTER/CHARACTER/AI/RAG/DB/PG/OLLAMA/FS
 *
 * 注意：使用 as const 派生字面量联合类型，避免 enum 的运行时对象开销
 */
export const ErrorCode = {
  // ── 通用 ──────────────────────────────────────────
  UNKNOWN: 'UNKNOWN',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  INVALID_INPUT: 'INVALID_INPUT',
  NOT_FOUND: 'NOT_FOUND',
  UNAUTHORIZED: 'UNAUTHORIZED',
  RATE_LIMITED: 'RATE_LIMITED',

  // ── IPC 边界 ──────────────────────────────────────
  IPC_SENDER_INVALID: 'IPC_SENDER_INVALID',
  IPC_CHANNEL_NOT_FOUND: 'IPC_CHANNEL_NOT_FOUND',

  // ── 项目 ──────────────────────────────────────────
  PROJECT_NOT_FOUND: 'PROJECT_NOT_FOUND',
  PROJECT_NAME_EXISTS: 'PROJECT_NAME_EXISTS',

  // ── 章节 ──────────────────────────────────────────
  CHAPTER_NOT_FOUND: 'CHAPTER_NOT_FOUND',
  CHAPTER_CONTENT_TOO_LARGE: 'CHAPTER_CONTENT_TOO_LARGE',

  // ── 人物 ──────────────────────────────────────────
  CHARACTER_NOT_FOUND: 'CHARACTER_NOT_FOUND',
  CHARACTER_RELATION_CYCLE: 'CHARACTER_RELATION_CYCLE',

  // ── AI 调用 ───────────────────────────────────────
  AI_API_KEY_MISSING: 'AI_API_KEY_MISSING',
  AI_API_KEY_INVALID: 'AI_API_KEY_INVALID',
  AI_RATE_LIMITED: 'AI_RATE_LIMITED',
  AI_TIMEOUT: 'AI_TIMEOUT',
  AI_MODEL_ERROR: 'AI_MODEL_ERROR',
  AI_STREAM_INTERRUPTED: 'AI_STREAM_INTERRUPTED',
  AI_CONTEXT_TOO_LARGE: 'AI_CONTEXT_TOO_LARGE',

  // ── RAG ───────────────────────────────────────────
  RAG_EMBEDDING_FAILED: 'RAG_EMBEDDING_FAILED',
  RAG_NO_RESULTS: 'RAG_NO_RESULTS',
  RAG_DOCUMENT_TOO_LARGE: 'RAG_DOCUMENT_TOO_LARGE',

  // ── 数据库 ────────────────────────────────────────
  DB_CONNECTION_FAILED: 'DB_CONNECTION_FAILED',
  DB_QUERY_ERROR: 'DB_QUERY_ERROR',
  DB_CONSTRAINT_VIOLATION: 'DB_CONSTRAINT_VIOLATION',

  // ── PG 子进程 ─────────────────────────────────────
  PG_INIT_FAILED: 'PG_INIT_FAILED',
  PG_START_FAILED: 'PG_START_FAILED',
  PG_CRASHED: 'PG_CRASHED',
  PG_BACKUP_FAILED: 'PG_BACKUP_FAILED',

  // ── Ollama 本地嵌入服务 ──────────────────────────
  OLLAMA_NOT_INSTALLED: 'OLLAMA_NOT_INSTALLED',
  OLLAMA_NOT_RUNNING: 'OLLAMA_NOT_RUNNING',
  OLLAMA_MODEL_PULL_FAILED: 'OLLAMA_MODEL_PULL_FAILED',
  OLLAMA_MODEL_NOT_FOUND: 'OLLAMA_MODEL_NOT_FOUND',
  OLLAMA_TIMEOUT: 'OLLAMA_TIMEOUT',
  OLLAMA_DISK_FULL: 'OLLAMA_DISK_FULL',

  // ── 文件系统 ──────────────────────────────────────
  FS_READ_FAILED: 'FS_READ_FAILED',
  FS_WRITE_FAILED: 'FS_WRITE_FAILED',
  FS_DISK_FULL: 'FS_DISK_FULL',
} as const;

/** 错误码字面量联合类型（从 ErrorCode 派生） */
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/** 错误严重级别 */
export type ErrorSeverity = 'info' | 'warn' | 'error' | 'fatal';

/**
 * 错误元数据
 *
 * - userMessage：面向终端用户的中文友好提示
 * - retryable：是否可自动重试（AI 限流、超时、PG 崩溃等）
 * - severity：日志级别 + Sentry 事件级别
 */
export interface ErrorMeta {
  readonly userMessage: string;
  readonly retryable: boolean;
  readonly severity: ErrorSeverity;
}

/**
 * ERROR_META：错误码 → 元数据映射表
 *
 * 完整覆盖所有 ErrorCode，缺失即视为 bug（单测会校验）
 * 用户友好提示文案参考设计文档 §7.10
 */
export const ERROR_META: Readonly<Record<ErrorCode, ErrorMeta>> = {
  // 通用
  UNKNOWN: { userMessage: '未知错误', retryable: false, severity: 'error' },
  INTERNAL_ERROR: { userMessage: '内部错误', retryable: false, severity: 'error' },
  INVALID_INPUT: { userMessage: '输入参数有误', retryable: false, severity: 'warn' },
  NOT_FOUND: { userMessage: '资源不存在', retryable: false, severity: 'warn' },
  UNAUTHORIZED: { userMessage: '未授权', retryable: false, severity: 'warn' },
  RATE_LIMITED: { userMessage: '操作过于频繁', retryable: true, severity: 'warn' },

  // IPC
  IPC_SENDER_INVALID: { userMessage: 'IPC 调用来源无效', retryable: false, severity: 'error' },
  IPC_CHANNEL_NOT_FOUND: { userMessage: 'IPC 通道不存在', retryable: false, severity: 'error' },

  // 项目
  PROJECT_NOT_FOUND: { userMessage: '项目不存在', retryable: false, severity: 'warn' },
  PROJECT_NAME_EXISTS: { userMessage: '项目名已存在', retryable: false, severity: 'warn' },

  // 章节
  CHAPTER_NOT_FOUND: { userMessage: '章节不存在', retryable: false, severity: 'warn' },
  CHAPTER_CONTENT_TOO_LARGE: { userMessage: '章节内容过长', retryable: false, severity: 'warn' },

  // 人物
  CHARACTER_NOT_FOUND: { userMessage: '人物不存在', retryable: false, severity: 'warn' },
  CHARACTER_RELATION_CYCLE: { userMessage: '人物关系存在循环', retryable: false, severity: 'warn' },

  // AI
  AI_API_KEY_MISSING: { userMessage: '请先配置 API Key', retryable: false, severity: 'warn' },
  AI_API_KEY_INVALID: { userMessage: 'API Key 无效', retryable: false, severity: 'warn' },
  AI_RATE_LIMITED: { userMessage: 'AI 调用频繁，正在重试', retryable: true, severity: 'warn' },
  AI_TIMEOUT: { userMessage: 'AI 调用超时', retryable: true, severity: 'warn' },
  AI_MODEL_ERROR: { userMessage: 'AI 模型错误', retryable: false, severity: 'error' },
  AI_STREAM_INTERRUPTED: { userMessage: 'AI 流式响应中断', retryable: true, severity: 'warn' },
  AI_CONTEXT_TOO_LARGE: { userMessage: '上下文过长，请精简对话', retryable: false, severity: 'warn' },

  // RAG
  RAG_EMBEDDING_FAILED: { userMessage: '嵌入向量生成失败', retryable: true, severity: 'error' },
  RAG_NO_RESULTS: { userMessage: '未检索到相关文档', retryable: false, severity: 'info' },
  RAG_DOCUMENT_TOO_LARGE: { userMessage: '文档过大，无法入库', retryable: false, severity: 'warn' },

  // 数据库
  DB_CONNECTION_FAILED: { userMessage: '数据库连接失败', retryable: true, severity: 'error' },
  DB_QUERY_ERROR: { userMessage: '数据库查询错误', retryable: false, severity: 'error' },
  DB_CONSTRAINT_VIOLATION: { userMessage: '数据约束冲突', retryable: false, severity: 'error' },

  // PG 子进程
  PG_INIT_FAILED: { userMessage: '数据库初始化失败', retryable: false, severity: 'fatal' },
  PG_START_FAILED: { userMessage: '数据库启动失败', retryable: true, severity: 'error' },
  PG_CRASHED: { userMessage: '数据库异常，正在重启', retryable: true, severity: 'error' },
  PG_BACKUP_FAILED: { userMessage: '数据库备份失败', retryable: false, severity: 'warn' },

  // Ollama
  OLLAMA_NOT_INSTALLED: { userMessage: '未检测到 Ollama，请先安装', retryable: false, severity: 'warn' },
  OLLAMA_NOT_RUNNING: { userMessage: 'Ollama 服务未运行', retryable: true, severity: 'warn' },
  OLLAMA_MODEL_PULL_FAILED: { userMessage: '嵌入模型拉取失败', retryable: false, severity: 'warn' },
  OLLAMA_MODEL_NOT_FOUND: { userMessage: '嵌入模型未拉取', retryable: false, severity: 'warn' },
  OLLAMA_TIMEOUT: { userMessage: 'Ollama 调用超时', retryable: true, severity: 'warn' },
  OLLAMA_DISK_FULL: { userMessage: '磁盘空间不足', retryable: false, severity: 'warn' },

  // 文件系统
  FS_READ_FAILED: { userMessage: '文件读取失败', retryable: false, severity: 'error' },
  FS_WRITE_FAILED: { userMessage: '文件写入失败', retryable: false, severity: 'error' },
  FS_DISK_FULL: { userMessage: '磁盘空间不足', retryable: false, severity: 'warn' },
};

/**
 * IPC 错误序列化结构
 *
 * 主进程 wrap() 捕获 AppError 后调用 toIpcError()，经 IPC 序列化传输到渲染层
 */
export interface IpcError {
  readonly code: ErrorCode;
  readonly message: string;
  readonly details?: unknown;
}

/**
 * AppError：应用统一错误类
 *
 * 设计文档 §7.3
 * - 主进程 service / infra 层抛出 AppError
 * - wrap() 捕获并调用 toIpcError() 返回给渲染层
 * - 渲染层通过 handleIpcError() 根据 code 显示 toast 与操作建议
 *
 * 注意：复用 ES2022 Error 原生 cause 属性（通过 super 第二参数传入）
 * 不在子类重新声明 cause，避免与 lib.es2022.error 的 Error.cause 冲突
 */
export class AppError extends Error {
  /** 错误码（单一身份标识） */
  readonly code: ErrorCode;

  /** 附加上下文（如校验失败的字段列表），会序列化到 IPC details */
  readonly details?: unknown;

  constructor(code: ErrorCode, message?: string, cause?: unknown, details?: unknown) {
    // ES2022 Error 原生支持 cause 选项
    // 优先使用显式 message，否则 fallback 到 ERROR_META 的 userMessage
    const messageOrDefault = message ?? ERROR_META[code].userMessage;
    if (cause !== undefined) {
      super(messageOrDefault, { cause });
    } else {
      super(messageOrDefault);
    }
    this.name = 'AppError';
    this.code = code;
    if (details !== undefined) {
      this.details = details;
    }
  }

  /** 元数据访问器（retryable / severity） */
  get meta(): ErrorMeta {
    return ERROR_META[this.code];
  }

  /** 是否可自动重试（AI 限流、超时、PG 崩溃等） */
  get retryable(): boolean {
    return this.meta.retryable;
  }

  /** 日志/Sentry 级别 */
  get severity(): ErrorSeverity {
    return this.meta.severity;
  }

  /**
   * 序列化为 IPC 传输结构
   *
   * 注意 cause 不序列化（可能含不可序列化的原生错误对象）
   */
  toIpcError(): IpcError {
    const result: IpcError = {
      code: this.code,
      message: this.message,
    };
    if (this.details !== undefined) {
      result.details = this.details;
    }
    return result;
  }
}
```

- [ ] **Step 4: 运行测试，确认全部通过**

Run: `pnpm --filter @novel-writer/shared test`
Expected: `errors.test.ts` 全部测试通过（≥5 个 test）。

- [ ] **Step 5: 验证 typecheck + lint**

Run: `pnpm typecheck && pnpm lint`
Expected: 0 errors 0 warnings。

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/constants/errors.ts packages/shared/src/__tests__/errors.test.ts
git commit -m "feat(shared): 错误码枚举与 AppError 类（§7.2-7.4）"
```

---

## Task 3: 业务实体枚举与类型定义

**Files:**
- Create: `packages/shared/src/types/enums.ts`
- Create: `packages/shared/src/types/models.ts`

参考设计文档 §6.2（Prisma Schema 完整定义）。本任务**不写 Zod schema**（Task 4 才做），只定义纯 TS 类型与枚举字面量。这些类型在 Phase 4 引入 Prisma 后会被 Prisma 生成类型 alias 引用，避免类型漂移。

- [ ] **Step 1: 创建 enums.ts**

创建 `f:\TraeProjects\1\packages\shared\src\types\enums.ts`：

```ts
// packages/shared/src/types/enums.ts
// 业务实体状态枚举
// 来源：设计文档 §6.2 Prisma Schema 的 enum 定义
// 注意：使用 as const + 字面量联合类型，避免 TS enum 的运行时对象开销
// Phase 4 引入 Prisma 后，Prisma 生成类型会 alias 到这里

/** 项目状态 */
export const ProjectStatus = {
  ACTIVE: 'ACTIVE',
  ARCHIVED: 'ARCHIVED',
  DRAFT: 'DRAFT',
} as const;
export type ProjectStatus = (typeof ProjectStatus)[keyof typeof ProjectStatus];

/** 章节状态 */
export const ChapterStatus = {
  DRAFT: 'DRAFT',
  OUTLINE: 'OUTLINE',
  WRITING: 'WRITING',
  COMPLETED: 'COMPLETED',
  REVISION: 'REVISION',
} as const;
export type ChapterStatus = (typeof ChapterStatus)[keyof typeof ChapterStatus];

/** 人物角色定位 */
export const CharacterRole = {
  PROTAGONIST: 'PROTAGONIST',
  ANTAGONIST: 'ANTAGONIST',
  SUPPORTING: 'SUPPORTING',
  MINOR: 'MINOR',
} as const;
export type CharacterRole = (typeof CharacterRole)[keyof typeof CharacterRole];

/** 对话消息角色（对齐 OpenAI ChatCompletionRole） */
export const ChatRole = {
  USER: 'user',
  ASSISTANT: 'assistant',
  SYSTEM: 'system',
} as const;
export type ChatRole = (typeof ChatRole)[keyof typeof ChatRole];
```

- [ ] **Step 2: 创建 models.ts**

创建 `f:\TraeProjects\1\packages\shared\src\types\models.ts`：

```ts
// packages/shared/src/types/models.ts
// 业务实体类型定义
// 来源：设计文档 §6.2 Prisma Schema 字段
// 注意：Phase 4 引入 Prisma 后，可通过 type alias 让 Prisma 生成类型对齐此处定义
// 此处独立定义是为了让 packages/shared 不依赖 Prisma（避免循环依赖）

import type {
  ChapterStatus,
  CharacterRole,
  ChatRole,
  ProjectStatus,
} from './enums';

/** ISO 8601 字符串时间戳（Prisma DateTime 在 IPC 边界序列化为 string） */
export type ISODateString = string;

/** 项目 */
export interface Project {
  readonly id: string;
  readonly name: string;
  readonly description?: string | null;
  readonly genre?: string | null;
  readonly cover?: string | null;
  readonly status: ProjectStatus;
  readonly metadata: Record<string, unknown>;
  readonly createdAt: ISODateString;
  readonly updatedAt: ISODateString;
  readonly archivedAt?: ISODateString | null;
}

/** 卷宗 */
export interface Volume {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly summary?: string | null;
  readonly sortOrder: number;
  readonly createdAt: ISODateString;
  readonly updatedAt: ISODateString;
}

/** 章节 */
export interface Chapter {
  readonly id: string;
  readonly projectId: string;
  readonly volumeId?: string | null;
  readonly title: string;
  readonly content: string;
  readonly wordCount: number;
  readonly status: ChapterStatus;
  readonly sortOrder: number;
  readonly metadata: Record<string, unknown>;
  readonly createdAt: ISODateString;
  readonly updatedAt: ISODateString;
}

/** 人物卡 */
export interface Character {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly avatar?: string | null;
  readonly role: CharacterRole;
  readonly description?: string | null;
  readonly profile: Record<string, unknown>;
  readonly createdAt: ISODateString;
  readonly updatedAt: ISODateString;
}

/** 人物关系（AGE 图边，不在 Prisma 表中，通过 Cypher 透传查询） */
export interface CharacterRelation {
  readonly fromCharacterId: string;
  readonly toCharacterId: string;
  readonly type: string;
  readonly description?: string;
  readonly chapterId?: string;
}

/** 世界观条目（自关联树形） */
export interface Worldview {
  readonly id: string;
  readonly projectId: string;
  readonly parentId?: string | null;
  readonly title: string;
  readonly content?: string | null;
  readonly type?: string | null;
  readonly icon?: string | null;
  readonly sortOrder: number;
  readonly createdAt: ISODateString;
  readonly updatedAt: ISODateString;
}

/** AI 对话会话 */
export interface ChatSession {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly context: Record<string, unknown>;
  readonly model?: string | null;
  readonly createdAt: ISODateString;
  readonly updatedAt: ISODateString;
}

/** AI 对话消息 */
export interface ChatMessage {
  readonly id: string;
  readonly sessionId: string;
  readonly role: ChatRole;
  readonly content: string;
  readonly tokens: number;
  readonly metadata: Record<string, unknown>;
  readonly createdAt: ISODateString;
}

/** RAG 文档 */
export interface RagDocument {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly source?: string | null;
  readonly mimeType?: string | null;
  readonly chunksCount: number;
  readonly metadata: Record<string, unknown>;
  readonly createdAt: ISODateString;
}

/** RAG 文档切片（不含 embedding，向量不跨 IPC 传输） */
export interface RagDocumentChunk {
  readonly id: string;
  readonly documentId: string;
  readonly content: string;
  readonly chunkIndex: number;
  readonly metadata: Record<string, unknown>;
  readonly createdAt: ISODateString;
}

/** 项目设置 */
export interface ProjectSetting {
  readonly projectId: string;
  readonly aiModel: string;
  readonly aiTemperature: number;
  readonly aiMaxTokens: number;
  readonly ragEnabled: boolean;
  readonly ragTopK: number;
  readonly ragThreshold: number;
  readonly customPrompts: Record<string, unknown>;
  readonly updatedAt: ISODateString;
}

/** 全局应用设置（KV 结构） */
export interface AppSetting {
  readonly key: string;
  readonly value: string;
  readonly updatedAt: ISODateString;
}

/** AI 调用日志 */
export interface AiUsageLog {
  readonly id: string;
  readonly provider: string;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly durationMs: number;
  readonly status: string;
  readonly error?: string | null;
  readonly createdAt: ISODateString;
}
```

- [ ] **Step 3: 验证 typecheck + lint**

Run: `pnpm typecheck && pnpm lint`
Expected: 0 errors 0 warnings。

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/types/enums.ts packages/shared/src/types/models.ts
git commit -m "feat(shared): 业务实体枚举与类型定义（§6.2）"
```

---

## Task 4: Zod Schema（Project + Chapter + Character + Worldview + Chat + Rag + Settings）

**Files:**
- Create: `packages/shared/src/schemas/project.schema.ts`
- Create: `packages/shared/src/schemas/chapter.schema.ts`
- Create: `packages/shared/src/schemas/character.schema.ts`
- Create: `packages/shared/src/schemas/worldview.schema.ts`
- Create: `packages/shared/src/schemas/chat.schema.ts`
- Create: `packages/shared/src/schemas/rag.schema.ts`
- Create: `packages/shared/src/schemas/settings.schema.ts`
- Create: `packages/shared/src/schemas/index.ts`
- Create: `packages/shared/src/__tests__/project.schema.test.ts`
- Create: `packages/shared/src/__tests__/chapter.schema.test.ts`
- Create: `packages/shared/src/__tests__/character.schema.test.ts`

每个 schema 文件职责：定义实体的 Zod schema + `z.infer` 派生类型 + CRUD Input schema（供 IPC handler 校验入参）。

### Task 4.1: Project Schema

- [ ] **Step 1: 写失败测试 — project.schema.test.ts**

创建 `f:\TraeProjects\1\packages\shared\src\__tests__\project.schema.test.ts`：

```ts
// packages/shared/src/__tests__/project.schema.test.ts
// Project Zod schema 单元测试
import { describe, expect, it } from 'vitest';
import {
  ProjectCreateInputSchema,
  ProjectUpdateInputSchema,
  ProjectSchema,
} from '../schemas/project.schema';

describe('ProjectSchema', () => {
  const validProject = {
    id: 'clxxxxxxxxxxxxxxxxxxxxxxxxx',
    name: '我的第一本小说',
    description: '一个关于成长的故事',
    genre: '玄幻',
    cover: null,
    status: 'DRAFT',
    metadata: {},
    createdAt: '2026-07-18T10:00:00.000Z',
    updatedAt: '2026-07-18T10:00:00.000Z',
    archivedAt: null,
  };

  it('接受合法项目对象', () => {
    expect(ProjectSchema.parse(validProject)).toEqual(validProject);
  });

  it('拒绝空 name', () => {
    expect(() => ProjectSchema.parse({ ...validProject, name: '' })).toThrow();
  });

  it('拒绝 name 超过 200 字符', () => {
    expect(() =>
      ProjectSchema.parse({ ...validProject, name: 'a'.repeat(201) }),
    ).toThrow();
  });

  it('拒绝非法 status', () => {
    expect(() =>
      ProjectSchema.parse({ ...validProject, status: 'INVALID' }),
    ).toThrow();
  });
});

describe('ProjectCreateInputSchema', () => {
  it('接受最小创建入参（仅 name）', () => {
    const input = { name: '新项目' };
    const parsed = ProjectCreateInputSchema.parse(input);
    expect(parsed.name).toBe('新项目');
  });

  it('trim name 后空字符串应拒绝', () => {
    expect(() => ProjectCreateInputSchema.parse({ name: '   ' })).toThrow();
  });

  it('description 可选', () => {
    const parsed = ProjectCreateInputSchema.parse({ name: 'X', description: 'desc' });
    expect(parsed.description).toBe('desc');
  });

  it('genre 长度上限 50', () => {
    expect(() =>
      ProjectCreateInputSchema.parse({ name: 'X', genre: 'a'.repeat(51) }),
    ).toThrow();
  });
});

describe('ProjectUpdateInputSchema', () => {
  it('至少需要 1 个字段', () => {
    expect(() => ProjectUpdateInputSchema.parse({})).toThrow();
  });

  it('id 必填', () => {
    expect(() => ProjectUpdateInputSchema.parse({ name: '新名' })).toThrow();
  });

  it('接受部分更新', () => {
    const parsed = ProjectUpdateInputSchema.parse({ id: 'clxxx', name: '新名' });
    expect(parsed.name).toBe('新名');
    expect(parsed.description).toBeUndefined();
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm --filter @novel-writer/shared test`
Expected: `Cannot find module '../schemas/project.schema'`。

- [ ] **Step 3: 实现 project.schema.ts**

创建 `f:\TraeProjects\1\packages\shared\src\schemas\project.schema.ts`：

```ts
// packages/shared/src/schemas/project.schema.ts
// Project 实体 Zod schema + CRUD Input schema
// 实体字段来源：设计文档 §6.2 Prisma Project 模型
// Zod 4 最佳实践：schema 同时承担运行时校验与类型派生（z.infer）

import { z } from 'zod';
import { ProjectStatus } from '../types/enums';

/**
 * Project 实体 schema（对应数据库已存在记录）
 *
 * 字段对齐设计文档 §6.2 Prisma Project 模型
 * - name: 1-200 字符
 * - status: 枚举
 * - metadata: JSON 对象（默认 {}）
 * - 时间戳为 ISO 8601 字符串（Prisma DateTime 序列化后）
 */
export const ProjectSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(200),
  description: z.string().nullable().optional(),
  genre: z.string().max(50).nullable().optional(),
  cover: z.string().nullable().optional(),
  status: z.enum([
    ProjectStatus.ACTIVE,
    ProjectStatus.ARCHIVED,
    ProjectStatus.DRAFT,
  ]),
  metadata: z.record(z.string(), z.unknown()).default({}),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  archivedAt: z.string().nullable().optional(),
});

/** Project 实体类型（从 schema 派生，避免类型与校验分离） */
export type Project = z.infer<typeof ProjectSchema>;

/**
 * 创建项目入参
 *
 * 仅 name 必填，其余可选
 * name 会 trim 后校验非空
 */
export const ProjectCreateInputSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(200)
    .transform((s) => s.trim())
    .refine((s) => s.length > 0, { message: 'name 不能为空白' }),
  description: z.string().optional(),
  genre: z.string().max(50).optional(),
  cover: z.string().optional(),
});
export type ProjectCreateInput = z.infer<typeof ProjectCreateInputSchema>;

/**
 * 更新项目入参
 *
 * id 必填（定位记录），其余字段至少传 1 个
 * 使用 .refine 强制 partial 非空
 */
export const ProjectUpdateInputSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1).max(200).optional(),
    description: z.string().nullable().optional(),
    genre: z.string().max(50).nullable().optional(),
    cover: z.string().nullable().optional(),
    status: z
      .enum([ProjectStatus.ACTIVE, ProjectStatus.ARCHIVED, ProjectStatus.DRAFT])
      .optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .refine((data) => Object.keys(data).length > 1, {
    message: '至少需要更新 1 个字段（除 id 外）',
  });
export type ProjectUpdateInput = z.infer<typeof ProjectUpdateInputSchema>;
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `pnpm --filter @novel-writer/shared test`
Expected: project.schema.test.ts 全部通过。

### Task 4.2: Chapter Schema

- [ ] **Step 5: 写失败测试 — chapter.schema.test.ts**

创建 `f:\TraeProjects\1\packages\shared\src\__tests__\chapter.schema.test.ts`：

```ts
// packages/shared/src/__tests__/chapter.schema.test.ts
import { describe, expect, it } from 'vitest';
import {
  ChapterCreateInputSchema,
  ChapterSchema,
  ChapterUpdateInputSchema,
} from '../schemas/chapter.schema';

describe('ChapterSchema', () => {
  const validChapter = {
    id: 'clxxx',
    projectId: 'clp1',
    volumeId: null,
    title: '第一章 开端',
    content: '那是一个风雨交加的夜晚……',
    wordCount: 12,
    status: 'DRAFT',
    sortOrder: 0,
    metadata: {},
    createdAt: '2026-07-18T10:00:00.000Z',
    updatedAt: '2026-07-18T10:00:00.000Z',
  };

  it('接受合法章节', () => {
    expect(ChapterSchema.parse(validChapter)).toEqual(validChapter);
  });

  it('拒绝负的 wordCount', () => {
    expect(() => ChapterSchema.parse({ ...validChapter, wordCount: -1 })).toThrow();
  });

  it('拒绝负的 sortOrder', () => {
    expect(() => ChapterSchema.parse({ ...validChapter, sortOrder: -1 })).toThrow();
  });
});

describe('ChapterCreateInputSchema', () => {
  it('projectId + title 必填', () => {
    const parsed = ChapterCreateInputSchema.parse({
      projectId: 'clp1',
      title: '新章',
    });
    expect(parsed.title).toBe('新章');
  });

  it('缺 projectId 应拒绝', () => {
    expect(() =>
      ChapterCreateInputSchema.parse({ title: '新章' }),
    ).toThrow();
  });

  it('content 默认空字符串', () => {
    const parsed = ChapterCreateInputSchema.parse({
      projectId: 'clp1',
      title: '新章',
    });
    expect(parsed.content).toBe('');
  });
});

describe('ChapterUpdateInputSchema', () => {
  it('id 必填', () => {
    expect(() => ChapterUpdateInputSchema.parse({ title: 'X' })).toThrow();
  });

  it('接受部分更新', () => {
    const parsed = ChapterUpdateInputSchema.parse({
      id: 'clxxx',
      content: '新内容',
    });
    expect(parsed.content).toBe('新内容');
  });
});
```

- [ ] **Step 6: 运行测试，确认失败**

Run: `pnpm --filter @novel-writer/shared test`
Expected: `Cannot find module '../schemas/chapter.schema'`。

- [ ] **Step 7: 实现 chapter.schema.ts**

创建 `f:\TraeProjects\1\packages\shared\src\schemas\chapter.schema.ts`：

```ts
// packages/shared/src/schemas/chapter.schema.ts
// Chapter 实体 Zod schema + CRUD Input schema
// 字段来源：设计文档 §6.2 Prisma Chapter 模型

import { z } from 'zod';
import { ChapterStatus } from '../types/enums';

/** Chapter 实体 schema */
export const ChapterSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  volumeId: z.string().nullable().optional(),
  title: z.string().min(1).max(200),
  content: z.string(),
  wordCount: z.number().int().nonnegative(),
  status: z.enum([
    ChapterStatus.DRAFT,
    ChapterStatus.OUTLINE,
    ChapterStatus.WRITING,
    ChapterStatus.COMPLETED,
    ChapterStatus.REVISION,
  ]),
  sortOrder: z.number().int().nonnegative(),
  metadata: z.record(z.string(), z.unknown()).default({}),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});
export type Chapter = z.infer<typeof ChapterSchema>;

/** 创建章节入参（content 默认空，status 默认 DRAFT，sortOrder 默认 0） */
export const ChapterCreateInputSchema = z.object({
  projectId: z.string().min(1),
  volumeId: z.string().nullable().optional(),
  title: z.string().min(1).max(200),
  content: z.string().default(''),
  status: z
    .enum([
      ChapterStatus.DRAFT,
      ChapterStatus.OUTLINE,
      ChapterStatus.WRITING,
      ChapterStatus.COMPLETED,
      ChapterStatus.REVISION,
    ])
    .default(ChapterStatus.DRAFT),
  sortOrder: z.number().int().nonnegative().default(0),
});
export type ChapterCreateInput = z.infer<typeof ChapterCreateInputSchema>;

/** 更新章节入参 */
export const ChapterUpdateInputSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1).max(200).optional(),
    content: z.string().optional(),
    wordCount: z.number().int().nonnegative().optional(),
    status: z
      .enum([
        ChapterStatus.DRAFT,
        ChapterStatus.OUTLINE,
        ChapterStatus.WRITING,
        ChapterStatus.COMPLETED,
        ChapterStatus.REVISION,
      ])
      .optional(),
    sortOrder: z.number().int().nonnegative().optional(),
    volumeId: z.string().nullable().optional(),
  })
  .refine((data) => Object.keys(data).length > 1, {
    message: '至少需要更新 1 个字段（除 id 外）',
  });
export type ChapterUpdateInput = z.infer<typeof ChapterUpdateInputSchema>;
```

- [ ] **Step 8: 运行测试，确认通过**

Run: `pnpm --filter @novel-writer/shared test`
Expected: chapter.schema.test.ts 全部通过。

### Task 4.3: Character Schema

- [ ] **Step 9: 写失败测试 — character.schema.test.ts**

创建 `f:\TraeProjects\1\packages\shared\src\__tests__\character.schema.test.ts`：

```ts
// packages/shared/src/__tests__/character.schema.test.ts
import { describe, expect, it } from 'vitest';
import {
  CharacterCreateInputSchema,
  CharacterRelationInputSchema,
  CharacterSchema,
} from '../schemas/character.schema';

describe('CharacterSchema', () => {
  const valid = {
    id: 'clxxx',
    projectId: 'clp1',
    name: '林若曦',
    avatar: null,
    role: 'PROTAGONIST',
    description: '女主角，性格坚韧',
    profile: { age: 18, weapon: '青锋剑' },
    createdAt: '2026-07-18T10:00:00.000Z',
    updatedAt: '2026-07-18T10:00:00.000Z',
  };

  it('接受合法人物', () => {
    expect(CharacterSchema.parse(valid)).toEqual(valid);
  });

  it('拒绝 name 超过 100 字符', () => {
    expect(() =>
      CharacterSchema.parse({ ...valid, name: 'a'.repeat(101) }),
    ).toThrow();
  });

  it('拒绝非法 role', () => {
    expect(() => CharacterSchema.parse({ ...valid, role: 'HERO' })).toThrow();
  });
});

describe('CharacterCreateInputSchema', () => {
  it('projectId + name 必填', () => {
    const parsed = CharacterCreateInputSchema.parse({
      projectId: 'clp1',
      name: '苏墨白',
    });
    expect(parsed.name).toBe('苏墨白');
    expect(parsed.role).toBe('SUPPORTING');
  });

  it('role 可选，缺省为 SUPPORTING', () => {
    const parsed = CharacterCreateInputSchema.parse({
      projectId: 'clp1',
      name: '路人甲',
    });
    expect(parsed.role).toBe('SUPPORTING');
  });
});

describe('CharacterRelationInputSchema', () => {
  it('拒绝自环关系（from == to）', () => {
    expect(() =>
      CharacterRelationInputSchema.parse({
        fromCharacterId: 'c1',
        toCharacterId: 'c1',
        type: '朋友',
      }),
    ).toThrow();
  });

  it('接受合法关系', () => {
    const parsed = CharacterRelationInputSchema.parse({
      fromCharacterId: 'c1',
      toCharacterId: 'c2',
      type: '师徒',
      description: '林若曦拜苏墨白为师',
    });
    expect(parsed.type).toBe('师徒');
  });
});
```

- [ ] **Step 10: 运行测试，确认失败**

Run: `pnpm --filter @novel-writer/shared test`
Expected: `Cannot find module '../schemas/character.schema'`。

- [ ] **Step 11: 实现 character.schema.ts**

创建 `f:\TraeProjects\1\packages\shared\src\schemas\character.schema.ts`：

```ts
// packages/shared/src/schemas/character.schema.ts
// Character 实体 + 关系 Zod schema
// 字段来源：设计文档 §6.2 Prisma Character 模型 + §6.3 AGE 图边

import { z } from 'zod';
import { CharacterRole } from '../types/enums';

/** Character 实体 schema */
export const CharacterSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  name: z.string().min(1).max(100),
  avatar: z.string().nullable().optional(),
  role: z.enum([
    CharacterRole.PROTAGONIST,
    CharacterRole.ANTAGONIST,
    CharacterRole.SUPPORTING,
    CharacterRole.MINOR,
  ]),
  description: z.string().nullable().optional(),
  profile: z.record(z.string(), z.unknown()).default({}),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});
export type Character = z.infer<typeof CharacterSchema>;

/** 创建人物入参（role 缺省为 SUPPORTING） */
export const CharacterCreateInputSchema = z.object({
  projectId: z.string().min(1),
  name: z.string().min(1).max(100),
  avatar: z.string().optional(),
  role: z
    .enum([
      CharacterRole.PROTAGONIST,
      CharacterRole.ANTAGONIST,
      CharacterRole.SUPPORTING,
      CharacterRole.MINOR,
    ])
    .default(CharacterRole.SUPPORTING),
  description: z.string().optional(),
  profile: z.record(z.string(), z.unknown()).optional(),
});
export type CharacterCreateInput = z.infer<typeof CharacterCreateInputSchema>;

/** 更新人物入参 */
export const CharacterUpdateInputSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1).max(100).optional(),
    avatar: z.string().nullable().optional(),
    role: z
      .enum([
        CharacterRole.PROTAGONIST,
        CharacterRole.ANTAGONIST,
        CharacterRole.SUPPORTING,
        CharacterRole.MINOR,
      ])
      .optional(),
    description: z.string().nullable().optional(),
    profile: z.record(z.string(), z.unknown()).optional(),
  })
  .refine((data) => Object.keys(data).length > 1, {
    message: '至少需要更新 1 个字段（除 id 外）',
  });
export type CharacterUpdateInput = z.infer<typeof CharacterUpdateInputSchema>;

/**
 * 人物关系入参（AGE 图边）
 *
 * 自环关系（from == to）应拒绝，避免循环引用
 */
export const CharacterRelationInputSchema = z
  .object({
    fromCharacterId: z.string().min(1),
    toCharacterId: z.string().min(1),
    type: z.string().min(1).max(50),
    description: z.string().optional(),
    chapterId: z.string().optional(),
  })
  .refine((data) => data.fromCharacterId !== data.toCharacterId, {
    message: '人物关系不能自环（from 和 to 不能相同）',
    path: ['toCharacterId'],
  });
export type CharacterRelationInput = z.infer<typeof CharacterRelationInputSchema>;
```

- [ ] **Step 12: 运行测试，确认通过**

Run: `pnpm --filter @novel-writer/shared test`
Expected: character.schema.test.ts 全部通过。

### Task 4.4: Worldview / Chat / Rag / Settings Schema + 统一导出

- [ ] **Step 13: 创建 worldview.schema.ts**

创建 `f:\TraeProjects\1\packages\shared\src\schemas\worldview.schema.ts`：

```ts
// packages/shared/src/schemas/worldview.schema.ts
// Worldview（世界观条目，自关联树形）Zod schema
// 字段来源：设计文档 §6.2 Prisma Worldview 模型

import { z } from 'zod';

/** Worldview 实体 schema */
export const WorldviewSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  parentId: z.string().nullable().optional(),
  title: z.string().min(1).max(200),
  content: z.string().nullable().optional(),
  type: z.string().max(50).nullable().optional(),
  icon: z.string().nullable().optional(),
  sortOrder: z.number().int().nonnegative(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});
export type Worldview = z.infer<typeof WorldviewSchema>;

/** 创建世界观条目入参 */
export const WorldviewCreateInputSchema = z.object({
  projectId: z.string().min(1),
  parentId: z.string().nullable().optional(),
  title: z.string().min(1).max(200),
  content: z.string().optional(),
  type: z.string().max(50).optional(),
  icon: z.string().optional(),
  sortOrder: z.number().int().nonnegative().default(0),
});
export type WorldviewCreateInput = z.infer<typeof WorldviewCreateInputSchema>;

/** 更新世界观条目入参 */
export const WorldviewUpdateInputSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1).max(200).optional(),
    content: z.string().nullable().optional(),
    type: z.string().max(50).nullable().optional(),
    icon: z.string().nullable().optional(),
    sortOrder: z.number().int().nonnegative().optional(),
  })
  .refine((data) => Object.keys(data).length > 1, {
    message: '至少需要更新 1 个字段（除 id 外）',
  });
export type WorldviewUpdateInput = z.infer<typeof WorldviewUpdateInputSchema>;
```

- [ ] **Step 14: 创建 chat.schema.ts**

创建 `f:\TraeProjects\1\packages\shared\src\schemas\chat.schema.ts`：

```ts
// packages/shared/src/schemas/chat.schema.ts
// ChatSession / ChatMessage Zod schema
// 字段来源：设计文档 §6.2 Prisma ChatSession / ChatMessage 模型

import { z } from 'zod';
import { ChatRole } from '../types/enums';

/** ChatSession 实体 schema */
export const ChatSessionSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  title: z.string().min(1).max(200),
  context: z.record(z.string(), z.unknown()).default({}),
  model: z.string().max(50).nullable().optional(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});
export type ChatSession = z.infer<typeof ChatSessionSchema>;

/** ChatMessage 实体 schema */
export const ChatMessageSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  role: z.enum([ChatRole.USER, ChatRole.ASSISTANT, ChatRole.SYSTEM]),
  content: z.string(),
  tokens: z.number().int().nonnegative().default(0),
  metadata: z.record(z.string(), z.unknown()).default({}),
  createdAt: z.string().min(1),
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

/** 创建会话入参 */
export const ChatSessionCreateInputSchema = z.object({
  projectId: z.string().min(1),
  title: z.string().min(1).max(200),
  model: z.string().max(50).optional(),
});
export type ChatSessionCreateInput = z.infer<typeof ChatSessionCreateInputSchema>;

/** 发送消息入参 */
export const ChatSendMessageInputSchema = z.object({
  sessionId: z.string().min(1),
  content: z.string().min(1),
});
export type ChatSendMessageInput = z.infer<typeof ChatSendMessageInputSchema>;

/** 流式 chunk 事件 payload */
export const ChatStreamChunkPayloadSchema = z.object({
  sessionId: z.string().min(1),
  chunk: z.string(),
});
export type ChatStreamChunkPayload = z.infer<typeof ChatStreamChunkPayloadSchema>;

/** 流式 end 事件 payload */
export const ChatStreamEndPayloadSchema = z.object({
  sessionId: z.string().min(1),
  fullText: z.string(),
});
export type ChatStreamEndPayload = z.infer<typeof ChatStreamEndPayloadSchema>;

/** 流式 error 事件 payload */
export const ChatStreamErrorPayloadSchema = z.object({
  sessionId: z.string().min(1),
  error: z.unknown(),
});
export type ChatStreamErrorPayload = z.infer<typeof ChatStreamErrorPayloadSchema>;
```

- [ ] **Step 15: 创建 rag.schema.ts**

创建 `f:\TraeProjects\1\packages\shared\src\schemas\rag.schema.ts`：

```ts
// packages/shared/src/schemas/rag.schema.ts
// RagDocument / RagDocumentChunk Zod schema
// 字段来源：设计文档 §6.2 Prisma RagDocument / RagDocumentChunk 模型
// 注意：embedding 向量不跨 IPC 传输，schema 中不含 embedding 字段

import { z } from 'zod';

/** RagDocument 实体 schema */
export const RagDocumentSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  title: z.string().min(1).max(200),
  source: z.string().max(500).nullable().optional(),
  mimeType: z.string().max(100).nullable().optional(),
  chunksCount: z.number().int().nonnegative(),
  metadata: z.record(z.string(), z.unknown()).default({}),
  createdAt: z.string().min(1),
});
export type RagDocument = z.infer<typeof RagDocumentSchema>;

/** 文档入库入参 */
export const RagIngestDocumentInputSchema = z.object({
  projectId: z.string().min(1),
  title: z.string().min(1).max(200),
  fileContent: z.string().min(1),
  mimeType: z.string().max(100).optional(),
});
export type RagIngestDocumentInput = z.infer<typeof RagIngestDocumentInputSchema>;

/** 相似检索入参 */
export const RagSearchInputSchema = z.object({
  projectId: z.string().min(1),
  query: z.string().min(1),
  topK: z.number().int().positive().max(50).default(5),
  threshold: z.number().min(0).max(1).default(0.7),
});
export type RagSearchInput = z.infer<typeof RagSearchInputSchema>;

/** 检索结果项 */
export const RagSearchResultItemSchema = z.object({
  chunkId: z.string().min(1),
  documentId: z.string().min(1),
  content: z.string(),
  score: z.number().min(0).max(1),
});
export type RagSearchResultItem = z.infer<typeof RagSearchResultItemSchema>;
```

- [ ] **Step 16: 创建 settings.schema.ts**

创建 `f:\TraeProjects\1\packages\shared\src\schemas\settings.schema.ts`：

```ts
// packages/shared/src/schemas/settings.schema.ts
// ProjectSetting / AppSetting Zod schema
// 字段来源：设计文档 §6.2 Prisma ProjectSetting / AppSetting 模型

import { z } from 'zod';

/** ProjectSetting 实体 schema */
export const ProjectSettingSchema = z.object({
  projectId: z.string().min(1),
  aiModel: z.string().min(1).max(50),
  aiTemperature: z.number().min(0).max(2),
  aiMaxTokens: z.number().int().positive().max(32768),
  ragEnabled: z.boolean(),
  ragTopK: z.number().int().positive().max(50),
  ragThreshold: z.number().min(0).max(1),
  customPrompts: z.record(z.string(), z.unknown()).default({}),
  updatedAt: z.string().min(1),
});
export type ProjectSetting = z.infer<typeof ProjectSettingSchema>;

/** 更新项目设置入参 */
export const ProjectSettingUpdateInputSchema = z.object({
  projectId: z.string().min(1),
  aiModel: z.string().min(1).max(50).optional(),
  aiTemperature: z.number().min(0).max(2).optional(),
  aiMaxTokens: z.number().int().positive().max(32768).optional(),
  ragEnabled: z.boolean().optional(),
  ragTopK: z.number().int().positive().max(50).optional(),
  ragThreshold: z.number().min(0).max(1).optional(),
  customPrompts: z.record(z.string(), z.unknown()).optional(),
});
export type ProjectSettingUpdateInput = z.infer<typeof ProjectSettingUpdateInputSchema>;

/** AppSetting 实体 schema */
export const AppSettingSchema = z.object({
  key: z.string().min(1),
  value: z.string(),
  updatedAt: z.string().min(1),
});
export type AppSetting = z.infer<typeof AppSettingSchema>;

/** 设置 AppSetting 入参 */
export const AppSettingSetInputSchema = z.object({
  key: z.string().min(1),
  value: z.string(),
});
export type AppSettingSetInput = z.infer<typeof AppSettingSetInputSchema>;

/** API Key 测试入参（不携带 key 本身，只测已存 key 是否有效） */
export const TestApiKeyInputSchema = z.object({
  provider: z.enum(['deepseek', 'ollama']),
});
export type TestApiKeyInput = z.infer<typeof TestApiKeyInputSchema>;
```

- [ ] **Step 17: 创建 schemas/index.ts 统一导出**

创建 `f:\TraeProjects\1\packages\shared\src\schemas\index.ts`：

```ts
// packages/shared/src/schemas/index.ts
// Zod schema 统一导出
// 使用 re-export 让外部可通过 '@novel-writer/shared' 直接访问

export * from './project.schema';
export * from './chapter.schema';
export * from './character.schema';
export * from './worldview.schema';
export * from './chat.schema';
export * from './rag.schema';
export * from './settings.schema';
```

- [ ] **Step 18: 验证全部 schema 测试通过**

Run: `pnpm --filter @novel-writer/shared test`
Expected: 全部测试通过。

- [ ] **Step 19: 验证 typecheck + lint**

Run: `pnpm typecheck && pnpm lint`
Expected: 0 errors 0 warnings。

- [ ] **Step 20: Commit**

```bash
git add packages/shared/src/schemas/ packages/shared/src/__tests__/project.schema.test.ts packages/shared/src/__tests__/chapter.schema.test.ts packages/shared/src/__tests__/character.schema.test.ts
git commit -m "feat(shared): 业务实体 Zod schema 与 CRUD 入参校验"
```

---

## Task 5: IPC 类型契约（channels + response + payloads + api）

**Files:**
- Create: `packages/shared/src/ipc/channels.ts`
- Create: `packages/shared/src/ipc/response.ts`
- Create: `packages/shared/src/ipc/payloads.ts`
- Create: `packages/shared/src/ipc/api.ts`
- Create: `packages/shared/src/__tests__/channels.test.ts`
- Create: `packages/shared/src/__tests__/api.test.ts`

参考设计文档 §5.2（命名规范）、§5.3（Channel 清单）、§5.4（类型契约）、§7.4（错误处理流程）。

- [ ] **Step 1: 创建 channels.ts**

创建 `f:\TraeProjects\1\packages\shared\src\ipc\channels.ts`：

```ts
// packages/shared/src/ipc/channels.ts
// IPC Channel 字符串常量
// 设计文档 §5.2 命名规范 + §5.3 完整清单
//
// 命名规范：
//   {domain}:{action}        请求-响应（ipcMain.handle）
//   {domain}:stream:{event}  流式事件（webContents.send）
//   {domain}:event:{name}    状态变更事件（webContents.send）
//
// 使用 as const 派生字面量类型，防止 ipcMain.handle / ipcRenderer.on 拼写错误

export const IPC_CHANNELS = {
  // ── 项目 ──────────────────────────────────────────
  PROJECT_CREATE: 'project:create',
  PROJECT_LIST: 'project:list',
  PROJECT_GET: 'project:get',
  PROJECT_UPDATE: 'project:update',
  PROJECT_DELETE: 'project:delete',
  PROJECT_ARCHIVE: 'project:archive',

  // ── 章节 ──────────────────────────────────────────
  CHAPTER_CREATE: 'chapter:create',
  CHAPTER_LIST: 'chapter:list',
  CHAPTER_GET: 'chapter:get',
  CHAPTER_UPDATE: 'chapter:update',
  CHAPTER_REORDER: 'chapter:reorder',
  CHAPTER_DELETE: 'chapter:delete',

  // ── 人物 ──────────────────────────────────────────
  CHARACTER_CREATE: 'character:create',
  CHARACTER_LIST: 'character:list',
  CHARACTER_UPDATE: 'character:update',
  CHARACTER_DELETE: 'character:delete',
  CHARACTER_GET_RELATIONS: 'character:getRelations',
  CHARACTER_ADD_RELATION: 'character:addRelation',

  // ── 世界观 ────────────────────────────────────────
  WORLDVIEW_CREATE: 'worldview:create',
  WORLDVIEW_TREE: 'worldview:tree',
  WORLDVIEW_UPDATE: 'worldview:update',
  WORLDVIEW_DELETE: 'worldview:delete',

  // ── AI 对话 ───────────────────────────────────────
  CHAT_CREATE_SESSION: 'chat:createSession',
  CHAT_LIST_SESSIONS: 'chat:listSessions',
  CHAT_GET_MESSAGES: 'chat:getMessages',
  CHAT_SEND_MESSAGE: 'chat:sendMessage',
  CHAT_STOP_GENERATION: 'chat:stopGeneration',

  // 流式事件（M→R）
  CHAT_STREAM_CHUNK: 'chat:stream:chunk',
  CHAT_STREAM_END: 'chat:stream:end',
  CHAT_STREAM_ERROR: 'chat:stream:error',

  // ── RAG ───────────────────────────────────────────
  RAG_INGEST_DOCUMENT: 'rag:ingestDocument',
  RAG_SEARCH: 'rag:search',
  RAG_LIST_DOCUMENTS: 'rag:listDocuments',
  RAG_DELETE_DOCUMENT: 'rag:deleteDocument',

  // ── Agent 编排 ────────────────────────────────────
  AGENT_GENERATE_CHAPTER: 'agent:generateChapter',
  AGENT_REWRITE: 'agent:rewrite',
  AGENT_EXPAND_OUTLINE: 'agent:expandOutline',

  // ── 设置 ──────────────────────────────────────────
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',
  SETTINGS_SET_API_KEY: 'settings:setApiKey',
  SETTINGS_TEST_API_KEY: 'settings:testApiKey',

  // ── 应用级 ────────────────────────────────────────
  APP_GET_STATUS: 'app:getStatus',
  APP_OPEN_EXTERNAL: 'app:openExternal',

  // 状态变更事件（M→R）
  APP_EVENT_PG_STATUS: 'app:event:pgStatus',
  APP_EVENT_OLLAMA_STATUS: 'app:event:ollamaStatus',
  APP_EVENT_OLLAMA_PULL_PROGRESS: 'app:event:ollamaPullProgress',
} as const;

/** IPC Channel 字面量联合类型 */
export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];
```

- [ ] **Step 2: 创建 response.ts**

创建 `f:\TraeProjects\1\packages\shared\src\ipc\response.ts`：

```ts
// packages/shared/src/ipc/response.ts
// IPC 统一返回结构 + IpcContext
// 设计文档 §7.4 错误处理流程：handler wrap() 返回 { data } | { error }

import type { IpcError } from '../constants/errors';

/**
 * IPC 统一响应结构
 *
 * 成功：{ data: T }
 * 失败：{ error: IpcError }
 *
 * 使用 discriminated union，渲染层可通过 'data' in resp 判断
 */
export type IpcResponse<T> = { readonly data: T } | { readonly error: IpcError };

/**
 * IPC handler 上下文
 *
 * 由 wrap() 注入，包含 traceId 和 sender 校验信息
 * traceId 贯穿渲染层 → IPC → 主进程日志 → Sentry（设计文档 §4.7）
 */
export interface IpcContext {
  /** 贯穿链路的 traceId（渲染层可显式传入，否则主进程生成） */
  readonly traceId: string;
  /** 调用方 WebContents（用于反向推送流式事件） */
  readonly sender: unknown;
}

/** 流式事件订阅器（渲染层用，返回 unsubscribe 函数） */
export type StreamSubscriber<TPayload> = (callback: (payload: TPayload) => void) => () => void;
```

- [ ] **Step 3: 创建 payloads.ts**

创建 `f:\TraeProjects\1\packages\shared\src\ipc\payloads.ts`：

```ts
// packages/shared/src/ipc/payloads.ts
// IPC 请求/响应/事件 payload 类型映射
// 设计文档 §5.3 完整 Channel 清单
//
// 每个请求-响应 channel 定义 Req（请求入参）和 Res（响应数据）类型
// 流式/事件 channel 定义 Payload 类型

import type {
  Chapter,
  Character,
  ChatMessage,
  ChatSession,
  Project,
  ProjectSetting,
  RagDocument,
  RagSearchResultItem,
  Worldview,
} from '../types/models';
import type {
  AppSetting,
} from '../types/models';
import type {
  CharacterRelationInput,
  ChatSendMessageInput,
  ChatSessionCreateInput,
  ChatStreamChunkPayload,
  ChatStreamEndPayload,
  ChatStreamErrorPayload,
  ChapterCreateInput,
  ChapterUpdateInput,
  CharacterCreateInput,
  CharacterUpdateInput,
  ProjectCreateInput,
  ProjectUpdateInput,
  ProjectSettingUpdateInput,
  RagIngestDocumentInput,
  RagSearchInput,
  TestApiKeyInput,
  WorldviewCreateInput,
  WorldviewUpdateInput,
} from '../schemas';

/** 应用状态（health check） */
export interface AppStatus {
  readonly pgStatus: 'starting' | 'running' | 'stopped' | 'crashed';
  readonly ollamaStatus: 'starting' | 'running' | 'stopped' | 'not_installed';
  readonly ollamaModelReady: boolean;
  readonly dbConnected: boolean;
}

/** Ollama 模型拉取进度事件 payload */
export interface OllamaPullProgressPayload {
  readonly model: string;
  readonly completed: number;
  readonly total: number;
  readonly percent: number;
}

/** 请求-响应 channel 类型映射：Req → Res */
export interface IpcRequestMap {
  // 项目
  'project:create': { req: ProjectCreateInput; res: Project };
  'project:list': { req: void; res: Project[] };
  'project:get': { req: { id: string }; res: Project };
  'project:update': { req: ProjectUpdateInput; res: Project };
  'project:delete': { req: { id: string }; res: { id: string } };
  'project:archive': { req: { id: string }; res: Project };

  // 章节
  'chapter:create': { req: ChapterCreateInput; res: Chapter };
  'chapter:list': { req: { projectId: string }; res: Chapter[] };
  'chapter:get': { req: { id: string }; res: Chapter };
  'chapter:update': { req: ChapterUpdateInput; res: Chapter };
  'chapter:reorder': { req: { projectId: string; orderedIds: string[] }; res: { id: string; sortOrder: number }[] };
  'chapter:delete': { req: { id: string }; res: { id: string } };

  // 人物
  'character:create': { req: CharacterCreateInput; res: Character };
  'character:list': { req: { projectId: string }; res: Character[] };
  'character:update': { req: CharacterUpdateInput; res: Character };
  'character:delete': { req: { id: string }; res: { id: string } };
  'character:getRelations': { req: { projectId: string }; res: CharacterRelationInput[] };
  'character:addRelation': { req: CharacterRelationInput; res: CharacterRelationInput };

  // 世界观
  'worldview:create': { req: WorldviewCreateInput; res: Worldview };
  'worldview:tree': { req: { projectId: string }; res: Worldview[] };
  'worldview:update': { req: WorldviewUpdateInput; res: Worldview };
  'worldview:delete': { req: { id: string }; res: { id: string } };

  // 对话
  'chat:createSession': { req: ChatSessionCreateInput; res: ChatSession };
  'chat:listSessions': { req: { projectId: string }; res: ChatSession[] };
  'chat:getMessages': { req: { sessionId: string }; res: ChatMessage[] };
  'chat:sendMessage': { req: ChatSendMessageInput; res: { ackId: string } };
  'chat:stopGeneration': { req: { sessionId: string }; res: { stopped: boolean } };

  // RAG
  'rag:ingestDocument': { req: RagIngestDocumentInput; res: { documentId: string; chunksCount: number } };
  'rag:search': { req: RagSearchInput; res: RagSearchResultItem[] };
  'rag:listDocuments': { req: { projectId: string }; res: RagDocument[] };
  'rag:deleteDocument': { req: { id: string }; res: { id: string } };

  // Agent
  'agent:generateChapter': { req: { projectId: string; prevChapterId?: string; prompt?: string }; res: { ackId: string } };
  'agent:rewrite': { req: { chapterId: string; instruction: string }; res: { ackId: string } };
  'agent:expandOutline': { req: { projectId: string; outline: string }; res: { ackId: string } };

  // 设置
  'settings:get': { req: { projectId: string }; res: ProjectSetting };
  'settings:set': { req: ProjectSettingUpdateInput; res: ProjectSetting };
  'settings:setApiKey': { req: { provider: 'deepseek' | 'ollama'; apiKey: string }; res: { ok: boolean } };
  'settings:testApiKey': { req: TestApiKeyInput; res: { ok: boolean; latencyMs?: number } };

  // 应用级
  'app:getStatus': { req: void; res: AppStatus };
  'app:openExternal': { req: { url: string }; res: { ok: boolean } };
}

/** 流式/事件 channel payload 映射 */
export interface IpcEventMap {
  'chat:stream:chunk': ChatStreamChunkPayload;
  'chat:stream:end': ChatStreamEndPayload;
  'chat:stream:error': ChatStreamErrorPayload;
  'app:event:pgStatus': AppStatus['pgStatus'];
  'app:event:ollamaStatus': AppStatus['ollamaStatus'];
  'app:event:ollamaPullProgress': OllamaPullProgressPayload;
}
```

- [ ] **Step 4: 创建 api.ts**

创建 `f:\TraeProjects\1\packages\shared\src\ipc\api.ts`：

```ts
// packages/shared/src/ipc/api.ts
// IpcApi 接口：window.api 形状定义
// 设计文档 §5.4 类型契约单一来源
//
// Preload 实现 IpcApi，渲染层消费 IpcApi（通过 window.api）
// 全局 Window 接口扩展在此声明，渲染层无需重复声明

import type { IpcChannel } from './channels';
import type { IpcRequestMap, IpcEventMap } from './payloads';
import type { IpcResponse, StreamSubscriber } from './response';

/**
 * 提取请求-响应 channel 的方法签名
 *
 * 入参类型：IpcRequestMap[Channel]['req']（void 时省略参数）
 * 返回类型：Promise<IpcResponse<IpcRequestMap[Channel]['res']>>
 */
type IpcInvokeMethod<Channel extends keyof IpcRequestMap> =
  IpcRequestMap[Channel]['req'] extends void
    ? () => Promise<IpcResponse<IpcRequestMap[Channel]['res']>>
    : (input: IpcRequestMap[Channel]['req']) => Promise<IpcResponse<IpcRequestMap[Channel]['res']>>;

/** 提取事件 channel 的订阅方法签名 */
type IpcSubscribeMethod<Channel extends keyof IpcEventMap> = (
  callback: (payload: IpcEventMap[Channel]) => void,
) => () => void;

/**
 * IpcApi 接口：window.api 完整形状
 *
 * 按业务域分组，每个域包含该域所有 channel 的方法
 */
export interface IpcApi {
  project: {
    create: IpcInvokeMethod<'project:create'>;
    list: IpcInvokeMethod<'project:list'>;
    get: IpcInvokeMethod<'project:get'>;
    update: IpcInvokeMethod<'project:update'>;
    delete: IpcInvokeMethod<'project:delete'>;
    archive: IpcInvokeMethod<'project:archive'>;
  };
  chapter: {
    create: IpcInvokeMethod<'chapter:create'>;
    list: IpcInvokeMethod<'chapter:list'>;
    get: IpcInvokeMethod<'chapter:get'>;
    update: IpcInvokeMethod<'chapter:update'>;
    reorder: IpcInvokeMethod<'chapter:reorder'>;
    delete: IpcInvokeMethod<'chapter:delete'>;
  };
  character: {
    create: IpcInvokeMethod<'character:create'>;
    list: IpcInvokeMethod<'character:list'>;
    update: IpcInvokeMethod<'character:update'>;
    delete: IpcInvokeMethod<'character:delete'>;
    getRelations: IpcInvokeMethod<'character:getRelations'>;
    addRelation: IpcInvokeMethod<'character:addRelation'>;
  };
  worldview: {
    create: IpcInvokeMethod<'worldview:create'>;
    tree: IpcInvokeMethod<'worldview:tree'>;
    update: IpcInvokeMethod<'worldview:update'>;
    delete: IpcInvokeMethod<'worldview:delete'>;
  };
  chat: {
    createSession: IpcInvokeMethod<'chat:createSession'>;
    listSessions: IpcInvokeMethod<'chat:listSessions'>;
    getMessages: IpcInvokeMethod<'chat:getMessages'>;
    sendMessage: IpcInvokeMethod<'chat:sendMessage'>;
    stopGeneration: IpcInvokeMethod<'chat:stopGeneration'>;
    onStreamChunk: IpcSubscribeMethod<'chat:stream:chunk'>;
    onStreamEnd: IpcSubscribeMethod<'chat:stream:end'>;
    onStreamError: IpcSubscribeMethod<'chat:stream:error'>;
  };
  rag: {
    ingestDocument: IpcInvokeMethod<'rag:ingestDocument'>;
    search: IpcInvokeMethod<'rag:search'>;
    listDocuments: IpcInvokeMethod<'rag:listDocuments'>;
    deleteDocument: IpcInvokeMethod<'rag:deleteDocument'>;
  };
  agent: {
    generateChapter: IpcInvokeMethod<'agent:generateChapter'>;
    rewrite: IpcInvokeMethod<'agent:rewrite'>;
    expandOutline: IpcInvokeMethod<'agent:expandOutline'>;
  };
  settings: {
    get: IpcInvokeMethod<'settings:get'>;
    set: IpcInvokeMethod<'settings:set'>;
    setApiKey: IpcInvokeMethod<'settings:setApiKey'>;
    testApiKey: IpcInvokeMethod<'settings:testApiKey'>;
  };
  app: {
    getStatus: IpcInvokeMethod<'app:getStatus'>;
    openExternal: IpcInvokeMethod<'app:openExternal'>;
    onPgStatusChange: IpcSubscribeMethod<'app:event:pgStatus'>;
    onOllamaStatusChange: IpcSubscribeMethod<'app:event:ollamaStatus'>;
    onOllamaPullProgress: IpcSubscribeMethod<'app:event:ollamaPullProgress'>;
  };
}

/** 全局 Window 接口扩展（渲染层通过 window.api 访问） */
declare global {
  interface Window {
    api: IpcApi;
  }
}

// 必须的空 export，确保此文件被视为模块
export {};
```

- [ ] **Step 5: 写测试 — channels.test.ts**

创建 `f:\TraeProjects\1\packages\shared\src\__tests__\channels.test.ts`：

```ts
// packages/shared/src/__tests__/channels.test.ts
// IPC_CHANNELS 完整性测试
import { describe, expect, it } from 'vitest';
import { IPC_CHANNELS } from '../ipc/channels';

describe('IPC_CHANNELS', () => {
  it('所有 channel 字符串符合命名规范 {domain}:{action} 或 {domain}:{stream|event}:{name}', () => {
    const pattern = /^[a-z]+:[a-z]+(?::[a-zA-Z]+)?$/;
    for (const [key, channel] of Object.entries(IPC_CHANNELS)) {
      expect(channel).toMatch(pattern);
    }
  });

  it('channel 值全局唯一（无重复）', () => {
    const values = Object.values(IPC_CHANNELS);
    const set = new Set(values);
    expect(set.size).toBe(values.length);
  });

  it('包含设计文档 §5.3 规定的所有 channel', () => {
    // 抽查关键 channel
    expect(IPC_CHANNELS.PROJECT_CREATE).toBe('project:create');
    expect(IPC_CHANNELS.CHAPTER_LIST).toBe('chapter:list');
    expect(IPC_CHANNELS.CHARACTER_ADD_RELATION).toBe('character:addRelation');
    expect(IPC_CHANNELS.CHAT_SEND_MESSAGE).toBe('chat:sendMessage');
    expect(IPC_CHANNELS.CHAT_STREAM_CHUNK).toBe('chat:stream:chunk');
    expect(IPC_CHANNELS.RAG_INGEST_DOCUMENT).toBe('rag:ingestDocument');
    expect(IPC_CHANNELS.AGENT_GENERATE_CHAPTER).toBe('agent:generateChapter');
    expect(IPC_CHANNELS.SETTINGS_SET_API_KEY).toBe('settings:setApiKey');
    expect(IPC_CHANNELS.APP_GET_STATUS).toBe('app:getStatus');
    expect(IPC_CHANNELS.APP_EVENT_OLLAMA_PULL_PROGRESS).toBe('app:event:ollamaPullProgress');
  });
});
```

- [ ] **Step 6: 写测试 — api.test.ts（结构完整性）**

创建 `f:\TraeProjects\1\packages\shared\src\__tests__\api.test.ts`：

```ts
// packages/shared/src/__tests__/api.test.ts
// IpcApi 接口结构完整性测试（类型层面，运行时仅做接口存在性检查）
import { describe, expect, it } from 'vitest';
import type { IpcApi } from '../ipc/api';

describe('IpcApi interface', () => {
  it('包含所有业务域', () => {
    // 通过类型约束编译时校验，运行时仅做存在性 sanity check
    const domains: Array<keyof IpcApi> = [
      'project',
      'chapter',
      'character',
      'worldview',
      'chat',
      'rag',
      'agent',
      'settings',
      'app',
    ];
    expect(domains.length).toBe(9);
  });

  it('chat 域同时含 invoke 和 subscribe 方法', () => {
    type ChatApi = IpcApi['chat'];
    const invokeMethods: Array<keyof ChatApi> = [
      'createSession',
      'listSessions',
      'getMessages',
      'sendMessage',
      'stopGeneration',
    ];
    const subscribeMethods: Array<keyof ChatApi> = [
      'onStreamChunk',
      'onStreamEnd',
      'onStreamError',
    ];
    expect(invokeMethods.length + subscribeMethods.length).toBe(8);
  });

  it('app 域含状态事件订阅方法', () => {
    type AppApi = IpcApi['app'];
    const methods: Array<keyof AppApi> = [
      'getStatus',
      'openExternal',
      'onPgStatusChange',
      'onOllamaStatusChange',
      'onOllamaPullProgress',
    ];
    expect(methods.length).toBe(5);
  });
});
```

- [ ] **Step 7: 运行测试**

Run: `pnpm --filter @novel-writer/shared test`
Expected: channels.test.ts + api.test.ts 全部通过。

- [ ] **Step 8: 验证 typecheck + lint**

Run: `pnpm typecheck && pnpm lint`
Expected: 0 errors 0 warnings。

- [ ] **Step 9: Commit**

```bash
git add packages/shared/src/ipc/ packages/shared/src/__tests__/channels.test.ts packages/shared/src/__tests__/api.test.ts
git commit -m "feat(shared): IPC 类型契约与 channel 常量（§5.2-5.4）"
```

---

## Task 6: 统一导出 + 最终验证

**Files:**
- Modify: `packages/shared/src/index.ts`

- [ ] **Step 1: 修改 src/index.ts 统一导出**

修改 `f:\TraeProjects\1\packages\shared\src\index.ts`，完整新内容：

```ts
// packages/shared/src/index.ts
// @novel-writer/shared 跨进程共享包统一入口
// 暴露：错误码 + 业务实体类型 + Zod schema + IPC 类型契约
//
// 消费方：
// - 主进程：import { AppError, ErrorCode, ProjectCreateInputSchema } from '@novel-writer/shared'
// - Preload：import type { IpcApi } from '@novel-writer/shared'
// - 渲染层：import type { Project, IpcResponse } from '@novel-writer/shared'

// 错误处理（§7）
export * from './constants/errors';

// 业务实体类型与枚举（§6.2）
export * from './types/enums';
export * from './types/models';

// Zod schema + CRUD Input（运行时校验 + 类型派生）
export * from './schemas';

// IPC 类型契约（§5）
export * from './ipc/channels';
export * from './ipc/response';
export * from './ipc/payloads';
export * from './ipc/api';

// 包版本（供运行时 sanity check）
export const SHARED_VERSION = '0.1.0' as const;
```

- [ ] **Step 2: 验证全部测试通过**

Run: `pnpm --filter @novel-writer/shared test`
Expected: 全部测试通过（errors / project.schema / chapter.schema / character.schema / channels / api 共 6 个测试文件）。

- [ ] **Step 3: 验证根目录 typecheck + lint + build**

Run: `pnpm typecheck && pnpm lint && pnpm build`
Expected: 0 errors 0 warnings，三入口产物生成（Phase 1 build 不受影响）。

- [ ] **Step 4: 验证 dev 仍可启动**

Run: `pnpm dev`（后台启动 8 秒后检查 electron 进程，然后停止）
Expected: Electron 窗口正常弹出，无报错。

- [ ] **Step 5: 验证导入可用（手动 smoke test）**

创建临时文件 `packages/shared/src/__tests__/smoke.test.ts`：

```ts
// packages/shared/src/__tests__/smoke.test.ts
// 冒烟测试：验证统一导出可被外部消费
import { describe, expect, it } from 'vitest';
import {
  AppError,
  ErrorCode,
  IPC_CHANNELS,
  ProjectCreateInputSchema,
  SHARED_VERSION,
} from '../index';
import type { IpcApi, IpcResponse, Project } from '../index';

describe('smoke: packages/shared 统一导出', () => {
  it('可导入常量', () => {
    expect(SHARED_VERSION).toBe('0.1.0');
    expect(IPC_CHANNELS.PROJECT_CREATE).toBe('project:create');
  });

  it('可使用 AppError', () => {
    const err = new AppError(ErrorCode.UNKNOWN);
    expect(err.code).toBe('UNKNOWN');
    expect(err.toIpcError().code).toBe('UNKNOWN');
  });

  it('可使用 Zod schema', () => {
    const parsed = ProjectCreateInputSchema.parse({ name: '测试' });
    expect(parsed.name).toBe('测试');
  });

  it('可引用类型（编译时校验）', () => {
    const resp: IpcResponse<Project> = { data: {
      id: 'x',
      name: 'x',
      status: 'DRAFT',
      metadata: {},
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    } };
    expect('data' in resp).toBe(true);
  });

  it('IpcApi 接口编译时可达', () => {
    // 此函数签名仅在编译时验证类型可达
    function _consume(api: IpcApi): void {
      void api;
    }
    expect(typeof _consume).toBe('function');
  });
});
```

Run: `pnpm --filter @novel-writer/shared test`
Expected: smoke 测试通过。

- [ ] **Step 6: 删除临时 smoke 测试（保留为正式测试）**

不删除，保留为 `smoke.test.ts` 作为包导入完整性回归测试。

- [ ] **Step 7: 最终 typecheck + lint + build + test**

Run: `pnpm typecheck && pnpm lint && pnpm build && pnpm test`
Expected: 全部 0 errors 0 warnings，全部测试通过。

- [ ] **Step 8: Commit**

```bash
git add packages/shared/src/index.ts packages/shared/src/__tests__/smoke.test.ts
git commit -m "feat(shared): 统一导出与冒烟测试"
```

---

## Phase 2 完成验收清单

- [ ] `pnpm install` 无错误无警告
- [ ] `pnpm typecheck` 0 errors 0 warnings
- [ ] `pnpm lint` 0 errors 0 warnings
- [ ] `pnpm build` 三入口产物全部生成（不破坏 Phase 1）
- [ ] `pnpm dev` Electron 窗口正常弹出
- [ ] `pnpm test` 全部测试通过（≥6 个测试文件）
- [ ] `@novel-writer/shared` 可被主进程 / preload / 渲染层 import
- [ ] ErrorCode 覆盖设计文档 §7.2 全部 35+ 错误码
- [ ] IPC_CHANNELS 覆盖设计文档 §5.3 全部 40+ channel
- [ ] IpcApi 接口包含 9 个业务域
- [ ] Zod schema 覆盖 7 类业务实体（Project/Chapter/Character/Worldview/Chat/Rag/Settings）
- [ ] git log 至少 5 个 Phase 2 commit
- [ ] 设计文档 §10.3 开发规范仍全部落实

---

## 后续 Phase 预告

- **Phase 3**: 主进程 infra（logger / wrap / errors / Prisma / PG controller / Ollama controller / AI client）
- **Phase 4**: 数据库 schema + migrations + AGE + HNSW
- **Phase 5**: Service 层（9 个 service，消费 @novel-writer/shared 的类型与 schema）
