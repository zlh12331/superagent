# Phase 3a: 主进程核心工具 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现主进程核心基础设施（logger / config / storage / retry / wrap / Sentry），为后续 IPC handlers、Services、PG/Ollama 进程管理提供可观测性、错误处理与配置基础。

**Architecture:** 纯工具层，不依赖 Prisma / PG / Ollama / AI SDK。logger 基于 electron-log 5 封装结构化日志 + traceId 贯穿；wrap 作为 IPC handler 统一包装器，集成 sender 校验 + zod 校验 + Sentry 上报；敏感数据（API Key）使用 Electron 内置 safeStorage API 加密存储到本地文件（替代 keytar，避免 native rebuild，符合 Electron 官方安全建议）。

**Tech Stack:** Electron 40（safeStorage / app）、electron-log 5、@sentry/electron 5、zod 4、Vitest 4（colocation + vi.mock Electron API）、TypeScript 6.0（strict + isolatedDeclarations）。

**Spec Reference:**
- 设计文档 §7.1-7.6（错误处理与日志体系）
- 设计文档 §7.7（Sentry 集成）
- 设计文档 §7.10（用户友好错误提示）
- 设计文档 §4.3（Infra 层职责：storage/keychain、storage/app-data）
- 设计文档 §4.5-4.7（Electron 安全配置 + IPC sender 校验 + traceId 贯穿）

**关键设计决策（偏离设计文档，需在执行时同步更新设计文档）：**
1. **safeStorage 替代 keytar**：设计文档 §2.2 列出 keytar ^7，但 keytar 是 native module，在 Electron 40 下需要 rebuild。Electron 官方推荐使用内置 `safeStorage` API（基于 OS DPAPI/Keychain/libsecret），不需要 native rebuild，且跨平台一致。本计划采用 safeStorage。
2. **Phase 3 拆分为 3a + 3b**：Phase 3 原计划包含 11 个子系统，规模过大。拆分为 3a（核心工具，本计划）+ 3b（进程管理 + AI 客户端）。3a 是 3b 的依赖。

---

## 文件结构总览

执行完成后 `src/main/` 目录形态（**仅列出本 Phase 新建/修改文件**）：

```
src/main/
├── index.ts                          # Modify: 集成 Sentry init + 全局错误捕获
├── vitest.config.ts                  # Create: main 进程 Vitest 配置
├── config/
│   └── index.ts                      # Create: 应用配置（env + zod 校验 + 默认值）
├── utils/
│   ├── logger.ts                     # Create: electron-log 5 封装 + 结构化日志 + traceId
│   ├── retry.ts                      # Create: 指数退避 + 抖动重试工具
│   └── wrap.ts                      # Create: IPC handler 统一包装器
├── infra/
│   └── storage/
│       ├── app-data.ts               # Create: %APPDATA% 路径管理
│       └── keychain.ts               # Create: safeStorage 加密存储（替代 keytar）
├── __tests__/
│   ├── logger.test.ts                # Create: logger 单测
│   ├── config.test.ts                # Create: config 单测
│   ├── app-data.test.ts              # Create: app-data 单测
│   ├── keychain.test.ts              # Create: keychain 单测
│   ├── retry.test.ts                 # Create: retry 单测
│   └── wrap.test.ts                  # Create: wrap 单测
```

**职责划分：**
- `utils/logger.ts`：electron-log 5 单例封装，提供结构化日志（支持 traceId 字段）、文件轮转、全局错误捕获注册
- `utils/retry.ts`：通用重试工具，仅对 `retryable=true` 的 AppError 重试，指数退避 + 抖动
- `utils/wrap.ts`：IPC handler 包装器，集成 sender 校验 + traceId + zod 校验 + try/catch + Sentry + 返回统一 `{ data } | { error }`
- `config/index.ts`：从 `process.env` 读取配置，zod 校验，提供类型安全的 `appConfig` 单例
- `infra/storage/app-data.ts`：封装 `app.getPath('userData')`，提供 getDataPath / getLogsPath / getBackupsPath / getCachePath
- `infra/storage/keychain.ts`：使用 Electron `safeStorage` API 加密/解密敏感数据，存储到 app-data 目录下的 JSON 文件

**依赖方向（严格遵守）：**
- `utils/*` 无内部依赖（仅依赖外部库 + @novel-writer/shared）
- `config/index.ts` 依赖 @novel-writer/shared（zod）
- `infra/storage/app-data.ts` 依赖 Electron `app` API
- `infra/storage/keychain.ts` 依赖 `infra/storage/app-data.ts` + Electron `safeStorage` API
- `utils/wrap.ts` 依赖 `utils/logger.ts` + `@novel-writer/shared`（AppError / IpcResponse / IPC_CHANNELS）
- `index.ts` 依赖 `utils/logger.ts` + `config/index.ts` + @sentry/electron

---

## Task 1: 安装依赖 + 配置 Vitest

**Files:**
- Modify: `package.json`（根，添加 electron-log + @sentry/electron 依赖）
- Create: `src/main/vitest.config.ts`
- Modify: `src/main/tsconfig.json`（添加 vitest 类型）

- [ ] **Step 1: 在根 package.json 添加依赖**

在 `f:\TraeProjects\1\package.json` 的 `dependencies` 中添加：

```json
"electron-log": "^5",
"@sentry/electron": "^5"
```

完整 `dependencies` 字段：
```json
"dependencies": {
  "@sentry/electron": "^5",
  "electron": "^40",
  "electron-log": "^5",
  "electron-vite": "6.0.0-beta.1",
  "react": "^19.2",
  "react-dom": "^19.2",
  "vite": "^8"
}
```

- [ ] **Step 2: 安装依赖**

Run: `pnpm install`
Expected: 无错误无警告，pnpm-lock.yaml 更新。

- [ ] **Step 3: 创建 src/main/vitest.config.ts**

新建 `f:\TraeProjects\1\src\main\vitest.config.ts`：

```ts
// src/main/vitest.config.ts
// main 进程 Vitest 配置
// 参考 Vitest 4 官方文档 https://vitest.dev/config/
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 启用 globals：允许 describe/it/expect 无需显式 import
    globals: true,
    // 测试文件位置：与源码同目录（colocation 模式）
    include: ['__tests__/**/*.test.ts'],
    // 覆盖率收集
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
    },
  },
});
```

- [ ] **Step 4: 修改 src/main/tsconfig.json，添加 vitest 类型**

修改 `f:\TraeProjects\1\src\main\tsconfig.json`，完整新内容：

```json
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "extends": "@novel-writer/tsconfig/node.json",
  "compilerOptions": {
    "outDir": "./out",
    "rootDir": "./",
    "types": ["node", "vitest/globals"]
  },
  "include": ["**/*.ts"]
}
```

- [ ] **Step 5: 在根 package.json 添加 main 进程 test script**

在 `f:\TraeProjects\1\package.json` 的 `scripts` 中添加 `test:main`：

```json
"test:main": "vitest run --config src/main/vitest.config.ts --root src/main"
```

完整 `scripts` 字段：
```json
"scripts": {
  "dev": "electron-vite dev",
  "build": "electron-vite build",
  "preview": "electron-vite preview",
  "typecheck": "tsc --build",
  "lint": "biome check .",
  "lint:fix": "biome check --write .",
  "format": "biome format --write .",
  "test": "pnpm -r --filter \"@novel-writer/*\" run test",
  "test:main": "vitest run --config src/main/vitest.config.ts --root src/main",
  "codegraph:sync": "codegraph sync",
  "prepare": "husky"
}
```

更新根 `test` script，让它同时跑 shared 和 main 的测试：

```json
"test": "pnpm -r --filter \"@novel-writer/*\" run test && pnpm test:main"
```

- [ ] **Step 6: 验证 Vitest 可启动（最小占位测试）**

临时创建 `f:\TraeProjects\1\src\main\__tests__\setup.test.ts`：

```ts
import { describe, expect, it } from 'vitest';

describe('main setup', () => {
  it('vitest works', () => {
    expect(1 + 1).toBe(2);
  });
});
```

Run: `pnpm test:main`
Expected: 1 test passed。

- [ ] **Step 7: 删除占位测试文件**

删除 `f:\TraeProjects\1\src\main\__tests__\setup.test.ts`（后续 task 会创建真实测试）。

- [ ] **Step 8: 验证 typecheck + lint + build 全绿**

Run: `pnpm typecheck && pnpm lint && pnpm build`
Expected: 0 errors 0 warnings，三入口产物生成。

- [ ] **Step 9: Commit**

```bash
git add package.json pnpm-lock.yaml src/main/vitest.config.ts src/main/tsconfig.json
git commit -m "build(deps): 引入 electron-log 5 与 sentry 5，配置 main 进程 Vitest"
```

---

## Task 2: logger（electron-log 5 封装）

**Files:**
- Create: `src/main/utils/logger.ts`
- Create: `src/main/__tests__/logger.test.ts`

参考设计文档 §7.6（日志体系）。logger 基于 electron-log 5，提供：
1. 结构化日志（支持 traceId 字段）
2. 文件日志按日轮转，保留 14 天，10MB 上限
3. 控制台仅 dev 环境
4. 全局 `unhandledRejection` / `uncaughtException` 捕获注册函数

- [ ] **Step 1: 写失败测试 — logger.test.ts**

创建 `f:\TraeProjects\1\src\main\__tests__\logger.test.ts`：

```ts
// src/main/__tests__/logger.test.ts
// logger 单元测试
// 注意：electron-log 在测试环境 mock 为内存缓冲，验证日志格式与级别
import { describe, expect, it, vi, beforeEach } from 'vitest';

// Vitest 4 的 vi.mock 会被 hoist 到文件顶部，工厂函数内不能直接引用外部 const 变量
// 必须用 vi.hoisted 导出 mock 对象，工厂函数才能引用
// 参考 https://vitest.dev/guide/mocking.html#hoisting
const { mockLog } = vi.hoisted(() => {
  const mockLog = {
    level: 'info',
    transports: {
      file: { level: 'info', maxRetries: 0, fileName: 'main.log' },
      console: { level: 'debug' },
    },
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    initialize: vi.fn(),
  };
  return { mockLog };
});

// mock electron-log，避免文件写入
vi.mock('electron-log', () => ({ default: mockLog }));

// mock electron app（用于 isPackaged 判断 + getPath）
vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: vi.fn(() => '/tmp/test-userdata') },
}));

import { logger, initLogger, registerGlobalErrorHandlers } from '../utils/logger';

describe('logger', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('暴露 info/warn/error/debug 方法', () => {
    expect(typeof logger.info).toBe('function');
    expect(typeof logger.warn).toBe('function');
    expect(typeof logger.error).toBe('function');
    expect(typeof logger.debug).toBe('function');
  });

  it('info 日志携带 traceId 字段', () => {
    initLogger();
    logger.info({ traceId: 'test-trace-123', channel: 'project:create' }, 'IPC 请求开始');
    expect(mockLog.info).toHaveBeenCalledWith(
      expect.objectContaining({
        traceId: 'test-trace-123',
        channel: 'project:create',
        message: 'IPC 请求开始',
      }),
    );
  });

  it('error 日志支持 Error 对象', () => {
    const err = new Error('测试错误');
    logger.error({ traceId: 't1' }, '操作失败', err);
    expect(mockLog.error).toHaveBeenCalled();
  });

  it('registerGlobalErrorHandlers 注册 process 事件', () => {
    const onSpy = vi.spyOn(process, 'on');
    registerGlobalErrorHandlers();
    expect(onSpy).toHaveBeenCalledWith('uncaughtException', expect.any(Function));
    expect(onSpy).toHaveBeenCalledWith('unhandledRejection', expect.any(Function));
    onSpy.mockRestore();
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm test:main`
Expected: 编译错误 `Cannot find module '../utils/logger'`。

- [ ] **Step 3: 实现 logger.ts**

创建 `f:\TraeProjects\1\src\main\utils\logger.ts`：

```ts
// src/main/utils/logger.ts
// 主进程结构化日志工具
// 基于 electron-log 5，设计文档 §7.6
// 职责：
// 1. 封装 electron-log，提供统一 logger 接口
// 2. 支持 traceId 字段贯穿同一请求的多条日志
// 3. 文件日志按日轮转（保留 14 天，10MB 上限）
// 4. 控制台仅 dev 环境
// 5. 注册全局 unhandledRejection / uncaughtException 捕获

import { app } from 'electron';
import log from 'electron-log';

/**
 * 日志上下文（结构化字段）
 *
 * traceId 贯穿渲染层 → IPC → 主进程日志 → Sentry
 * 设计文档 §4.7 traceId 贯穿 IPC
 */
export interface LogContext {
  /** 请求追踪 ID（贯穿 IPC 链路） */
  readonly traceId?: string;
  /** IPC channel 名（仅 IPC handler 日志） */
  readonly channel?: string;
  /** 业务实体 ID（如 projectId、chapterId） */
  readonly [key: string]: unknown;
}

/**
 * 初始化 logger 配置
 *
 * 设计文档 §7.6：
 * - 文件日志：按日轮转，保留 14 天，10MB 上限
 * - 控制台：仅 dev 环境
 * - 文件位置：%APPDATA%/<AppName>/logs/main.log
 *
 * 必须在 app.whenReady() 之后调用（需要 app.getPath）
 */
export function initLogger(): void {
  // 文件日志级别：生产 info，开发 debug
  log.transports.file.level = app.isPackaged ? 'info' : 'debug';
  // 控制台日志级别：仅 dev 启用
  log.transports.console.level = app.isPackaged ? false : 'debug';

  // 文件轮转配置：按日轮转，保留 14 天，单文件 10MB 上限
  log.transports.file.maxRetries = 0; // 文件写入失败不重试（避免阻塞主进程）
  log.transports.file.fileName = 'main.log';

  // 日志格式：[ISO时间] [级别] [traceId] 消息
  log.transports.file.format = '[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}] {text}';
  log.transports.console.format = '{level} {text}';

  log.initialize();
}

/**
 * 统一 logger 接口
 *
 * 使用方式：
 * - logger.info({ traceId, channel }, 'IPC 请求开始')
 * - logger.error({ traceId }, '操作失败', error)
 */
export const logger = {
  /**
   * info 级别日志（关键业务事件）
   */
  info(context: LogContext, message: string): void {
    log.info({ ...context, message });
  },

  /**
   * warn 级别日志（可重试错误、降级行为）
   */
  warn(context: LogContext, message: string): void {
    log.warn({ ...context, message });
  },

  /**
   * error 级别日志（系统错误、未捕获异常）
   *
   * @param error 可选的 Error 对象，会附加到日志
   */
  error(context: LogContext, message: string, error?: unknown): void {
    if (error !== undefined) {
      log.error({ ...context, message, error: serializeError(error) });
    } else {
      log.error({ ...context, message });
    }
  },

  /**
   * debug 级别日志（仅 dev 环境输出）
   */
  debug(context: LogContext, message: string): void {
    log.debug({ ...context, message });
  },
};

/**
 * 序列化 Error 对象为可日志的结构
 *
 * 保留 name / message / stack / cause，避免循环引用
 */
function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    const result: Record<string, unknown> = {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
    if (error.cause !== undefined) {
      result.cause = serializeError(error.cause);
    }
    return result;
  }
  return { value: String(error) };
}

/**
 * 注册全局错误捕获
 *
 * 设计文档 §7.6：unhandledRejection / uncaughtException 全局捕获
 * 必须在 app.whenReady() 之后、业务逻辑之前调用
 */
export function registerGlobalErrorHandlers(): void {
  process.on('uncaughtException', (error: Error) => {
    logger.error({}, '全局未捕获异常 uncaughtException', error);
  });

  process.on('unhandledRejection', (reason: unknown) => {
    logger.error({}, '全局未处理的 Promise 拒绝 unhandledRejection', reason);
  });
}
```

- [ ] **Step 4: 运行测试，确认全部通过**

Run: `pnpm test:main`
Expected: `logger.test.ts` 4 个测试通过。

- [ ] **Step 5: 验证 typecheck + lint**

Run: `pnpm typecheck && pnpm lint`
Expected: 0 errors 0 warnings。

注意：如 biome 报 `useNamingConvention` 错误（因 `traceId` 等字段名），在 biome.json 添加 override。

- [ ] **Step 6: Commit**

```bash
git add src/main/utils/logger.ts src/main/__tests__/logger.test.ts
git commit -m "feat(main): logger 结构化日志与全局错误捕获（§7.6）"
```

---

## Task 3: config（应用配置 + zod 校验）

**Files:**
- Create: `src/main/config/index.ts`
- Create: `src/main/__tests__/config.test.ts`

参考设计文档 §2.6（监控与运维配置）。config 从 `process.env` 读取，zod 校验，提供类型安全的 `appConfig` 单例。

dev 环境由 electron-vite 自动注入 .env 变量到 `process.env`；生产环境通过打包配置或环境变量提供。

- [ ] **Step 1: 写失败测试 — config.test.ts**

创建 `f:\TraeProjects\1\src\main\__tests__\config.test.ts`：

```ts
// src/main/__tests__/config.test.ts
// config 单元测试
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

// Vitest 4 的 vi.mock 会被 hoist 到文件顶部，工厂函数内不能直接引用外部 const 变量
// 必须用 vi.hoisted 导出 mock 对象
const { mockApp } = vi.hoisted(() => ({
  mockApp: {
    isPackaged: false,
    getPath: vi.fn((name: string) => `/tmp/test-userdata/${name}`),
  },
}));

// config 模块 import { app } from 'electron'，必须 mock 否则在 Node 环境下会失败
vi.mock('electron', () => ({ app: mockApp }));

describe('appConfig', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // 每个测试前重置 env
    process.env = { ...originalEnv };
    // 重置 mock 状态
    mockApp.isPackaged = false;
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
    mockApp.isPackaged = false;
  });

  it('使用默认值生成配置', async () => {
    // 清空相关 env 变量
    delete process.env.SENTRY_DSN;
    delete process.env.DEEPSEEK_API_BASE;
    delete process.env.OLLAMA_URL;

    const { loadConfig } = await import('../config/index');
    const config = loadConfig();

    expect(config.isDev).toBe(true); // mockApp.isPackaged=false → isDev=true
    expect(config.sentry.dsn).toBe('');
    expect(config.deepseek.apiBase).toBe('https://api.deepseek.com');
    expect(config.deepseek.model).toBe('deepseek-v4-flash');
    expect(config.ollama.url).toBe('http://localhost:11434');
    expect(config.ollama.embedModel).toBe('nemotron-3-embed-1b-bf16');
    expect(config.ollama.embedDimensions).toBe(2048);
  });

  it('从 process.env 读取配置', async () => {
    process.env.SENTRY_DSN = 'http://test@example.com/1';
    process.env.DEEPSEEK_API_BASE = 'https://custom.api.com';
    process.env.OLLAMA_URL = 'http://192.168.1.100:11434';

    const { loadConfig } = await import('../config/index');
    const config = loadConfig();

    expect(config.sentry.dsn).toBe('http://test@example.com/1');
    expect(config.deepseek.apiBase).toBe('https://custom.api.com');
    expect(config.ollama.url).toBe('http://192.168.1.100:11434');
  });

  it('isPackaged=true 时 isDev=false', async () => {
    // 模拟生产环境（修改 mock 属性即可，loadConfig 每次读取 app.isPackaged）
    mockApp.isPackaged = true;

    const { loadConfig } = await import('../config/index');
    const config = loadConfig();

    expect(config.isDev).toBe(false);
    expect(config.isPackaged).toBe(true);
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm test:main`
Expected: 编译错误 `Cannot find module '../config/index'`。

- [ ] **Step 3: 实现 config/index.ts**

创建 `f:\TraeProjects\1\src\main\config\index.ts`：

```ts
// src/main/config/index.ts
// 应用配置：从 process.env 读取，zod 校验，提供类型安全的单例
// 设计文档 §2.6 监控与运维配置
//
// dev 环境：electron-vite 自动注入 .env 变量到 process.env
// 生产环境：通过打包配置或环境变量提供
//
// 敏感数据（API Key）不存此处，由 keychain.ts 管理

import { app } from 'electron';
import { z } from 'zod';

/**
 * Sentry 配置
 */
const SentryConfigSchema = z.object({
  /** Sentry DSN（自托管 v26.6.0） */
  dsn: z.string().default(''),
  /** 事务采样率（0-1） */
  tracesSampleRate: z.number().min(0).max(1).default(0.1),
});

/**
 * DeepSeek AI 配置
 */
const DeepseekConfigSchema = z.object({
  /** API 基础 URL */
  apiBase: z.string().url().default('https://api.deepseek.com'),
  /** 默认聊天模型 */
  model: z.string().default('deepseek-v4-flash'),
  /** 请求超时（毫秒） */
  timeout: z.number().int().positive().default(60_000),
});

/**
 * Ollama 本地嵌入服务配置
 */
const OllamaConfigSchema = z.object({
  /** Ollama 服务 URL */
  url: z.string().url().default('http://localhost:11434'),
  /** 嵌入模型名 */
  embedModel: z.string().default('nemotron-3-embed-1b-bf16'),
  /** 嵌入向量维度 */
  embedDimensions: z.number().int().positive().default(2048),
  /** 健康探活间隔（毫秒） */
  healthCheckInterval: z.number().int().positive().default(30_000),
});

/**
 * 应用配置 Schema
 */
const AppConfigSchema = z.object({
  /** 是否为开发环境 */
  isDev: z.boolean(),
  /** 是否为打包后的生产环境 */
  isPackaged: z.boolean(),
  /** 日志级别 */
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  /** Sentry 配置 */
  sentry: SentryConfigSchema,
  /** DeepSeek AI 配置 */
  deepseek: DeepseekConfigSchema,
  /** Ollama 嵌入服务配置 */
  ollama: OllamaConfigSchema,
});

/** 应用配置类型（从 schema 派生） */
export type AppConfig = z.infer<typeof AppConfigSchema>;

/**
 * 从 process.env 加载并校验配置
 *
 * @returns 校验后的应用配置单例
 */
export function loadConfig(): AppConfig {
  const isPackaged = app.isPackaged;
  const isDev = !isPackaged;

  return AppConfigSchema.parse({
    isDev,
    isPackaged,
    logLevel: process.env.LOG_LEVEL ?? (isDev ? 'debug' : 'info'),
    sentry: {
      dsn: process.env.SENTRY_DSN ?? '',
      tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? 0.1),
    },
    deepseek: {
      apiBase: process.env.DEEPSEEK_API_BASE ?? 'https://api.deepseek.com',
      model: process.env.DEEPSEEK_MODEL ?? 'deepseek-v4-flash',
      timeout: Number(process.env.DEEPSEEK_TIMEOUT ?? 60_000),
    },
    ollama: {
      url: process.env.OLLAMA_URL ?? 'http://localhost:11434',
      embedModel: process.env.OLLAMA_EMBED_MODEL ?? 'nemotron-3-embed-1b-bf16',
      embedDimensions: Number(process.env.OLLAMA_EMBED_DIMENSIONS ?? 2048),
      healthCheckInterval: Number(process.env.OLLAMA_HEALTH_CHECK_INTERVAL ?? 30_000),
    },
  });
}

/**
 * 应用配置单例
 *
 * 注意：必须在 app.whenReady() 之后使用（依赖 app.isPackaged）
 */
let cachedConfig: AppConfig | null = null;

/**
 * 获取应用配置单例
 *
 * 首次调用时加载并缓存，后续调用返回缓存
 */
export function getAppConfig(): AppConfig {
  if (cachedConfig === null) {
    cachedConfig = loadConfig();
  }
  return cachedConfig;
}

/**
 * 重置配置缓存（仅测试用）
 */
export function resetConfigCache(): void {
  cachedConfig = null;
}
```

- [ ] **Step 4: 运行测试，确认全部通过**

Run: `pnpm test:main`
Expected: `config.test.ts` 3 个测试通过 + `logger.test.ts` 4 个测试通过。

- [ ] **Step 5: 验证 typecheck + lint**

Run: `pnpm typecheck && pnpm lint`
Expected: 0 errors 0 warnings。

- [ ] **Step 6: Commit**

```bash
git add src/main/config/index.ts src/main/__tests__/config.test.ts
git commit -m "feat(main): 应用配置 zod 校验与单例（§2.6）"
```

---

## Task 4: storage/app-data（路径管理）

**Files:**
- Create: `src/main/infra/storage/app-data.ts`
- Create: `src/main/__tests__/app-data.test.ts`

参考设计文档 §4.3（storage/app-data 职责）。封装 `app.getPath('userData')`，提供各子目录路径。

- [ ] **Step 1: 写失败测试 — app-data.test.ts**

创建 `f:\TraeProjects\1\src\main\__tests__\app-data.test.ts`：

```ts
// src/main/__tests__/app-data.test.ts
// app-data 路径管理单测
import { describe, expect, it, vi, beforeEach } from 'vitest';

// Vitest 4 的 vi.mock 会被 hoist，工厂函数内不能引用外部 const
// 必须用 vi.hoisted 导出 mock 函数
const { mockGetPath } = vi.hoisted(() => ({
  mockGetPath: vi.fn((name: string) => `/tmp/test-userdata/${name}`),
}));

vi.mock('electron', () => ({
  app: {
    getPath: mockGetPath,
    isPackaged: false,
  },
}));

import {
  getUserDataPath,
  getLogsPath,
  getBackupsPath,
  getCachePath,
  getKeychainPath,
} from '../infra/storage/app-data';

describe('app-data', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('getUserDataPath 返回 userData 基路径', () => {
    const path = getUserDataPath();
    expect(mockGetPath).toHaveBeenCalledWith('userData');
    expect(path).toBe('/tmp/test-userdata/userData');
  });

  it('getLogsPath 返回 logs 子目录', () => {
    const path = getLogsPath();
    expect(path).toBe('/tmp/test-userdata/userData/logs');
  });

  it('getBackupsPath 返回 backups 子目录', () => {
    const path = getBackupsPath();
    expect(path).toBe('/tmp/test-userdata/userData/backups');
  });

  it('getCachePath 返回 cache 子目录', () => {
    const path = getCachePath();
    expect(path).toBe('/tmp/test-userdata/userData/cache');
  });

  it('getKeychainPath 返回 keychain 文件路径', () => {
    const path = getKeychainPath();
    expect(path).toBe('/tmp/test-userdata/userData/keychain.dat');
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm test:main`
Expected: 编译错误 `Cannot find module '../infra/storage/app-data'`。

- [ ] **Step 3: 实现 app-data.ts**

创建 `f:\TraeProjects\1\src\main\infra\storage\app-data.ts`：

```ts
// src/main/infra/storage/app-data.ts
// 用户数据目录路径管理
// 设计文档 §4.3 storage/app-data 职责
//
// 封装 app.getPath('userData')，提供各子目录路径
// dev 环境 userData 重定向到 .electron-user-data/（在 index.ts 中设置）

import { join } from 'node:path';
import { app } from 'electron';

/**
 * 获取 userData 基路径
 *
 * 设计文档 §1.2：数据目录放 %APPDATA%/<AppName>/
 * dev 环境由 index.ts 重定向到 .electron-user-data/
 */
export function getUserDataPath(): string {
  return app.getPath('userData');
}

/**
 * 获取日志目录路径
 *
 * electron-log 文件日志输出到此目录
 */
export function getLogsPath(): string {
  return join(getUserDataPath(), 'logs');
}

/**
 * 获取数据库备份目录路径
 *
 * 设计文档 §2.6：每日备份到 %APPDATA%/App/backups/
 */
export function getBackupsPath(): string {
  return join(getUserDataPath(), 'backups');
}

/**
 * 获取缓存目录路径
 *
 * 用于临时文件、下载缓存等
 */
export function getCachePath(): string {
  return join(getUserDataPath(), 'cache');
}

/**
 * 获取 keychain（加密存储）文件路径
 *
 * safeStorage 加密后的数据存储到此文件
 * 设计文档 §1.2 决策 5：API Key 存钥匙串
 */
export function getKeychainPath(): string {
  return join(getUserDataPath(), 'keychain.dat');
}
```

- [ ] **Step 4: 运行测试，确认全部通过**

Run: `pnpm test:main`
Expected: `app-data.test.ts` 5 个测试通过。

- [ ] **Step 5: 验证 typecheck + lint**

Run: `pnpm typecheck && pnpm lint`
Expected: 0 errors 0 warnings。

- [ ] **Step 6: Commit**

```bash
git add src/main/infra/storage/app-data.ts src/main/__tests__/app-data.test.ts
git commit -m "feat(main): 用户数据目录路径管理（§4.3）"
```

---

## Task 5: storage/keychain（safeStorage 加密存储）

**Files:**
- Create: `src/main/infra/storage/keychain.ts`
- Create: `src/main/__tests__/keychain.test.ts`

参考设计文档 §1.2 决策 5（API Key 存钥匙串）。**使用 Electron 内置 `safeStorage` API 替代 keytar**（偏离设计文档 §2.2，理由见计划顶部"关键设计决策"）。

safeStorage 基于 OS 加密（Windows DPAPI / macOS Keychain / Linux libsecret），加密后的数据存储到 `keychain.dat` 文件。

- [ ] **Step 1: 写失败测试 — keychain.test.ts**

创建 `f:\TraeProjects\1\src\main\__tests__\keychain.test.ts`：

```ts
// src/main/__tests__/keychain.test.ts
// keychain 加密存储单测
import { describe, expect, it, vi, beforeEach } from 'vitest';

// Vitest 4 的 vi.mock 会被 hoist，工厂函数内不能引用外部 const
// 必须用 vi.hoisted 导出 mock 对象
const { mockSafeStorage, fsMocks } = vi.hoisted(() => {
  // safeStorage mock：模拟加密/解密
  const mockSafeStorage = {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((s: string) => Buffer.from(`encrypted:${s}`)),
    decryptString: vi.fn((b: Buffer) => {
      const str = b.toString();
      return str.startsWith('encrypted:') ? str.slice('encrypted:'.length) : '';
    }),
  };
  // node:fs promises mock：避免真实文件 IO
  // 必须用 vi.mock 整体替换 node:fs，因为 ESM import binding 不可被 spyOn 修改
  const fsMocks = {
    readFile: vi.fn(),
    writeFile: vi.fn(),
    unlink: vi.fn(),
  };
  return { mockSafeStorage, fsMocks };
});

vi.mock('electron', () => ({
  safeStorage: mockSafeStorage,
  app: { getPath: vi.fn((name: string) => `/tmp/test-userdata/${name}`) },
}));

// mock node:fs 的 promises 命名空间（keychain.ts 通过 `import { promises as fs } from 'node:fs'` 引用）
vi.mock('node:fs', () => ({
  promises: fsMocks,
}));

import {
  setSecret,
  getSecret,
  deleteSecret,
  listSecrets,
} from '../infra/storage/keychain';

describe('keychain', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // 默认：文件不存在（ENOENT）
    fsMocks.readFile.mockRejectedValue(new Error('ENOENT'));
    fsMocks.writeFile.mockResolvedValue(undefined);
    fsMocks.unlink.mockResolvedValue(undefined);
  });

  it('setSecret 加密并存储', async () => {
    await setSecret('deepseek-api-key', 'sk-test-123');
    expect(mockSafeStorage.encryptString).toHaveBeenCalledWith('sk-test-123');
    expect(fsMocks.writeFile).toHaveBeenCalled();
  });

  it('getSecret 解密返回原值', async () => {
    // 模拟已存储的加密数据
    const encrypted = Buffer.from('encrypted:sk-test-123');
    fsMocks.readFile.mockResolvedValue(
      JSON.stringify({
        'deepseek-api-key': Array.from(encrypted),
      }),
    );

    const result = await getSecret('deepseek-api-key');
    expect(result).toBe('sk-test-123');
    expect(mockSafeStorage.decryptString).toHaveBeenCalledWith(encrypted);
  });

  it('getSecret 不存在的 key 返回 null', async () => {
    fsMocks.readFile.mockResolvedValue('{}');

    const result = await getSecret('nonexistent');
    expect(result).toBeNull();
  });

  it('deleteSecret 删除指定 key', async () => {
    fsMocks.readFile.mockResolvedValue(
      JSON.stringify({
        'deepseek-api-key': [1, 2, 3],
        'other-key': [4, 5, 6],
      }),
    );

    await deleteSecret('deepseek-api-key');
    expect(fsMocks.writeFile).toHaveBeenCalled();
    // 写入的内容应该只包含 other-key
    const writeCall = vi.mocked(fsMocks.writeFile).mock.calls[0];
    const written = JSON.parse(writeCall[1] as string);
    expect(written['deepseek-api-key']).toBeUndefined();
    expect(written['other-key']).toBeDefined();
  });

  it('listSecrets 返回所有 key', async () => {
    fsMocks.readFile.mockResolvedValue(
      JSON.stringify({
        'deepseek-api-key': [1, 2, 3],
        'other-key': [4, 5, 6],
      }),
    );

    const keys = await listSecrets();
    expect(keys).toEqual(['deepseek-api-key', 'other-key']);
  });

  it('加密不可用时抛错', async () => {
    mockSafeStorage.isEncryptionAvailable.mockReturnValueOnce(false);
    await expect(setSecret('test', 'value')).rejects.toThrow();
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm test:main`
Expected: 编译错误 `Cannot find module '../infra/storage/keychain'`。

- [ ] **Step 3: 实现 keychain.ts**

创建 `f:\TraeProjects\1\src\main\infra\storage\keychain.ts`：

```ts
// src/main/infra/storage/keychain.ts
// 敏感数据加密存储（API Key 等）
// 设计文档 §1.2 决策 5：API Key 存钥匙串
//
// 使用 Electron 内置 safeStorage API（替代 keytar）：
// - 基于 OS 加密（Windows DPAPI / macOS Keychain / Linux libsecret）
// - 不需要 native rebuild，符合 Electron 官方安全建议
// - 加密后的数据存储到 keychain.dat 文件（JSON 格式）
//
// 设计文档 §2.2 列出 keytar ^7，但 safeStorage 更优：
// 1. 内置于 Electron，无需额外依赖
// 2. 不需要 native rebuild（keytar 需要）
// 3. 跨平台一致 API

import { promises as fs } from 'node:fs';
import { safeStorage } from 'electron';
import { getKeychainPath } from './app-data';

/**
 * Keychain 存储结构
 *
 * key: secret 名称（如 'deepseek-api-key'）
 * value: 加密后的 Buffer 转换为 number[]（JSON 可序列化）
 */
type KeychainStore = Record<string, number[]>;

/**
 * 读取 keychain 文件
 *
 * 文件不存在时返回空对象
 */
async function readStore(): Promise<KeychainStore> {
  const filePath = getKeychainPath();
  try {
    const content = await fs.readFile(filePath, 'utf8');
    return JSON.parse(content) as KeychainStore;
  } catch (error: unknown) {
    // 文件不存在（ENOENT）或解析失败，返回空存储
    if (error instanceof Error && error.message.includes('ENOENT')) {
      return {};
    }
    // 其他错误（如 JSON 解析失败）也返回空存储，避免阻塞应用
    return {};
  }
}

/**
 * 写入 keychain 文件
 */
async function writeStore(store: KeychainStore): Promise<void> {
  const filePath = getKeychainPath();
  const content = JSON.stringify(store, null, 2);
  await fs.writeFile(filePath, content, 'utf8');
}

/**
 * 存储加密的敏感数据
 *
 * @param key secret 名称（如 'deepseek-api-key'）
 * @param value 原始值（会被加密后存储）
 */
export async function setSecret(key: string, value: string): Promise<void> {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('safeStorage 加密不可用，无法存储敏感数据');
  }

  const encrypted = safeStorage.encryptString(value);
  const store = await readStore();
  store[key] = Array.from(encrypted);
  await writeStore(store);
}

/**
 * 读取并解密敏感数据
 *
 * @param key secret 名称
 * @returns 原始值，不存在时返回 null
 */
export async function getSecret(key: string): Promise<string | null> {
  if (!safeStorage.isEncryptionAvailable()) {
    return null;
  }

  const store = await readStore();
  const encryptedArray = store[key];
  if (encryptedArray === undefined) {
    return null;
  }

  const encrypted = Buffer.from(encryptedArray);
  return safeStorage.decryptString(encrypted);
}

/**
 * 删除指定 secret
 *
 * @param key secret 名称
 */
export async function deleteSecret(key: string): Promise<void> {
  const store = await readStore();
  if (store[key] !== undefined) {
    delete store[key];
    await writeStore(store);
  }
}

/**
 * 列出所有已存储的 secret 名称
 *
 * @returns secret key 数组
 */
export async function listSecrets(): Promise<string[]> {
  const store = await readStore();
  return Object.keys(store);
}
```

- [ ] **Step 4: 运行测试，确认全部通过**

Run: `pnpm test:main`
Expected: `keychain.test.ts` 6 个测试通过。

- [ ] **Step 5: 验证 typecheck + lint**

Run: `pnpm typecheck && pnpm lint`
Expected: 0 errors 0 warnings。

- [ ] **Step 6: Commit**

```bash
git add src/main/infra/storage/keychain.ts src/main/__tests__/keychain.test.ts
git commit -m "feat(main): safeStorage 加密存储替代 keytar（§1.2）"
```

---

## Task 6: retry util（指数退避 + 抖动）

**Files:**
- Create: `src/main/utils/retry.ts`
- Create: `src/main/__tests__/retry.test.ts`

参考设计文档 §7.5（自动重试策略）。仅对 `retryable=true` 的 AppError 重试，指数退避 + 抖动。

- [ ] **Step 1: 写失败测试 — retry.test.ts**

创建 `f:\TraeProjects\1\src\main\__tests__\retry.test.ts`：

```ts
// src/main/__tests__/retry.test.ts
// retry 工具单测
import { describe, expect, it, vi } from 'vitest';
import { retry, isRetryableError, type RetryOptions } from '../utils/retry';
import { AppError, ErrorCode } from '@novel-writer/shared';

describe('isRetryableError', () => {
  it('retryable=true 的 AppError 返回 true', () => {
    const err = new AppError(ErrorCode.AI_RATE_LIMITED);
    expect(isRetryableError(err)).toBe(true);
  });

  it('retryable=false 的 AppError 返回 false', () => {
    const err = new AppError(ErrorCode.INVALID_INPUT);
    expect(isRetryableError(err)).toBe(false);
  });

  it('非 AppError 返回 false', () => {
    const err = new Error('普通错误');
    expect(isRetryableError(err)).toBe(false);
  });
});

describe('retry', () => {
  it('成功时直接返回结果，不重试', async () => {
    const fn = vi.fn().mockResolvedValue('success');
    const result = await retry(fn, { maxAttempts: 3, baseDelay: 10 });
    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('重试后成功返回结果', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new AppError(ErrorCode.AI_RATE_LIMITED))
      .mockRejectedValueOnce(new AppError(ErrorCode.AI_TIMEOUT))
      .mockResolvedValueOnce('success');

    const result = await retry(fn, { maxAttempts: 3, baseDelay: 10 });
    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('非 retryable 错误立即抛出，不重试', async () => {
    const fn = vi.fn().mockRejectedValue(new AppError(ErrorCode.INVALID_INPUT));
    await expect(
      retry(fn, { maxAttempts: 3, baseDelay: 10 }),
    ).rejects.toThrow(AppError);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('达到最大重试次数后抛出最后一个错误', async () => {
    const fn = vi.fn().mockRejectedValue(new AppError(ErrorCode.AI_RATE_LIMITED));
    await expect(
      retry(fn, { maxAttempts: 2, baseDelay: 10 }),
    ).rejects.toThrow(AppError);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('baseDelay * 2^(attempt-1) 指数退避', async () => {
    const sleepSpy = vi.spyOn(globalThis, 'setTimeout');

    const fn = vi
      .fn()
      .mockRejectedValueOnce(new AppError(ErrorCode.AI_RATE_LIMITED))
      .mockResolvedValueOnce('success');

    await retry(fn, { maxAttempts: 2, baseDelay: 100 });

    // 第一次重试等待 baseDelay * 2^0 + 抖动 = 100 + 抖动
    expect(sleepSpy).toHaveBeenCalledTimes(1);
    const delay = sleepSpy.mock.calls[0][1];
    expect(delay).toBeGreaterThanOrEqual(100);
    expect(delay).toBeLessThan(700); // 100 + 500 抖动上限

    sleepSpy.mockRestore();
  });

  it('非 AppError 错误立即抛出', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('普通错误'));
    await expect(
      retry(fn, { maxAttempts: 3, baseDelay: 10 }),
    ).rejects.toThrow('普通错误');
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm test:main`
Expected: 编译错误 `Cannot find module '../utils/retry'`。

- [ ] **Step 3: 实现 retry.ts**

创建 `f:\TraeProjects\1\src\main\utils\retry.ts`：

```ts
// src/main/utils/retry.ts
// 指数退避重试工具
// 设计文档 §7.5 自动重试策略
//
// 仅对 retryable=true 的 AppError 重试（AI 限流、超时、PG 崩溃等）
// 指数退避 + 抖动：baseDelay * 2^(attempt-1) + random(500)
// 默认 maxAttempts: 3

import { AppError } from '@novel-writer/shared';

/**
 * 重试选项
 */
export interface RetryOptions {
  /** 最大尝试次数（含首次） */
  readonly maxAttempts: number;
  /** 基础延迟（毫秒），实际延迟 = baseDelay * 2^(attempt-1) + 抖动 */
  readonly baseDelay: number;
  /** 抖动上限（毫秒），默认 500 */
  readonly jitterMax?: number;
}

/**
 * 默认重试选项
 */
const DEFAULT_OPTIONS: RetryOptions = {
  maxAttempts: 3,
  baseDelay: 1000,
  jitterMax: 500,
};

/**
 * 判断错误是否可重试
 *
 * 仅 AppError 且 retryable=true 的错误可重试
 */
export function isRetryableError(error: unknown): boolean {
  return error instanceof AppError && error.retryable;
}

/**
 * 指数退避重试
 *
 * 设计文档 §7.5：
 * - 仅对 retryable=true 的 AppError 重试
 * - 指数退避 + 抖动：baseDelay * 2^(attempt-1) + random(jitterMax)
 * - 默认 maxAttempts: 3
 *
 * @param fn 要重试的异步函数
 * @param options 重试选项
 * @returns 函数的成功返回值
 * @throws 最后一个错误（达到最大重试次数或非 retryable 错误）
 */
export async function retry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = DEFAULT_OPTIONS,
): Promise<T> {
  const { maxAttempts, baseDelay, jitterMax = 500 } = options;

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error: unknown) {
      lastError = error;

      // 非 retryable 错误立即抛出
      if (!isRetryableError(error)) {
        throw error;
      }

      // 最后一次尝试不再等待
      if (attempt >= maxAttempts) {
        break;
      }

      // 指数退避 + 抖动
      const backoff = baseDelay * Math.pow(2, attempt - 1);
      const jitter = Math.random() * jitterMax;
      const delay = backoff + jitter;

      await sleep(delay);
    }
  }

  throw lastError;
}

/**
 * Promise 化的 setTimeout
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
```

- [ ] **Step 4: 运行测试，确认全部通过**

Run: `pnpm test:main`
Expected: `retry.test.ts` 6 个测试通过。

注意：`retry` 的指数退避测试可能因 setTimeout mock 方式不同而失败。如果失败，调整测试为验证 `fn` 调用次数而非 setTimeout 参数。

- [ ] **Step 5: 验证 typecheck + lint**

Run: `pnpm typecheck && pnpm lint`
Expected: 0 errors 0 warnings。

- [ ] **Step 6: Commit**

```bash
git add src/main/utils/retry.ts src/main/__tests__/retry.test.ts
git commit -m "feat(main): 指数退避重试工具（§7.5）"
```

---

## Task 7: wrap（IPC handler 包装器）

**Files:**
- Create: `src/main/utils/wrap.ts`
- Create: `src/main/__tests__/wrap.test.ts`

参考设计文档 §4.7（IPC sender 校验 + traceId 贯穿）、§7.4（错误处理流程）。

wrap 是 IPC handler 的统一包装器，职责：
1. sender 校验（防止跨窗口越权）
2. 自动生成 / 接收 traceId（贯穿渲染层 → IPC → 主进程日志 → Sentry）
3. zod schema 校验
4. try/catch + 错误分类 + Sentry 上报
5. 返回统一结构 `{ data } | { error }`

- [ ] **Step 1: 写失败测试 — wrap.test.ts**

创建 `f:\TraeProjects\1\src\main\__tests__\wrap.test.ts`：

```ts
// src/main/__tests__/wrap.test.ts
// wrap IPC handler 包装器单测
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { z } from 'zod';

// Vitest 4 的 vi.mock 会被 hoist，工厂函数内不能引用外部 const
// 必须用 vi.hoisted 导出 mock 对象
const { mockFromWebContents, mockIpcMainHandle } = vi.hoisted(() => ({
  mockFromWebContents: vi.fn(),
  mockIpcMainHandle: vi.fn(),
}));

// mock @sentry/electron/main
vi.mock('@sentry/electron/main', () => ({
  captureException: vi.fn(),
}));

// mock electron
vi.mock('electron', () => ({
  ipcMain: {
    handle: mockIpcMainHandle,
  },
  BrowserWindow: {
    fromWebContents: mockFromWebContents,
  },
}));

// mock logger（避免触发真实 electron-log 初始化）
vi.mock('../utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { wrap } from '../utils/wrap';
import { AppError, ErrorCode } from '@novel-writer/shared';
import { ipcMain, BrowserWindow } from 'electron';
import * as Sentry from '@sentry/electron/main';

describe('wrap', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('成功时返回 { data }', async () => {
    const mockWin = { id: 1 };
    mockFromWebContents.mockReturnValue(mockWin);

    const schema = z.object({ name: z.string() });
    const handler = vi.fn().mockResolvedValue({ id: 1, name: 'test' });

    wrap('test:channel', schema, handler);

    // 获取 ipcMain.handle 注册的回调
    const registeredHandler = vi.mocked(ipcMain.handle).mock.calls[0][1];

    // 模拟 IPC 调用
    const mockEvent = { sender: {} };
    const result = await registeredHandler?.(mockEvent, { name: 'test' }, 'trace-123');

    expect(result).toEqual({ data: { id: 1, name: 'test' } });
    expect(handler).toHaveBeenCalledWith({ name: 'test' }, expect.objectContaining({ traceId: 'trace-123' }));
  });

  it('参数校验失败返回 { error }', async () => {
    const mockWin = { id: 1 };
    mockFromWebContents.mockReturnValue(mockWin);

    const schema = z.object({ name: z.string().min(1) });
    const handler = vi.fn();

    wrap('test:channel', schema, handler);

    const registeredHandler = vi.mocked(ipcMain.handle).mock.calls[0][1];
    const mockEvent = { sender: {} };
    const result = await registeredHandler?.(mockEvent, { name: '' }, 'trace-456');

    expect(result).toHaveProperty('error');
    expect(result.error).toHaveProperty('code');
    expect(result.error).toHaveProperty('message');
    expect(handler).not.toHaveBeenCalled();
  });

  it('sender 无效返回 { error }', async () => {
    mockFromWebContents.mockReturnValue(null);

    const schema = z.object({ name: z.string() });
    const handler = vi.fn();

    wrap('test:channel', schema, handler);

    const registeredHandler = vi.mocked(ipcMain.handle).mock.calls[0][1];
    const mockEvent = { sender: {} };
    const result = await registeredHandler?.(mockEvent, { name: 'test' }, undefined);

    expect(result).toHaveProperty('error');
    expect(result.error.code).toBe(ErrorCode.IPC_SENDER_INVALID);
    expect(handler).not.toHaveBeenCalled();
  });

  it('handler 抛出 AppError 返回 { error }', async () => {
    const mockWin = { id: 1 };
    mockFromWebContents.mockReturnValue(mockWin);

    const schema = z.object({ name: z.string() });
    const handler = vi.fn().mockRejectedValue(
      new AppError(ErrorCode.PROJECT_NOT_FOUND),
    );

    wrap('test:channel', schema, handler);

    const registeredHandler = vi.mocked(ipcMain.handle).mock.calls[0][1];
    const mockEvent = { sender: {} };
    const result = await registeredHandler?.(mockEvent, { name: 'test' }, undefined);

    expect(result).toHaveProperty('error');
    expect(result.error.code).toBe(ErrorCode.PROJECT_NOT_FOUND);
    expect(Sentry.captureException).toHaveBeenCalled();
  });

  it('handler 抛出普通 Error 包装为 INTERNAL_ERROR', async () => {
    const mockWin = { id: 1 };
    mockFromWebContents.mockReturnValue(mockWin);

    const schema = z.object({ name: z.string() });
    const handler = vi.fn().mockRejectedValue(new Error('普通错误'));

    wrap('test:channel', schema, handler);

    const registeredHandler = vi.mocked(ipcMain.handle).mock.calls[0][1];
    const mockEvent = { sender: {} };
    const result = await registeredHandler?.(mockEvent, { name: 'test' }, undefined);

    expect(result).toHaveProperty('error');
    expect(result.error.code).toBe(ErrorCode.INTERNAL_ERROR);
    expect(Sentry.captureException).toHaveBeenCalled();
  });

  it('无 traceId 时自动生成', async () => {
    const mockWin = { id: 1 };
    mockFromWebContents.mockReturnValue(mockWin);

    const schema = z.object({ name: z.string() });
    const handler = vi.fn().mockResolvedValue('ok');

    wrap('test:channel', schema, handler);

    const registeredHandler = vi.mocked(ipcMain.handle).mock.calls[0][1];
    const mockEvent = { sender: {} };
    await registeredHandler?.(mockEvent, { name: 'test' }, undefined);

    // handler 的第二参数 ctx 应包含 traceId
    const ctx = handler.mock.calls[0][1];
    expect(ctx.traceId).toBeDefined();
    expect(typeof ctx.traceId).toBe('string');
    expect(ctx.traceId.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm test:main`
Expected: 编译错误 `Cannot find module '../utils/wrap'`。

- [ ] **Step 3: 实现 wrap.ts**

创建 `f:\TraeProjects\1\src\main\utils\wrap.ts`：

```ts
// src/main/utils/wrap.ts
// IPC handler 统一包装器
// 设计文档 §4.7（IPC sender 校验 + traceId 贯穿）、§7.4（错误处理流程）
//
// 职责：
// 1. sender 校验（防止跨窗口越权，Electron Security #17）
// 2. 自动生成 / 接收 traceId（贯穿渲染层 → IPC → 主进程日志 → Sentry）
// 3. zod schema 校验
// 4. try/catch + 错误分类 + Sentry 上报
// 5. 返回统一结构 { data } | { error }

import { randomUUID } from 'node:crypto';
import { BrowserWindow, ipcMain, type WebContents } from 'electron';
import * as Sentry from '@sentry/electron/main';
import {
  AppError,
  ErrorCode,
  type IpcError,
  type IpcResponse,
} from '@novel-writer/shared';
import type { ZodType } from 'zod';
import { logger } from './logger';

/**
 * IPC handler 上下文（main 进程专用）
 *
 * 注意：与 @novel-writer/shared 的 IpcContext 不同
 * - shared.IpcContext.sender 是 unknown（preload 注入用，渲染层访问）
 * - IpcHandlerContext.sender 是 WebContents（main 进程专用，可调用 webContents API）
 *
 * traceId 贯穿渲染层 → IPC → 主进程日志 → Sentry
 */
export interface IpcHandlerContext {
  /** 请求追踪 ID */
  readonly traceId: string;
  /** 发送方 WebContents（用于回推事件） */
  readonly sender: WebContents;
}

/**
 * 注册 IPC handler（带统一包装）
 *
 * @param channel IPC channel 名（从 IPC_CHANNELS 常量获取）
 * @param schema 入参的 zod schema（null 表示无入参）
 * @param handler 业务处理函数
 */
export function wrap<TInput, TOutput>(
  channel: string,
  schema: ZodType<TInput> | null,
  handler: (input: TInput, ctx: IpcHandlerContext) => Promise<TOutput>,
): void {
  ipcMain.handle(channel, async (evt, input: unknown, incomingTraceId?: string) => {
    // 1. traceId 生成或复用（渲染层可显式传入）
    const traceId = incomingTraceId ?? randomUUID();
    const ctx: IpcHandlerContext = { traceId, sender: evt.sender };

    // 2. sender 校验（Electron Security #17）
    const win = BrowserWindow.fromWebContents(evt.sender);
    if (win === null) {
      logger.error({ traceId, channel }, 'IPC sender 无效');
      const error = new AppError(ErrorCode.IPC_SENDER_INVALID).toIpcError();
      return { error } satisfies IpcResponse<TOutput>;
    }

    // 3. zod 校验（schema 为 null 时跳过，表示无入参）
    let parsedInput: TInput;
    if (schema !== null) {
      const parsed = schema.safeParse(input);
      if (!parsed.success) {
        logger.warn(
          { traceId, channel, issues: parsed.error.issues },
          'IPC 参数校验失败',
        );
        const error = new AppError(
          ErrorCode.INVALID_INPUT,
          undefined,
          parsed.error,
          { issues: parsed.error.issues },
        ).toIpcError();
        return { error } satisfies IpcResponse<TOutput>;
      }
      parsedInput = parsed.data;
    } else {
      // schema 为 null，input 必须为 undefined
      parsedInput = undefined as TInput;
    }

    // 4. 执行 handler，所有日志自动携带 traceId
    try {
      logger.info({ traceId, channel }, 'IPC 请求开始');
      const data = await handler(parsedInput, ctx);
      logger.info({ traceId, channel }, 'IPC 请求成功');
      return { data } satisfies IpcResponse<TOutput>;
    } catch (error: unknown) {
      // 错误分类 + Sentry 上报
      const ipcError = toIpcError(error);
      logger.error({ traceId, channel }, 'IPC 请求失败', error);
      Sentry.captureException(error, { tags: { channel, traceId } });
      return { error: ipcError } satisfies IpcResponse<TOutput>;
    }
  });
}

/**
 * 将任意错误转换为 IpcError
 *
 * - AppError：直接调用 toIpcError()
 * - 其他 Error：包装为 INTERNAL_ERROR
 */
function toIpcError(error: unknown): IpcError {
  if (error instanceof AppError) {
    return error.toIpcError();
  }
  // 非 AppError 包装为内部错误
  const wrapped = new AppError(
    ErrorCode.INTERNAL_ERROR,
    undefined,
    error,
  );
  return wrapped.toIpcError();
}
```

- [ ] **Step 4: 运行测试，确认全部通过**

Run: `pnpm test:main`
Expected: `wrap.test.ts` 6 个测试通过。

如果测试失败，检查：
- vi.mock 的路径是否正确（相对路径 vs 模块名）
- `satisfies` 操作符是否被 TypeScript 6 支持（应该支持）
- `BrowserWindow.fromWebContents` 返回 `null` vs `undefined`

- [ ] **Step 5: 验证 typecheck + lint**

Run: `pnpm typecheck && pnpm lint`
Expected: 0 errors 0 warnings。

- [ ] **Step 6: Commit**

```bash
git add src/main/utils/wrap.ts src/main/__tests__/wrap.test.ts
git commit -m "feat(main): IPC handler 统一包装器（§4.7 + §7.4）"
```

---

## Task 8: Sentry 集成 + index.ts 更新 + 最终验证

**Files:**
- Modify: `src/main/index.ts`（集成 Sentry init + logger 初始化 + 全局错误捕获）

参考设计文档 §7.7（Sentry 集成）。

- [ ] **Step 1: 修改 src/main/index.ts，集成 Sentry + logger + 全局错误捕获**

修改 `f:\TraeProjects\1\src\main\index.ts`，完整新内容：

```ts
// src/main/index.ts
// Electron 主进程入口
// 职责：创建 BrowserWindow、加载渲染层、配置安全基线
// 设计文档 §1.1 进程拓扑 / §4.5 安全配置 / §7.6 日志 / §7.7 Sentry

import { join } from 'node:path';
import { app, BrowserWindow, shell } from 'electron';
import * as Sentry from '@sentry/electron/main';
import { getAppConfig } from './config';
import { initLogger, registerGlobalErrorHandlers, logger } from './utils/logger';

// __dirname / __filename 由 electron-vite 6.x 在构建时自动注入
// （基于 import.meta.dirname / import.meta.filename，Node 24 原生支持）
// 详见 https://electron-vite.org/guide/dev#limitations-of-sandboxing

// dev 环境把 userData 重定向到项目内目录，避免 TRAE 沙箱拦截系统 %APPDATA% 写入
// 生产环境（app.isPackaged === true）保持系统默认 %APPDATA%/<AppName>，符合用户数据规范
if (!app.isPackaged) {
  app.setPath('userData', join(__dirname, '../../.electron-user-data'));
}

/**
 * 初始化 Sentry
 *
 * 设计文档 §7.7：
 * - 自托管 Sentry v26.6.0
 * - DSN 从 config 读取（环境变量 SENTRY_DSN）
 * - 生产环境采样 10% 事务，dev 不采样
 * - beforeSend 脱敏：移除 Authorization header
 *
 * 必须在 app.whenReady() 之前调用
 */
function initSentry(): void {
  const config = getAppConfig();
  if (config.sentry.dsn === '') {
    // DSN 未配置时跳过初始化（dev 环境常见）
    logger.warn({}, 'Sentry DSN 未配置，跳过初始化');
    return;
  }

  Sentry.init({
    dsn: config.sentry.dsn,
    release: `novel-writer@${app.getVersion()}`,
    environment: config.isPackaged ? 'production' : 'development',
    tracesSampleRate: config.sentry.tracesSampleRate,
    sendDefaultPii: false,
    beforeSend(event: Sentry.Event): Sentry.Event | null {
      // 脱敏：移除可能的 API Key / Authorization header
      if (event.request?.headers?.authorization) {
        delete event.request.headers.authorization;
      }
      return event;
    },
  });
}

/**
 * 创建主窗口
 * 安全配置遵循 Electron Security 官方推荐：
 * - contextIsolation: true（XSS → RCE 防护）
 * - nodeIntegration: false
 * - sandbox: true（渲染层沙箱）
 */
function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      // preload 输出为 .cjs（CJS 格式）：sandbox: true 要求 preload 必须是 CommonJS
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  // 限制导航（Security #13）：只允许应用内导航
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('http://localhost') && !url.startsWith('app://')) {
      event.preventDefault();
    }
  });

  // 限制新窗口（Security #14）：外链走系统浏览器
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  // 开发环境加载 dev server，生产环境加载构建产物
  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'));
  }

  win.once('ready-to-show', () => {
    win.show();
  });

  return win;
}

// Sentry 必须在 app.whenReady() 之前初始化（@sentry/electron 要求）
initSentry();

// 应用就绪后初始化 logger + 全局错误捕获 + 创建窗口
app.whenReady().then(() => {
  // 初始化 logger（需要 app.getPath，必须在 whenReady 之后）
  initLogger();
  registerGlobalErrorHandlers();
  logger.info({}, '应用启动');

  createWindow();

  // macOS: 点击 dock 图标时若无窗口则重建
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

// 所有窗口关闭时退出（macOS 除外）
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
```

- [ ] **Step 2: 验证全部测试通过**

Run: `pnpm test`
Expected: 全部测试通过（shared 7 文件 44 测试 + main 6 文件 28 测试，共 72 测试）。

- [ ] **Step 3: 验证 typecheck + lint + build**

Run: `pnpm typecheck && pnpm lint && pnpm build`
Expected: 0 errors 0 warnings，三入口产物生成。

- [ ] **Step 4: 验证 dev 仍可启动**

Run: `pnpm dev`（后台启动 8 秒后检查，然后停止）
Expected: Electron 窗口正常弹出，无报错。

注意：
- Sentry DSN 未配置时会输出 warn 日志 "Sentry DSN 未配置，跳过初始化"，这是正常的
- logger 初始化后会在 `.electron-user-data/logs/main.log` 写入日志

- [ ] **Step 5: 最终验证（综合）**

Run: `pnpm typecheck && pnpm lint && pnpm build && pnpm test`
Expected: 全部 0 errors 0 warnings，全部测试通过。

- [ ] **Step 6: Commit**

```bash
git add src/main/index.ts
git commit -m "feat(main): 集成 Sentry 与 logger 初始化（§7.6-7.7）"
```

---

## Phase 3a 完成验收清单

- [ ] `pnpm install` 无错误无警告
- [ ] `pnpm typecheck` 0 errors 0 warnings
- [ ] `pnpm lint` 0 errors 0 warnings
- [ ] `pnpm build` 三入口产物全部生成（不破坏 Phase 1）
- [ ] `pnpm dev` Electron 窗口正常弹出
- [ ] `pnpm test` 全部测试通过（shared 44 + main ≥28，共 ≥72 测试）
- [ ] `logger` 支持 traceId 字段贯穿
- [ ] `config` 从 process.env 读取 + zod 校验 + 默认值
- [ ] `app-data` 提供 getUserDataPath / getLogsPath / getBackupsPath / getCachePath / getKeychainPath
- [ ] `keychain` 使用 safeStorage 加密存储（替代 keytar）
- [ ] `retry` 仅对 retryable=true 的 AppError 重试，指数退避 + 抖动
- [ ] `wrap` 集成 sender 校验 + traceId + zod 校验 + Sentry 上报 + 返回 `{ data } | { error }`
- [ ] `index.ts` 集成 Sentry init + logger 初始化 + 全局错误捕获
- [ ] git log 至少 7 个 Phase 3a commit
- [ ] 设计文档 §10.3 开发规范仍全部落实

---

## 后续 Phase 预告

- **Phase 3b**: 进程管理与 AI 客户端（pg-controller / ollama-controller / openai-client / embedding-client / stream-bridge）
- **Phase 4**: 数据库 schema + migrations + Prisma client + AGE + HNSW
- **Phase 5**: Service 层（9 个 service，消费 @novel-writer/shared 的类型与 schema）
