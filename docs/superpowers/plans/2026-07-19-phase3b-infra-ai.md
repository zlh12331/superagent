# Phase 3b: 进程管理与 AI 客户端 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 PostgreSQL 子进程生命周期管理、Ollama 子进程管理 + 模型拉取、OpenAI 5 SDK 客户端单例（DeepSeek 聊天）、本地 Ollama 嵌入客户端、流式响应桥接（含 AbortController）。这些是 Phase 4 数据库 schema 与 Phase 5 Service 层的依赖基础。

**Architecture:** 5 个独立的 infra 模块，全部位于 `src/main/infra/` 下。pg-controller 与 ollama-controller 通过 `child_process.spawn` 管理外部进程，提供 start/stop/health 探活 API；openai-client 与 embedding-client 复用 openai 5 SDK（前者指向 DeepSeek 云端，后者指向本地 Ollama OpenAI 兼容协议）；stream-bridge 通过 AbortController 管理流式响应生命周期，逐 chunk 推送给渲染层。所有模块遵循 §4.4 禁止依赖方向：infra 不调用 service。

**Tech Stack:** Electron 40（child_process / BrowserWindow.webContents）、Node 24（fetch API 原生）、openai 5 SDK、@sentry/electron 5、zod 4、Vitest 4（vi.hoisted + vi.mock('node:child_process') + vi.mock('node:net')）、TypeScript 6.0。

**Spec Reference:**
- 设计文档 §1.1 进程拓扑（PG 子进程 + Ollama 子进程）
- 设计文档 §1.2 决策 3（嵌入式 PG 便携版）
- 设计文档 §4.3 Infra 层职责矩阵
- 设计文档 §5.5 流式响应中断设计
- 设计文档 §6.6 Ollama 本地嵌入服务配置
- 设计文档 §7.8 PG 子进程健康监控
- 设计文档 §7.9 Ollama 嵌入服务健康监控

**关键设计决策（偏离设计文档，需在执行时同步更新设计文档）：**
1. **PG 端口固定为 5433**：避免与系统已安装的 PostgreSQL 默认端口 5432 冲突。DATABASE_URL 在 config 中固定为 `postgresql://novel_writer:dev_password@localhost:5433/novel_writer`（dev 环境）。
2. **pg-installer 拆分到 Phase 4**：设计文档 §4.3 中 `pg-installer`（initdb + 扩展加载）依赖 Prisma schema 与 migrations，放到 Phase 4 与数据库初始化一起做。Phase 3b 仅实现 `pg-controller`（启动/停止/探活已有的 PG 二进制）。
3. **进程状态通过 EventEmitter 解耦**：pg-controller 与 ollama-controller 不直接调用 `mainWindow.webContents.send`，而是继承 `EventEmitter` 发射 `status-change` 事件。这样 controller 可独立测试，IPC 事件转发由后续 Phase 6 IPC handlers 完成。
4. **Ollama 不通过 child_process 启动**（条件性）：若用户机器已运行 Ollama（系统托盘），controller 直接复用；否则才 spawn `ollama serve`。通过 `GET /api/tags` 探活区分两种情况。
5. **PostgreSQL 二进制路径**：Phase 3b 假设 PG 二进制位于 `resources/pg/bin/`（dev 环境用系统 PATH 中的 `postgres` 兜底）。Phase 4 的 pg-installer 会处理二进制下载与解压。
6. **stream-bridge 与 openai-client 解耦**：stream-bridge 不依赖 openai-client，接收任意 `AsyncIterable<chunk>` 抽象，便于测试用内存 stream 替代。

---

## 文件结构总览

执行完成后 `src/main/infra/` 目录形态（**仅列出本 Phase 新建/修改文件**）：

```
src/main/
├── infra/
│   ├── pg/
│   │   ├── pg-controller.ts          # Create: PG 子进程生命周期 + 健康探活
│   │   └── pg-types.ts                # Create: PG 状态枚举 + 配置类型
│   ├── ai/
│   │   ├── ollama-controller.ts       # Create: Ollama 子进程生命周期 + 模型拉取
│   │   ├── openai-client.ts           # Create: OpenAI 5 SDK 客户端单例（DeepSeek）
│   │   ├── embedding-client.ts       # Create: 本地 Ollama 嵌入客户端（OpenAI 兼容）
│   │   └── stream-bridge.ts          # Create: 流式响应 → IPC 事件桥接
│   └── storage/                       # 已存在（Phase 3a）
├── __tests__/
│   ├── pg-controller.test.ts          # Create: pg-controller 单测
│   ├── ollama-controller.test.ts      # Create: ollama-controller 单测
│   ├── openai-client.test.ts          # Create: openai-client 单测
│   ├── embedding-client.test.ts       # Create: embedding-client 单测
│   └── stream-bridge.test.ts          # Create: stream-bridge 单测
└── config/
    └── index.ts                       # 已存在（Phase 3a 已包含 deepseek/ollama 配置块）
```

**职责划分：**
- `infra/pg/pg-controller.ts`：`PgController` 类，封装 `child_process.spawn('postgres', ...)`，提供 `start() / stop() / isHealthy() / onStatusChange()` API。继承 `EventEmitter`。
- `infra/pg/pg-types.ts`：`PgStatus` 枚举 + `PgConfig` 接口（端口/数据目录/二进制路径）
- `infra/ai/ollama-controller.ts`：`OllamaController` 类，封装 Ollama 进程管理 + 健康探活 + 模型拉取。继承 `EventEmitter`。
- `infra/ai/openai-client.ts`：`getOpenAIClient()` 单例工厂，DeepSeek 聊天用，apiKey 从 keychain 读取。
- `infra/ai/embedding-client.ts`：`getEmbeddingClient()` 单例工厂，指向本地 Ollama（OpenAI 兼容协议）。
- `infra/ai/stream-bridge.ts`：`StreamBridge` 类，管理 `Map<sessionId, AbortController>`，`streamToWebContents()` 迭代 stream 并 `webContents.send`，`abort(sessionId)` 中断。

**依赖方向（严格遵守 §4.4）：**
- `infra/pg/*` 依赖 Electron `app` + `node:child_process` + `node:net` + `@novel-writer/shared`（AppError/ErrorCode）
- `infra/ai/ollama-controller.ts` 依赖 `node:child_process` + 全局 `fetch` + `@novel-writer/shared` + `config`
- `infra/ai/openai-client.ts` 依赖 `openai` 5 SDK + `infra/storage/keychain` + `config`
- `infra/ai/embedding-client.ts` 依赖 `openai` 5 SDK + `config`
- `infra/ai/stream-bridge.ts` 依赖 `@novel-writer/shared`（IPC_CHANNELS）+ `electron`（BrowserWindow.webContents）
- 所有模块不依赖 service 层，不被 service 直接调用（service 通过工厂函数获取实例）

---

## Task 1: pg-controller（PostgreSQL 子进程生命周期）

**Files:**
- Create: `src/main/infra/pg/pg-types.ts`
- Create: `src/main/infra/pg/pg-controller.ts`
- Create: `src/main/__tests__/pg-controller.test.ts`

参考设计文档 §1.1（PG 子进程）、§1.2 决策 3（便携版 PG）、§7.8（健康监控）。

`PgController` 封装 `child_process.spawn('postgres', ['-D', dataDir, '-p', '5433'])`，提供：
1. `start()`：spawn postgres 进程，等待端口 5433 可连接
2. `stop()`：SIGTERM → 等 5s → SIGKILL 兜底
3. `isHealthy()`：用 `node:net` 创建 TCP 连接到 5433 探活
4. `on(event, listener)`：继承 EventEmitter，发射 `status-change` 事件

- [ ] **Step 1: 写失败测试 — pg-controller.test.ts**

创建 `f:\TraeProjects\1\src\main\__tests__\pg-controller.test.ts`：

```ts
// src/main/__tests__/pg-controller.test.ts
// pg-controller 单元测试
// 注意：node:child_process 与 node:net 都用 vi.mock 替换，避免真实进程与端口占用
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// Vitest 4 vi.mock 会被 hoist，必须用 vi.hoisted 导出 mock 对象
const { mockSpawn, mockChildProcess, mockNet } = vi.hoisted(() => {
  // 模拟 child process 实例
  const mockChildProcess = {
    pid: 12345,
    killed: false,
    kill: vi.fn((signal?: string) => {
      mockChildProcess.killed = true;
      // 模拟 exit 事件
      setTimeout(() => {
        mockChildProcess.listeners?.exit?.(0, null);
      }, 10);
      return true;
    }),
    on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      // 保存 listener 以便测试触发
      if (!mockChildProcess.listeners) {
        mockChildProcess.listeners = {};
      }
      mockChildProcess.listeners[event] = listener;
    }),
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    listeners: {} as Record<string, (...args: unknown[]) => void>,
  };

  const mockSpawn = vi.fn(() => mockChildProcess);

  // 模拟 net.connect（TCP 端口探活）
  const mockSocket = {
    on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      if (event === 'connect') {
        // 默认立即连接成功
        setTimeout(() => listener(), 1);
      }
      if (event === 'error') {
        // 保存 error listener 以便测试触发
        mockSocket.errorListener = listener;
      }
    }),
    destroy: vi.fn(),
    errorListener: null as ((err: Error) => void) | null,
  };
  const mockNet = {
    connect: vi.fn(() => mockSocket),
  };

  return { mockSpawn, mockChildProcess, mockNet, mockSocket };
});

vi.mock('node:child_process', () => ({ spawn: mockSpawn }));
vi.mock('node:net', () => ({ createConnection: mockNet.connect }));

import { PgController } from '../infra/pg/pg-controller';
import { ErrorCode } from '@novel-writer/shared';

describe('PgController', () => {
  let controller: PgController;

  beforeEach(() => {
    vi.clearAllMocks();
    // 重置 mock 状态
    mockChildProcess.killed = false;
    mockChildProcess.listeners = {};
    mockSocket.errorListener = null;
    controller = new PgController({
      binaryPath: '/usr/bin/postgres',
      dataDir: '/tmp/pgdata',
      port: 5433,
    });
  });

  afterEach(() => {
    controller.removeAllListeners();
  });

  it('start() 启动 PG 进程并发射 running 状态', async () => {
    const statusListener = vi.fn();
    controller.on('status-change', statusListener);

    await controller.start();

    expect(mockSpawn).toHaveBeenCalledWith(
      '/usr/bin/postgres',
      ['-D', '/tmp/pgdata', '-p', '5433'],
      expect.objectContaining({ stdio: expect.anything() }),
    );
    // 等待 TCP 探活成功后状态变为 running
    expect(statusListener).toHaveBeenCalledWith({ status: 'running', pid: 12345 });
  });

  it('start() 在端口探活失败时抛 PG_START_FAILED', async () => {
    // 模拟端口连接失败
    mockSocket.on = vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      if (event === 'error') {
        setTimeout(() => listener(new Error('ECONNREFUSED')), 1);
      }
    });

    await expect(controller.start()).rejects.toThrow();
    // 验证进程被 kill
    expect(mockChildProcess.kill).toHaveBeenCalled();
  });

  it('stop() 发送 SIGTERM 并等待 exit', async () => {
    await controller.start();
    await controller.stop();

    expect(mockChildProcess.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('stop() 在 5 秒后强制 SIGKILL', async () => {
    // 模拟进程不响应 SIGTERM（不触发 exit 事件）
    mockChildProcess.kill = vi.fn((signal?: string) => {
      if (signal === 'SIGTERM') {
        // 不触发 exit 事件，等超时
        return true;
      }
      mockChildProcess.killed = true;
      return true;
    });

    await controller.start();
    // 使用 fake timers 加速超时
    vi.useFakeTimers();
    const stopPromise = controller.stop();
    // 推进 6 秒
    vi.advanceTimersByTime(6000);
    await stopPromise;
    vi.useRealTimers();

    expect(mockChildProcess.kill).toHaveBeenCalledWith('SIGTERM');
    expect(mockChildProcess.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('进程意外退出时发射 crashed 状态', async () => {
    const statusListener = vi.fn();
    controller.on('status-change', statusListener);

    await controller.start();
    // 模拟进程崩溃（触发 exit 事件非 0 退出码）
    mockChildProcess.listeners.exit?.(1, null);

    expect(statusListener).toHaveBeenCalledWith({ status: 'crashed', code: 1 });
  });

  it('isHealthy() 返回端口探活结果', async () => {
    await controller.start();
    const healthy = await controller.isHealthy();
    expect(healthy).toBe(true);
    expect(mockNet.connect).toHaveBeenCalledWith({ host: 'localhost', port: 5433 });
  });

  it('isHealthy() 端口不可达时返回 false', async () => {
    mockSocket.on = vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      if (event === 'error') {
        setTimeout(() => listener(new Error('ECONNREFUSED')), 1);
      }
    });

    const healthy = await controller.isHealthy();
    expect(healthy).toBe(false);
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm test:main`
Expected: 编译错误 `Cannot find module '../infra/pg/pg-controller'`。

- [ ] **Step 3: 实现 pg-types.ts**

创建 `f:\TraeProjects\1\src\main\infra\pg\pg-types.ts`：

```ts
// src/main/infra/pg/pg-types.ts
// PostgreSQL 子进程类型定义
// 设计文档 §1.2 决策 3 + §7.8 健康监控

/**
 * PG 进程状态
 *
 * - stopped：未启动或已停止
 * - starting：spawn 后等待端口就绪
 * - running：端口探活成功，可接收连接
 * - crashed：进程意外退出（非 0 退出码）
 * - stopping：收到 stop 请求，等待 exit
 */
export type PgStatus =
  | 'stopped'
  | 'starting'
  | 'running'
  | 'crashed'
  | 'stopping';

/**
 * PG 控制器配置
 *
 * dev 环境：binaryPath 用系统 PATH 中的 'postgres'
 * 生产环境：binaryPath 指向 resources/pg/bin/postgres.exe
 */
export interface PgConfig {
  /** postgres 可执行文件路径（dev: 'postgres'，prod: 绝对路径） */
  readonly binaryPath: string;
  /** 数据目录（%APPDATA%/<AppName>/pgdata/） */
  readonly dataDir: string;
  /** 监听端口（固定 5433，避免与系统 PG 冲突） */
  readonly port: number;
}

/**
 * 状态变更事件 payload
 */
export interface PgStatusChangeEvent {
  readonly status: PgStatus;
  readonly pid?: number;
  readonly code?: number;
}
```

- [ ] **Step 4: 实现 pg-controller.ts**

创建 `f:\TraeProjects\1\src\main\infra\pg\pg-controller.ts`：

```ts
// src/main/infra/pg/pg-controller.ts
// PostgreSQL 子进程生命周期管理
// 设计文档 §1.1 进程拓扑 + §7.8 PG 子进程健康监控
//
// 职责：
// 1. spawn postgres 子进程（-D dataDir -p port）
// 2. 等待 TCP 端口可连接（start 阶段）
// 3. 健康探活（isHealthy）
// 4. 优雅停止（SIGTERM → 5s → SIGKILL 兜底）
// 5. 进程意外退出时发射 crashed 事件
//
// 注意：不依赖 Electron app（便于测试），dataDir 由调用方传入
// pg-installer（initdb）在 Phase 4 实现，本 controller 只负责启动已有 PG 实例

import { spawn, type ChildProcess } from 'node:child_process';
import { createConnection, type Socket } from 'node:net';
import { EventEmitter } from 'node:events';
import { AppError, ErrorCode } from '@novel-writer/shared';
import { logger } from '../../utils/logger';
import type { PgConfig, PgStatus, PgStatusChangeEvent } from './pg-types';

/**
 * PG 停止超时（毫秒）
 *
 * SIGTERM 后等 5 秒，未退出则 SIGKILL
 */
const STOP_TIMEOUT_MS = 5000;

/**
 * 启动时端口探活最大重试次数
 *
 * postgres 启动需要时间（加载扩展、恢复 WAL），轮询端口
 */
const START_MAX_RETRIES = 30;

/**
 * 启动时端口探活间隔（毫秒）
 */
const START_RETRY_INTERVAL_MS = 1000;

/**
 * PostgreSQL 子进程控制器
 *
 * 继承 EventEmitter，发射 'status-change' 事件
 *
 * @example
 * ```ts
 * const controller = new PgController({
 *   binaryPath: 'postgres',
 *   dataDir: '/path/to/pgdata',
 *   port: 5433,
 * });
 * controller.on('status-change', (e) => {
 *   logger.info({ status: e.status }, 'PG 状态变更');
 * });
 * await controller.start();
 * // ... 使用 PG ...
 * await controller.stop();
 * ```
 */
export class PgController extends EventEmitter {
  private child: ChildProcess | null = null;
  private currentStatus: PgStatus = 'stopped';

  constructor(private readonly config: PgConfig) {
    super();
  }

  /**
   * 启动 PG 子进程
   *
   * @throws AppError(ErrorCode.PG_START_FAILED) 端口探活失败
   */
  async start(): Promise<void> {
    if (this.child !== null) {
      throw new AppError(ErrorCode.PG_START_FAILED, 'PG 已在运行，不能重复启动');
    }

    this.setStatus('starting');
    logger.info(
      { binaryPath: this.config.binaryPath, dataDir: this.config.dataDir, port: this.config.port },
      '启动 PostgreSQL 子进程',
    );

    const child = spawn(
      this.config.binaryPath,
      ['-D', this.config.dataDir, '-p', String(this.config.port)],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PGPORT: String(this.config.port) },
      },
    );
    this.child = child;

    // 监听进程退出
    child.on('exit', (code, signal) => {
      logger.warn({ pid: child.pid, code, signal }, 'PG 子进程退出');
      if (this.currentStatus === 'stopping') {
        this.setStatus('stopped');
      } else if (code !== 0 && code !== null) {
        this.setStatus('crashed', { code });
      } else {
        this.setStatus('stopped');
      }
      this.child = null;
    });

    // stdout/stderr 转发到日志
    child.stdout?.on('data', (chunk: Buffer) => {
      logger.debug({ pid: child.pid }, `PG stdout: ${chunk.toString().trim()}`);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      logger.warn({ pid: child.pid }, `PG stderr: ${chunk.toString().trim()}`);
    });

    // 等待端口就绪
    const healthy = await this.waitForPort(START_MAX_RETRIES, START_RETRY_INTERVAL_MS);
    if (!healthy) {
      // 探活失败，杀掉进程
      child.kill('SIGKILL');
      this.child = null;
      this.setStatus('stopped');
      throw new AppError(
        ErrorCode.PG_START_FAILED,
        `PG 启动失败：端口 ${this.config.port} 在 ${START_MAX_RETRIES} 次重试后仍未就绪`,
      );
    }

    this.setStatus('running', { pid: child.pid });
  }

  /**
   * 停止 PG 子进程
   *
   * 优雅停止：SIGTERM → 等 5s → SIGKILL 兜底
   */
  async stop(): Promise<void> {
    if (this.child === null) {
      return;
    }

    this.setStatus('stopping');
    const child = this.child;

    const exited = new Promise<void>((resolve) => {
      child.once('exit', () => resolve());
      // 5 秒后强制 SIGKILL
      setTimeout(() => {
        if (!child.killed) {
          child.kill('SIGKILL');
        }
      }, STOP_TIMEOUT_MS).unref();
    });

    child.kill('SIGTERM');
    await exited;
    this.child = null;
    this.setStatus('stopped');
  }

  /**
   * 健康探活
   *
   * 创建 TCP 连接到 PG 端口，连接成功即健康
   */
  async isHealthy(): Promise<boolean> {
    if (this.child === null) {
      return false;
    }
    return this.probePort();
  }

  /**
   * 获取当前状态
   */
  getStatus(): PgStatus {
    return this.currentStatus;
  }

  /**
   * 等待端口可连接
   *
   * 每 retryIntervalMs 探活一次，最多重试 maxRetries 次
   */
  private async waitForPort(maxRetries: number, retryIntervalMs: number): Promise<boolean> {
    for (let i = 0; i < maxRetries; i++) {
      if (await this.probePort()) {
        return true;
      }
      await sleep(retryIntervalMs);
    }
    return false;
  }

  /**
   * TCP 端口探活
   *
   * 创建连接，连接成功返回 true，ECONNREFUSED 返回 false
   */
  private probePort(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const socket: Socket = createConnection({
        host: 'localhost',
        port: this.config.port,
      });
      let settled = false;
      const done = (result: boolean) => {
        if (!settled) {
          settled = true;
          socket.destroy();
          resolve(result);
        }
      };
      socket.on('connect', () => done(true));
      socket.on('error', () => done(false));
      // 1 秒超时
      setTimeout(() => done(false), 1000).unref();
    });
  }

  /**
   * 设置状态并发射事件
   */
  private setStatus(status: PgStatus, extra?: { pid?: number; code?: number }): void {
    this.currentStatus = status;
    const event: PgStatusChangeEvent = {
      status,
      ...extra,
    };
    this.emit('status-change', event);
  }
}

/**
 * Promise 化 setTimeout
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  });
}
```

- [ ] **Step 5: 运行测试，确认全部通过**

Run: `pnpm test:main`
Expected: `pg-controller.test.ts` 7 个测试通过 + Phase 3a 的 33 个测试 = 共 40 个测试。

- [ ] **Step 6: 验证 typecheck + lint**

Run: `pnpm typecheck && pnpm lint`
Expected: 0 errors 0 warnings。

注意：如 biome 报 `useNamingConvention` 错误（PgStatus 联合类型字面量），在 biome.json 添加 override。

- [ ] **Step 7: Commit**

```bash
git add src/main/infra/pg/pg-types.ts src/main/infra/pg/pg-controller.ts src/main/__tests__/pg-controller.test.ts
git commit -m "feat(pg): PostgreSQL 子进程生命周期与端口探活（§1.1 + §7.8）"
```

---

## Task 2: ollama-controller（Ollama 子进程 + 模型拉取）

**Files:**
- Create: `src/main/infra/ai/ollama-controller.ts`
- Create: `src/main/__tests__/ollama-controller.test.ts`

参考设计文档 §6.6（Ollama 配置）、§7.9（健康监控）。

`OllamaController` 职责：
1. 检测系统 Ollama 是否已安装（`which ollama` / `where ollama`）
2. 探活 `GET http://localhost:11434/api/tags`，已运行则复用，否则 spawn `ollama serve`
3. 模型拉取 `ollama pull nemotron-3-embed-1b-bf16`，进度通过 EventEmitter 推送
4. 健康监控定时器（30s 探活）
5. 崩溃自动重启（最多 3 次，指数退避）

- [ ] **Step 1: 写失败测试 — ollama-controller.test.ts**

创建 `f:\TraeProjects\1\src\main\__tests__\ollama-controller.test.ts`：

```ts
// src/main/__tests__/ollama-controller.test.ts
// ollama-controller 单元测试
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const { mockSpawn, mockChildProcess, mockFetch } = vi.hoisted(() => {
  const mockChildProcess = {
    pid: 67890,
    killed: false,
    kill: vi.fn((signal?: string) => {
      mockChildProcess.killed = true;
      setTimeout(() => {
        mockChildProcess.listeners?.exit?.(0, null);
      }, 10);
      return true;
    }),
    on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      if (!mockChildProcess.listeners) mockChildProcess.listeners = {};
      mockChildProcess.listeners[event] = listener;
    }),
    stdout: { on: vi.fn((event: string, listener: (chunk: Buffer) => void) => {
      if (!mockChildProcess.stdoutListeners) mockChildProcess.stdoutListeners = {};
      mockChildProcess.stdoutListeners[event] = listener;
    }) },
    stderr: { on: vi.fn() },
    listeners: {} as Record<string, (...args: unknown[]) => void>,
    stdoutListeners: {} as Record<string, (chunk: Buffer) => void>,
  };
  const mockSpawn = vi.fn(() => mockChildProcess);
  const mockFetch = vi.fn();
  return { mockSpawn, mockChildProcess, mockFetch };
});

vi.mock('node:child_process', () => ({ spawn: mockSpawn }));
// mock global fetch
globalThis.fetch = mockFetch as unknown as typeof fetch;

import { OllamaController } from '../infra/ai/ollama-controller';

describe('OllamaController', () => {
  let controller: OllamaController;

  beforeEach(() => {
    vi.clearAllMocks();
    mockChildProcess.killed = false;
    mockChildProcess.listeners = {};
    mockChildProcess.stdoutListeners = {};
    controller = new OllamaController({
      binaryPath: 'ollama',
      host: 'localhost',
      port: 11434,
      embedModel: 'nemotron-3-embed-1b-bf16',
      maxRestartCount: 3,
    });
  });

  afterEach(() => {
    controller.removeAllListeners();
  });

  it('start() 探活已运行 Ollama 时复用，不 spawn', async () => {
    // 模拟 Ollama 已运行（/api/tags 返回 200）
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ models: [{ name: 'nemotron-3-embed-1b-bf16' }] }),
    } as Response);

    const statusListener = vi.fn();
    controller.on('status-change', statusListener);

    await controller.start();

    expect(mockSpawn).not.toHaveBeenCalled();
    expect(statusListener).toHaveBeenCalledWith({ status: 'running' });
  });

  it('start() 探活失败时 spawn ollama serve', async () => {
    // 第一次探活失败（未运行），第二次成功（启动后）
    mockFetch
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ models: [] }),
      } as Response);

    const statusListener = vi.fn();
    controller.on('status-change', statusListener);

    await controller.start();

    expect(mockSpawn).toHaveBeenCalledWith('ollama', ['serve'], expect.anything());
    expect(statusListener).toHaveBeenCalledWith({ status: 'running' });
  });

  it('start() spawn 后端口仍不可达时抛 OLLAMA_NOT_RUNNING', async () => {
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(controller.start()).rejects.toThrow();
    expect(mockChildProcess.kill).toHaveBeenCalled();
  });

  it('ensureModelPulled 模型已存在时直接返回', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ models: [{ name: 'nemotron-3-embed-1b-bf16' }] }),
    } as Response);

    await controller.ensureModelPulled();
    // 不应该 spawn pull 进程
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('ensureModelPulled 模型不存在时 spawn ollama pull 并推送进度', async () => {
    // 第一次：检查模型列表，模型不存在
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ models: [] }),
      } as Response)
      // ensureModelPulled 内部再次探活已运行
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ models: [] }),
      } as Response);

    const progressListener = vi.fn();
    controller.on('pull-progress', progressListener);

    // 模拟 pull 进程输出进度 JSON
    const pullPromise = controller.ensureModelPulled();

    // 触发 stdout 模拟 ollama pull 输出
    setTimeout(() => {
      mockChildProcess.stdoutListeners.data?.(Buffer.from('{"status":"pulling","completed":50,"total":100}\n'));
      mockChildProcess.stdoutListeners.data?.(Buffer.from('{"status":"success","completed":100,"total":100}\n'));
      mockChildProcess.listeners.exit?.(0, null);
    }, 10);

    await pullPromise;

    expect(mockSpawn).toHaveBeenCalledWith('ollama', ['pull', 'nemotron-3-embed-1b-bf16'], expect.anything());
    expect(progressListener).toHaveBeenCalledWith(expect.objectContaining({ completed: 50, total: 100 }));
  });

  it('stop() 停止 Ollama 进程', async () => {
    // 先启动（spawn 路径）
    mockFetch
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce({ ok: true, json: async () => ({ models: [] }) } as Response);

    await controller.start();
    await controller.stop();

    expect(mockChildProcess.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('进程崩溃时发射 crashed 状态', async () => {
    mockFetch
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce({ ok: true, json: async () => ({ models: [] }) } as Response);

    const statusListener = vi.fn();
    controller.on('status-change', statusListener);

    await controller.start();
    // 模拟进程崩溃
    mockChildProcess.listeners.exit?.(1, null);

    expect(statusListener).toHaveBeenCalledWith({ status: 'crashed', code: 1 });
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm test:main`
Expected: 编译错误 `Cannot find module '../infra/ai/ollama-controller'`。

- [ ] **Step 3: 实现 ollama-controller.ts**

创建 `f:\TraeProjects\1\src\main\infra\ai\ollama-controller.ts`：

```ts
// src/main/infra/ai/ollama-controller.ts
// Ollama 本地嵌入服务管理
// 设计文档 §6.6 Ollama 配置 + §7.9 健康监控
//
// 职责：
// 1. 探活 Ollama 是否已运行（GET /api/tags）
// 2. 未运行时 spawn `ollama serve` 启动
// 3. 模型拉取 `ollama pull <model>`，进度通过 EventEmitter 推送
// 4. 崩溃自动重启（最多 maxRestartCount 次，指数退避）
// 5. 健康监控定时器（默认 30s 探活）
//
// 注意：不依赖 Electron，便于测试

import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { AppError, ErrorCode } from '@novel-writer/shared';
import { logger } from '../../utils/logger';

/**
 * Ollama 控制器配置
 */
export interface OllamaControllerConfig {
  /** ollama 可执行文件路径（dev: 'ollama'，prod: 绝对路径） */
  readonly binaryPath: string;
  /** 监听 host */
  readonly host: string;
  /** 监听端口（Ollama 默认 11434） */
  readonly port: number;
  /** 嵌入模型名 */
  readonly embedModel: string;
  /** 崩溃最大重启次数（默认 3） */
  readonly maxRestartCount: number;
}

/**
 * Ollama 状态
 */
export type OllamaStatus =
  | 'stopped'
  | 'starting'
  | 'running'
  | 'crashed'
  | 'stopping';

/**
 * 模型拉取进度事件
 */
export interface PullProgressEvent {
  readonly status: string;
  readonly completed?: number;
  readonly total?: number;
}

/**
 * 状态变更事件
 */
export interface OllamaStatusChangeEvent {
  readonly status: OllamaStatus;
  readonly code?: number;
}

/**
 * 启动时探活最大重试次数
 */
const START_MAX_RETRIES = 30;

/**
 * 启动时探活间隔（毫秒）
 */
const START_RETRY_INTERVAL_MS = 1000;

/**
 * Ollama 本地嵌入服务控制器
 *
 * 继承 EventEmitter，发射：
 * - 'status-change'：OllamaStatusChangeEvent
 * - 'pull-progress'：PullProgressEvent
 *
 * @example
 * ```ts
 * const controller = new OllamaController({
 *   binaryPath: 'ollama',
 *   host: 'localhost',
 *   port: 11434,
 *   embedModel: 'nemotron-3-embed-1b-bf16',
 *   maxRestartCount: 3,
 * });
 * controller.on('status-change', (e) => logger.info({ status: e.status }, 'Ollama 状态变更'));
 * controller.on('pull-progress', (e) => logger.info({ completed: e.completed }, '模型拉取进度'));
 * await controller.start();
 * await controller.ensureModelPulled();
 * ```
 */
export class OllamaController extends EventEmitter {
  private child: ChildProcess | null = null;
  private currentStatus: OllamaStatus = 'stopped';
  private restartCount = 0;

  constructor(private readonly config: OllamaControllerConfig) {
    super();
  }

  /**
   * 启动 Ollama 服务
   *
   * - 若已运行（端口探活成功），直接复用
   * - 否则 spawn `ollama serve`，等待端口就绪
   *
   * @throws AppError(ErrorCode.OLLAMA_NOT_RUNNING) spawn 后端口仍不可达
   */
  async start(): Promise<void> {
    if (this.currentStatus === 'running') {
      return;
    }

    // 1. 先探活是否已运行
    const alreadyRunning = await this.probeHealth();
    if (alreadyRunning) {
      logger.info({ host: this.config.host, port: this.config.port }, 'Ollama 已运行，复用现有进程');
      this.setStatus('running');
      return;
    }

    // 2. 未运行则 spawn ollama serve
    this.setStatus('starting');
    logger.info({ binaryPath: this.config.binaryPath }, 'spawn ollama serve');

    const child = spawn(this.config.binaryPath, ['serve'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        OLLAMA_HOST: `${this.config.host}:${this.config.port}`,
      },
    });
    this.child = child;

    // 监听进程退出
    child.on('exit', (code, signal) => {
      logger.warn({ pid: child.pid, code, signal }, 'Ollama 子进程退出');
      if (this.currentStatus === 'stopping') {
        this.setStatus('stopped');
      } else if (code !== 0 && code !== null) {
        this.handleCrash(code);
      } else {
        this.setStatus('stopped');
      }
      this.child = null;
    });

    child.stdout?.on('data', (chunk: Buffer) => {
      logger.debug({ pid: child.pid }, `Ollama stdout: ${chunk.toString().trim()}`);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      logger.warn({ pid: child.pid }, `Ollama stderr: ${chunk.toString().trim()}`);
    });

    // 3. 等待端口就绪
    const healthy = await this.waitForHealth(START_MAX_RETRIES, START_RETRY_INTERVAL_MS);
    if (!healthy) {
      child.kill('SIGKILL');
      this.child = null;
      this.setStatus('stopped');
      throw new AppError(
        ErrorCode.OLLAMA_NOT_RUNNING,
        `Ollama 启动失败：端口 ${this.config.port} 在 ${START_MAX_RETRIES} 次重试后仍未就绪`,
      );
    }

    this.restartCount = 0;
    this.setStatus('running');
  }

  /**
   * 确保模型已拉取
   *
   * - 先检查 /api/tags，模型存在则跳过
   * - 不存在则 spawn `ollama pull <model>`，逐行解析 stdout 推送进度
   *
   * @throws AppError(ErrorCode.OLLAMA_MODEL_PULL_FAILED) 拉取失败
   */
  async ensureModelPulled(): Promise<void> {
    // 1. 检查模型是否已存在
    const tags = await this.fetchTags();
    if (tags.models?.some((m: { name: string }) => m.name === this.config.embedModel)) {
      logger.info({ model: this.config.embedModel }, 'Ollama 模型已存在，跳过拉取');
      return;
    }

    // 2. 拉取模型
    logger.info({ model: this.config.embedModel }, '拉取 Ollama 模型');
    const child = spawn(this.config.binaryPath, ['pull', this.config.embedModel], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    return new Promise<void>((resolve, reject) => {
      child.on('exit', (code) => {
        if (code === 0) {
          logger.info({ model: this.config.embedModel }, 'Ollama 模型拉取完成');
          resolve();
        } else {
          reject(
            new AppError(
              ErrorCode.OLLAMA_MODEL_PULL_FAILED,
              `Ollama 模型拉取失败：${this.config.embedModel}，退出码 ${code}`,
            ),
          );
        }
      });
      // 逐行解析 stdout JSON 推送进度
      child.stdout?.on('data', (chunk: Buffer) => {
        const lines = chunk.toString().split('\n').filter(Boolean);
        for (const line of lines) {
          try {
            const progress = JSON.parse(line) as PullProgressEvent;
            this.emit('pull-progress', progress);
            logger.debug({ progress }, '模型拉取进度');
          } catch {
            // 非 JSON 行（如下载进度条），忽略
          }
        }
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        logger.warn({ stderr: chunk.toString().trim() }, 'Ollama pull stderr');
      });
    });
  }

  /**
   * 停止 Ollama 子进程
   *
   * 注意：若 Ollama 是系统托盘启动的（非本 controller spawn），不停止
   */
  async stop(): Promise<void> {
    if (this.child === null) {
      return;
    }

    this.setStatus('stopping');
    const child = this.child;

    const exited = new Promise<void>((resolve) => {
      child.once('exit', () => resolve());
      setTimeout(() => {
        if (!child.killed) {
          child.kill('SIGKILL');
        }
      }, 5000).unref();
    });

    child.kill('SIGTERM');
    await exited;
    this.child = null;
    this.setStatus('stopped');
  }

  /**
   * 健康探活
   */
  async isHealthy(): Promise<boolean> {
    return this.probeHealth();
  }

  /**
   * 获取当前状态
   */
  getStatus(): OllamaStatus {
    return this.currentStatus;
  }

  /**
   * 探活 Ollama API
   *
   * GET http://{host}:{port}/api/tags 返回 200 即健康
   */
  private async probeHealth(): Promise<boolean> {
    try {
      const response = await fetch(this.apiUrl('/api/tags'));
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * 获取已拉取的模型列表
   */
  private async fetchTags(): Promise<{ models?: Array<{ name: string }> }> {
    const response = await fetch(this.apiUrl('/api/tags'));
    if (!response.ok) {
      throw new AppError(ErrorCode.OLLAMA_NOT_RUNNING, `获取 Ollama 模型列表失败：${response.status}`);
    }
    return response.json() as Promise<{ models?: Array<{ name: string }> }>;
  }

  /**
   * 等待 Ollama 健康就绪
   */
  private async waitForHealth(maxRetries: number, retryIntervalMs: number): Promise<boolean> {
    for (let i = 0; i < maxRetries; i++) {
      if (await this.probeHealth()) {
        return true;
      }
      await sleep(retryIntervalMs);
    }
    return false;
  }

  /**
   * 处理进程崩溃
   *
   * 自动重启（最多 maxRestartCount 次，指数退避）
   */
  private handleCrash(code: number): void {
    this.setStatus('crashed', { code });

    if (this.restartCount >= this.config.maxRestartCount) {
      logger.error(
        { restartCount: this.restartCount, maxRestartCount: this.config.maxRestartCount },
        'Ollama 重启次数已达上限，放弃重启',
      );
      return;
    }

    this.restartCount++;
    const backoff = 2000 * (2 ** (this.restartCount - 1));
    logger.warn(
      { restartCount: this.restartCount, backoff },
      'Ollama 崩溃，准备重启',
    );

    setTimeout(() => {
      this.start().catch((err: unknown) => {
        logger.error({ err }, 'Ollama 重启失败');
      });
    }, backoff).unref();
  }

  /**
   * 构造 API URL
   */
  private apiUrl(path: string): string {
    return `http://${this.config.host}:${this.config.port}${path}`;
  }

  /**
   * 设置状态并发射事件
   */
  private setStatus(status: OllamaStatus, extra?: { code?: number }): void {
    this.currentStatus = status;
    const event: OllamaStatusChangeEvent = { status, ...extra };
    this.emit('status-change', event);
  }
}

/**
 * Promise 化 setTimeout
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  });
}
```

- [ ] **Step 4: 运行测试，确认全部通过**

Run: `pnpm test:main`
Expected: `ollama-controller.test.ts` 7 个测试通过。

- [ ] **Step 5: 验证 typecheck + lint**

Run: `pnpm typecheck && pnpm lint`
Expected: 0 errors 0 warnings。

- [ ] **Step 6: Commit**

```bash
git add src/main/infra/ai/ollama-controller.ts src/main/__tests__/ollama-controller.test.ts
git commit -m "feat(ai): Ollama 子进程管理与模型拉取（§6.6 + §7.9）"
```

---

## Task 3: openai-client（DeepSeek 聊天客户端）

**Files:**
- Modify: `package.json`（添加 `openai: ^5` 依赖）
- Create: `src/main/infra/ai/openai-client.ts`
- Create: `src/main/__tests__/openai-client.test.ts`

参考设计文档 §2.2（openai ^5）、§4.3（ai/openai-client 职责）。

`getOpenAIClient()` 单例工厂：
- 使用 `openai` 5 SDK
- baseURL 指向 DeepSeek API（`https://api.deepseek.com`）
- apiKey 从 keychain 读取
- 配置默认超时 60s

- [ ] **Step 1: 在 package.json 添加 openai 依赖**

在 `f:\TraeProjects\1\package.json` 的 `dependencies` 中添加 `"openai": "^5"`：

```json
"dependencies": {
  "@sentry/electron": "^5",
  "electron": "^40",
  "electron-log": "^5",
  "electron-vite": "6.0.0-beta.1",
  "openai": "^5",
  "react": "^19.2",
  "react-dom": "^19.2",
  "vite": "^8"
}
```

Run: `pnpm install --no-frozen-lockfile`
Expected: openai 5 安装成功，pnpm-lock.yaml 更新。

- [ ] **Step 2: 写失败测试 — openai-client.test.ts**

创建 `f:\TraeProjects\1\src\main\__tests__\openai-client.test.ts`：

```ts
// src/main/__tests__/openai-client.test.ts
// openai-client 单测
import { describe, expect, it, vi, beforeEach } from 'vitest';

const { mockOpenAIConstructor, mockInstance, mockKeychain } = vi.hoisted(() => {
  const mockInstance = {
    chat: { completions: { create: vi.fn() } },
    embeddings: { create: vi.fn() },
  };
  const mockOpenAIConstructor = vi.fn(() => mockInstance);
  const mockKeychain = {
    getSecret: vi.fn(),
    setSecret: vi.fn(),
    deleteSecret: vi.fn(),
    listSecrets: vi.fn(),
  };
  return { mockOpenAIConstructor, mockInstance, mockKeychain };
});

// mock openai SDK
vi.mock('openai', () => ({
  default: mockOpenAIConstructor,
}));

// mock keychain
vi.mock('../infra/storage/keychain', () => ({
  getSecret: mockKeychain.getSecret,
  setSecret: mockKeychain.setSecret,
  deleteSecret: mockKeychain.deleteSecret,
  listSecrets: mockKeychain.listSecrets,
}));

// mock config（避免触发真实 env 读取）
vi.mock('../config', () => ({
  getAppConfig: () => ({
    deepseek: {
      apiBase: 'https://api.deepseek.com',
      model: 'deepseek-v4-flash',
      timeout: 60_000,
    },
  }),
}));

import { getOpenAIClient, resetOpenAIClient } from '../infra/ai/openai-client';
import { AppError, ErrorCode } from '@novel-writer/shared';

describe('openai-client', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetOpenAIClient();
    mockKeychain.getSecret.mockResolvedValue('sk-test-api-key');
  });

  it('首次调用创建 OpenAI 实例', async () => {
    const client = await getOpenAIClient();

    expect(mockKeychain.getSecret).toHaveBeenCalledWith('deepseek-api-key');
    expect(mockOpenAIConstructor).toHaveBeenCalledWith({
      baseURL: 'https://api.deepseek.com',
      apiKey: 'sk-test-api-key',
      timeout: 60_000,
      maxRetries: 0,
    });
    expect(client).toBe(mockInstance);
  });

  it('后续调用返回缓存的实例', async () => {
    const client1 = await getOpenAIClient();
    const client2 = await getOpenAIClient();

    expect(client1).toBe(client2);
    expect(mockOpenAIConstructor).toHaveBeenCalledTimes(1);
  });

  it('resetOpenAIClient 后下次调用重新创建实例', async () => {
    await getOpenAIClient();
    resetOpenAIClient();
    await getOpenAIClient();

    expect(mockOpenAIConstructor).toHaveBeenCalledTimes(2);
  });

  it('API Key 未配置时抛 AI_API_KEY_MISSING', async () => {
    mockKeychain.getSecret.mockResolvedValue(null);

    await expect(getOpenAIClient()).rejects.toMatchObject({
      code: ErrorCode.AI_API_KEY_MISSING,
    });
  });

  it('使用传入的 apiKey 覆盖 keychain', async () => {
    await getOpenAIClient({ apiKey: 'sk-custom-key' });

    expect(mockKeychain.getSecret).not.toHaveBeenCalled();
    expect(mockOpenAIConstructor).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'sk-custom-key' }),
    );
  });
});
```

- [ ] **Step 3: 运行测试，确认失败**

Run: `pnpm test:main`
Expected: 编译错误 `Cannot find module '../infra/ai/openai-client'`。

- [ ] **Step 4: 实现 openai-client.ts**

创建 `f:\TraeProjects\1\src\main\infra\ai\openai-client.ts`：

```ts
// src/main/infra/ai/openai-client.ts
// OpenAI 5 SDK 客户端单例（DeepSeek 聊天）
// 设计文档 §2.2 + §4.3 ai/openai-client 职责
//
// 职责：
// 1. 创建 OpenAI 5 SDK 实例，baseURL 指向 DeepSeek API
// 2. apiKey 从 keychain 读取（首次配置时由 settings service 写入）
// 3. 配置默认超时 60s，maxRetries=0（由 retry.ts 统一管理重试）
// 4. 单例缓存，避免重复创建

import OpenAI from 'openai';
import { AppError, ErrorCode } from '@novel-writer/shared';
import { getAppConfig } from '../../config';
import { getSecret } from '../storage/keychain';
import { logger } from '../../utils/logger';

/**
 * OpenAI 客户端单例工厂配置
 */
interface OpenAIClientFactoryOptions {
  /**
   * 显式传入的 API Key（覆盖 keychain 读取）
   *
   * 用于 settings:setApiKey 调用后立即测试连接
   */
  readonly apiKey?: string;
}

/**
 * keychain 中存储 DeepSeek API Key 的 key 名
 */
const DEEPSEEK_API_KEY_NAME = 'deepseek-api-key';

/** 缓存的 OpenAI 实例 */
let cachedClient: OpenAI | null = null;

/**
 * 获取 OpenAI 客户端单例
 *
 * @param options 显式覆盖配置（仅用于 apiKey 测试连接）
 * @returns OpenAI 5 SDK 实例
 * @throws AppError(ErrorCode.AI_API_KEY_MISSING) API Key 未配置
 *
 * @example
 * ```ts
 * const client = await getOpenAIClient();
 * const response = await client.chat.completions.create({
 *   model: 'deepseek-v4-flash',
 *   messages: [{ role: 'user', content: '你好' }],
 * });
 * ```
 */
export async function getOpenAIClient(
  options?: OpenAIClientFactoryOptions,
): Promise<OpenAI> {
  // 显式传入 apiKey 时直接创建临时实例（用于测试连接）
  if (options?.apiKey !== undefined) {
    return createClient(options.apiKey);
  }

  // 单例缓存
  if (cachedClient !== null) {
    return cachedClient;
  }

  // 从 keychain 读取 API Key
  const apiKey = await getSecret(DEEPSEEK_API_KEY_NAME);
  if (apiKey === null) {
    throw new AppError(
      ErrorCode.AI_API_KEY_MISSING,
      'DeepSeek API Key 未配置，请先在设置中添加',
    );
  }

  cachedClient = createClient(apiKey);
  logger.info({ baseURL: getAppConfig().deepseek.apiBase }, 'OpenAI 客户端已创建');
  return cachedClient;
}

/**
 * 重置客户端缓存
 *
 * 用于 settings:setApiKey 后下次调用重新创建实例
 */
export function resetOpenAIClient(): void {
  cachedClient = null;
}

/**
 * 创建 OpenAI 实例
 */
function createClient(apiKey: string): OpenAI {
  const config = getAppConfig();
  return new OpenAI({
    baseURL: config.deepseek.apiBase,
    apiKey,
    timeout: config.deepseek.timeout,
    // 重试由 retry.ts 统一管理（含 AppError 分类），SDK 自带重试不区分错误类型
    maxRetries: 0,
  });
}
```

- [ ] **Step 5: 运行测试，确认全部通过**

Run: `pnpm test:main`
Expected: `openai-client.test.ts` 5 个测试通过。

- [ ] **Step 6: 验证 typecheck + lint**

Run: `pnpm typecheck && pnpm lint`
Expected: 0 errors 0 warnings。

- [ ] **Step 7: Commit**

```bash
git add package.json pnpm-lock.yaml src/main/infra/ai/openai-client.ts src/main/__tests__/openai-client.test.ts
git commit -m "feat(ai): OpenAI 5 SDK 客户端单例与 keychain 集成（§4.3）"
```

---

## Task 4: embedding-client（本地 Ollama 嵌入客户端）

**Files:**
- Create: `src/main/infra/ai/embedding-client.ts`
- Create: `src/main/__tests__/embedding-client.test.ts`

参考设计文档 §6.6（Ollama 配置 + OpenAI 兼容协议）。

`getEmbeddingClient()` 单例工厂：
- 复用 openai 5 SDK
- baseURL 指向本地 Ollama（`http://localhost:11434/v1`）
- apiKey 任意值（Ollama 不校验）
- 模型 `nemotron-3-embed-1b-bf16`，维度 2048

- [ ] **Step 1: 写失败测试 — embedding-client.test.ts**

创建 `f:\TraeProjects\1\src\main\__tests__\embedding-client.test.ts`：

```ts
// src/main/__tests__/embedding-client.test.ts
// embedding-client 单测
import { describe, expect, it, vi, beforeEach } from 'vitest';

const { mockOpenAIConstructor, mockInstance } = vi.hoisted(() => {
  const mockInstance = {
    embeddings: {
      create: vi.fn().mockResolvedValue({
        data: [{ embedding: [0.1, 0.2, 0.3] }],
        usage: { prompt_tokens: 10, total_tokens: 10 },
      }),
    },
  };
  const mockOpenAIConstructor = vi.fn(() => mockInstance);
  return { mockOpenAIConstructor, mockInstance };
});

vi.mock('openai', () => ({
  default: mockOpenAIConstructor,
}));

vi.mock('../config', () => ({
  getAppConfig: () => ({
    ollama: {
      url: 'http://localhost:11434',
      embedModel: 'nemotron-3-embed-1b-bf16',
      embedDimensions: 2048,
    },
  }),
}));

import { getEmbeddingClient, embed, resetEmbeddingClient } from '../infra/ai/embedding-client';

describe('embedding-client', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetEmbeddingClient();
  });

  it('首次调用创建指向 Ollama 的 OpenAI 实例', () => {
    const client = getEmbeddingClient();

    expect(mockOpenAIConstructor).toHaveBeenCalledWith({
      baseURL: 'http://localhost:11434/v1',
      apiKey: 'ollama',
      maxRetries: 0,
    });
    expect(client).toBe(mockInstance);
  });

  it('后续调用返回缓存的实例', () => {
    const client1 = getEmbeddingClient();
    const client2 = getEmbeddingClient();

    expect(client1).toBe(client2);
    expect(mockOpenAIConstructor).toHaveBeenCalledTimes(1);
  });

  it('resetEmbeddingClient 后重新创建实例', () => {
    getEmbeddingClient();
    resetEmbeddingClient();
    getEmbeddingClient();

    expect(mockOpenAIConstructor).toHaveBeenCalledTimes(2);
  });

  it('embed 调用 SDK 生成嵌入向量', async () => {
    const vectors = await embed(['你好', '世界']);

    expect(mockInstance.embeddings.create).toHaveBeenCalledWith({
      model: 'nemotron-3-embed-1b-bf16',
      input: ['你好', '世界'],
    });
    expect(vectors).toEqual([[0.1, 0.2, 0.3]]);
  });

  it('embed 空数组时不调用 SDK', async () => {
    const vectors = await embed([]);

    expect(mockInstance.embeddings.create).not.toHaveBeenCalled();
    expect(vectors).toEqual([]);
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm test:main`
Expected: 编译错误 `Cannot find module '../infra/ai/embedding-client'`。

- [ ] **Step 3: 实现 embedding-client.ts**

创建 `f:\TraeProjects\1\src\main\infra\ai\embedding-client.ts`：

```ts
// src/main/infra/ai/embedding-client.ts
// 本地 Ollama 嵌入客户端
// 设计文档 §6.6 Ollama 配置 + OpenAI 兼容协议
//
// 复用 openai 5 SDK，baseURL 指向本地 Ollama：
// - URL: http://localhost:11434/v1
// - apiKey: 任意值（Ollama 不校验）
// - 模型: nemotron-3-embed-1b-bf16（2048 维）
//
// Ollama 提供 OpenAI 兼容的 /v1/embeddings 端点，可直接复用 openai SDK

import OpenAI from 'openai';
import { getAppConfig } from '../../config';
import { logger } from '../../utils/logger';

/**
 * Ollama 不校验 API Key，任意值即可
 */
const OLLAMA_API_KEY = 'ollama';

/**
 * OpenAI SDK 兼容路径（Ollama 在 /v1 下提供 OpenAI 兼容 API）
 */
const OLLAMA_API_PATH = '/v1';

/** 缓存的 embedding 客户端 */
let cachedClient: OpenAI | null = null;

/**
 * 获取嵌入客户端单例
 *
 * @returns 指向本地 Ollama 的 OpenAI SDK 实例
 *
 * @example
 * ```ts
 * const client = getEmbeddingClient();
 * const res = await client.embeddings.create({
 *   model: 'nemotron-3-embed-1b-bf16',
 *   input: ['你好'],
 * });
 * ```
 */
export function getEmbeddingClient(): OpenAI {
  if (cachedClient !== null) {
    return cachedClient;
  }

  const config = getAppConfig();
  const baseURL = `${config.ollama.url}${OLLAMA_API_PATH}`;

  cachedClient = new OpenAI({
    baseURL,
    apiKey: OLLAMA_API_KEY,
    // 重试由 retry.ts 统一管理（含 AppError 分类）
    maxRetries: 0,
  });

  logger.info({ baseURL, model: config.ollama.embedModel }, 'Ollama 嵌入客户端已创建');
  return cachedClient;
}

/**
 * 重置 embedding 客户端缓存
 *
 * 用于配置变更后重新创建实例
 */
export function resetEmbeddingClient(): void {
  cachedClient = null;
}

/**
 * 批量生成嵌入向量
 *
 * @param texts 文本数组（已切片）
 * @returns 与输入等长的向量数组（每个元素是 number[]）
 *
 * @example
 * ```ts
 * const vectors = await embed(['你好', '世界']);
 * // vectors = [[0.1, 0.2, ...], [0.3, 0.4, ...]]
 * ```
 */
export async function embed(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) {
    return [];
  }

  const config = getAppConfig();
  const client = getEmbeddingClient();

  const response = await client.embeddings.create({
    model: config.ollama.embedModel,
    input: texts,
  });

  logger.debug(
    { count: texts.length, model: config.ollama.embedModel },
    '嵌入向量生成完成',
  );

  return response.data.map((item: { embedding: number[] }) => item.embedding);
}
```

- [ ] **Step 4: 运行测试，确认全部通过**

Run: `pnpm test:main`
Expected: `embedding-client.test.ts` 5 个测试通过。

- [ ] **Step 5: 验证 typecheck + lint**

Run: `pnpm typecheck && pnpm lint`
Expected: 0 errors 0 warnings。

- [ ] **Step 6: Commit**

```bash
git add src/main/infra/ai/embedding-client.ts src/main/__tests__/embedding-client.test.ts
git commit -m "feat(ai): 本地 Ollama 嵌入客户端（OpenAI 兼容协议，§6.6）"
```

---

## Task 5: stream-bridge（流式响应 → IPC 事件桥接）

**Files:**
- Create: `src/main/infra/ai/stream-bridge.ts`
- Create: `src/main/__tests__/stream-bridge.test.ts`

参考设计文档 §5.5（流式响应中断设计）。

`StreamBridge` 职责：
1. 管理活跃流 `Map<sessionId, AbortController>`
2. `streamToWebContents(sessionId, webContents, stream, channel)`：迭代 AsyncIterable，逐 chunk 推送
3. `abort(sessionId)`：中断指定 session 的流
4. 流结束 / 中断 / 异常时清理 controller，发射 end/error 事件
5. 解耦：不依赖 openai SDK 类型，接收 `AsyncIterable<T>`

- [ ] **Step 1: 写失败测试 — stream-bridge.test.ts**

创建 `f:\TraeProjects\1\src\main\__tests__\stream-bridge.test.ts`：

```ts
// src/main/__tests__/stream-bridge.test.ts
// stream-bridge 单测
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { StreamBridge } from '../infra/ai/stream-bridge';
import { IPC_CHANNELS } from '@novel-writer/shared';

// 辅助：构造内存 AsyncIterable
function makeStream<T>(chunks: T[], shouldThrow = false): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        next(): Promise<IteratorResult<T>> {
          if (shouldThrow && i === chunks.length) {
            return Promise.reject(new Error('stream error'));
          }
          if (i >= chunks.length) {
            return Promise.resolve({ done: true, value: undefined as unknown as T });
          }
          return Promise.resolve({ done: false, value: chunks[i++] });
        },
      };
    },
  };
}

// 模拟 webContents
function makeWebContents() {
  return {
    send: vi.fn(),
    isDestroyed: vi.fn(() => false),
  };
}

describe('StreamBridge', () => {
  let bridge: StreamBridge;

  beforeEach(() => {
    bridge = new StreamBridge();
  });

  it('streamToWebContents 迭代完成推送所有 chunk 与 end 事件', async () => {
    const wc = makeWebContents();
    const stream = makeStream(['hello', ' ', 'world']);

    const fullText = await bridge.streamToWebContents({
      sessionId: 'session-1',
      webContents: wc as never,
      stream,
      chunkChannel: IPC_CHANNELS.CHAT_STREAM_CHUNK,
      endChannel: IPC_CHANNELS.CHAT_STREAM_END,
      errorChannel: IPC_CHANNELS.CHAT_STREAM_ERROR,
    });

    expect(fullText).toBe('hello world');
    expect(wc.send).toHaveBeenCalledTimes(4); // 3 chunk + 1 end
    expect(wc.send).toHaveBeenNthCalledWith(1, IPC_CHANNELS.CHAT_STREAM_CHUNK, {
      sessionId: 'session-1',
      chunk: 'hello',
    });
    expect(wc.send).toHaveBeenNthCalledWith(4, IPC_CHANNELS.CHAT_STREAM_END, {
      sessionId: 'session-1',
      fullText: 'hello world',
    });
  });

  it('stream 抛错时推送 error 事件并清理', async () => {
    const wc = makeWebContents();
    const stream = makeStream(['a', 'b'], true);

    await expect(
      bridge.streamToWebContents({
        sessionId: 'session-2',
        webContents: wc as never,
        stream,
        chunkChannel: IPC_CHANNELS.CHAT_STREAM_CHUNK,
        endChannel: IPC_CHANNELS.CHAT_STREAM_END,
        errorChannel: IPC_CHANNELS.CHAT_STREAM_ERROR,
      }),
    ).rejects.toThrow('stream error');

    expect(wc.send).toHaveBeenCalledWith(IPC_CHANNELS.CHAT_STREAM_ERROR, {
      sessionId: 'session-2',
      error: 'stream error',
    });
    // 流被清理
    expect(bridge.has('session-2')).toBe(false);
  });

  it('abort 中断流并推送 error 事件', async () => {
    const wc = makeWebContents();
    let resolveNext: () => void;
    const blockedNext = new Promise<void>((resolve) => {
      resolveNext = resolve;
    });

    const stream: AsyncIterable<string> = {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<string>> {
            return blockedNext.then(() => ({ done: true, value: undefined as unknown as string }));
          },
        };
      },
    };

    const promise = bridge.streamToWebContents({
      sessionId: 'session-3',
      webContents: wc as never,
      stream,
      chunkChannel: IPC_CHANNELS.CHAT_STREAM_CHUNK,
      endChannel: IPC_CHANNELS.CHAT_STREAM_END,
      errorChannel: IPC_CHANNELS.CHAT_STREAM_ERROR,
    });

    bridge.abort('session-3');
    resolveNext();

    await promise;

    expect(wc.send).toHaveBeenCalledWith(IPC_CHANNELS.CHAT_STREAM_ERROR, {
      sessionId: 'session-3',
      error: 'aborted',
    });
    expect(bridge.has('session-3')).toBe(false);
  });

  it('has 返回活跃流状态', async () => {
    const wc = makeWebContents();
    const stream = makeStream(['a']);

    expect(bridge.has('session-4')).toBe(false);

    const promise = bridge.streamToWebContents({
      sessionId: 'session-4',
      webContents: wc as never,
      stream,
      chunkChannel: IPC_CHANNELS.CHAT_STREAM_CHUNK,
      endChannel: IPC_CHANNELS.CHAT_STREAM_END,
      errorChannel: IPC_CHANNELS.CHAT_STREAM_ERROR,
    });
    // 流在迭代期间活跃
    expect(bridge.has('session-4')).toBe(true);
    await promise;
    // 流结束后清理
    expect(bridge.has('session-4')).toBe(false);
  });

  it('webContents 已销毁时不推送', async () => {
    const wc = makeWebContents();
    wc.isDestroyed.mockReturnValue(true);
    const stream = makeStream(['a', 'b']);

    const fullText = await bridge.streamToWebContents({
      sessionId: 'session-5',
      webContents: wc as never,
      stream,
      chunkChannel: IPC_CHANNELS.CHAT_STREAM_CHUNK,
      endChannel: IPC_CHANNELS.CHAT_STREAM_END,
      errorChannel: IPC_CHANNELS.CHAT_STREAM_ERROR,
    });

    expect(wc.send).not.toHaveBeenCalled();
    expect(fullText).toBe('ab');
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm test:main`
Expected: 编译错误 `Cannot find module '../infra/ai/stream-bridge'`。

- [ ] **Step 3: 实现 stream-bridge.ts**

创建 `f:\TraeProjects\1\src\main\infra\ai\stream-bridge.ts`：

```ts
// src/main/infra/ai/stream-bridge.ts
// 流式响应 → IPC 事件桥接
// 设计文档 §5.5 流式响应中断设计
//
// 职责：
// 1. 管理活跃流 Map<sessionId, AbortController>
// 2. 迭代 AsyncIterable<T>，逐 chunk 推送到渲染层
// 3. abort(sessionId) 中断指定流
// 4. 流结束/中断/异常时清理 controller
// 5. 推送前检查 webContents.isDestroyed，避免窗口关闭后报错
//
// 解耦：不依赖 openai SDK 类型，接收任意 AsyncIterable<T>

import type { WebContents } from 'electron';
import type { IpcChannel } from '@novel-writer/shared';
import { logger } from '../../utils/logger';

/**
 * 流式 chunk 类型约束
 *
 * openai SDK 的 chunk 是对象，streamToWebContents 会通过 String(chunk) 转换
 * 调用方可传入字符串流或对象流，最终通过 chunkToString() 统一为字符串
 */
export type StreamChunk = unknown;

/**
 * streamToWebContents 参数
 */
export interface StreamToWebContentsOptions<T extends StreamChunk = StreamChunk> {
  /** 会话 ID（用于关联 abort 请求） */
  readonly sessionId: string;
  /** 目标 webContents（接收 chunk 事件） */
  readonly webContents: WebContents;
  /** 流式数据源（openai SDK 的 stream 或自定义 AsyncIterable） */
  readonly stream: AsyncIterable<T>;
  /** chunk 推送 channel（如 IPC_CHANNELS.CHAT_STREAM_CHUNK） */
  readonly chunkChannel: IpcChannel;
  /** 流结束 channel（如 IPC_CHANNELS.CHAT_STREAM_END） */
  readonly endChannel: IpcChannel;
  /** 流异常 channel（如 IPC_CHANNELS.CHAT_STREAM_ERROR） */
  readonly errorChannel: IpcChannel;
}

/**
 * 流式响应桥接器
 *
 * @example
 * ```ts
 * const bridge = new StreamBridge();
 * const stream = await openaiClient.chat.completions.create({ ..., stream: true });
 * const fullText = await bridge.streamToWebContents({
 *   sessionId: 'xxx',
 *   webContents: win.webContents,
 *   stream,
 *   chunkChannel: IPC_CHANNELS.CHAT_STREAM_CHUNK,
 *   endChannel: IPC_CHANNELS.CHAT_STREAM_END,
 *   errorChannel: IPC_CHANNELS.CHAT_STREAM_ERROR,
 * });
 * ```
 */
export class StreamBridge {
  private readonly activeStreams = new Map<string, AbortController>();

  /**
   * 迭代流并推送到 webContents
   *
   * @returns 完整文本（所有 chunk 拼接）
   *
   * 流结束（正常）：推 end 事件，清理 controller
   * 流结束（abort）：推 error 事件（error: 'aborted'），不 rethrow
   *   注意：abort 可能发生在 next() 调用期间（for await 未进入循环体就退出），
   *   因此需要在循环退出后再次检查 controller.signal.aborted
   * 流异常：推 error 事件，清理 controller，rethrow
   * webContents 销毁：不推送但仍消费完流以释放底层资源
   */
  async streamToWebContents<T extends StreamChunk = StreamChunk>(
    options: StreamToWebContentsOptions<T>,
  ): Promise<string> {
    const { sessionId, webContents, stream, chunkChannel, endChannel, errorChannel } = options;

    const controller = new AbortController();
    this.activeStreams.set(sessionId, controller);

    let fullText = '';
    let wasAborted = false;

    try {
      for await (const chunk of stream) {
        // 中断检查（abort 发生在上一轮 next() 返回后）
        if (controller.signal.aborted) {
          wasAborted = true;
          logger.info({ sessionId }, '流式响应被中断');
          break;
        }

        // 累加完整文本（即使 webContents 销毁仍消费流以释放底层资源）
        const chunkStr = chunkToString(chunk);
        fullText += chunkStr;

        // webContents 已销毁时不推送，但继续消费流
        if (!webContents.isDestroyed()) {
          this.emit(webContents, chunkChannel, { sessionId, chunk: chunkStr });
        }
      }

      // abort 可能发生在 next() 调用期间（循环未进入循环体就退出）
      // 此时 wasAborted 仍为 false，需要通过 controller.signal.aborted 兜底
      if (controller.signal.aborted) {
        wasAborted = true;
      }

      // 循环退出后统一处理 abort / end 事件
      if (wasAborted) {
        this.emit(webContents, errorChannel, { sessionId, error: 'aborted' });
        logger.info({ sessionId }, '流式响应被中断');
      } else if (!webContents.isDestroyed()) {
        this.emit(webContents, endChannel, { sessionId, fullText });
        logger.info({ sessionId, length: fullText.length }, '流式响应完成');
      }
    } catch (error: unknown) {
      // 异常时推 error 事件
      const message = error instanceof Error ? error.message : String(error);
      this.emit(webContents, errorChannel, { sessionId, error: message });
      logger.error({ sessionId, err: error }, '流式响应异常');
      throw error;
    } finally {
      this.activeStreams.delete(sessionId);
    }

    return fullText;
  }

  /**
   * 中断指定 session 的流
   */
  abort(sessionId: string): void {
    const controller = this.activeStreams.get(sessionId);
    if (controller) {
      controller.abort();
      logger.info({ sessionId }, '请求中断流式响应');
    }
  }

  /**
   * 检查指定 session 是否有活跃流
   */
  has(sessionId: string): boolean {
    return this.activeStreams.has(sessionId);
  }

  /**
   * 中断所有活跃流
   *
   * 用于应用退出时清理
   */
  abortAll(): void {
    for (const [sessionId, controller] of this.activeStreams) {
      controller.abort();
      logger.info({ sessionId }, '应用退出，中断流式响应');
    }
  }

  /**
   * 安全推送 IPC 事件
   *
   * 推送前检查 webContents.isDestroyed
   */
  private emit(
    webContents: WebContents,
    channel: IpcChannel,
    payload: unknown,
  ): void {
    if (webContents.isDestroyed()) {
      return;
    }
    webContents.send(channel, payload);
  }
}

/**
 * chunk 转字符串
 *
 * - string 直接返回
 * - 其他类型 JSON.stringify
 */
function chunkToString(chunk: unknown): string {
  if (typeof chunk === 'string') {
    return chunk;
  }
  return JSON.stringify(chunk);
}
```

- [ ] **Step 4: 运行测试，确认全部通过**

Run: `pnpm test:main`
Expected: `stream-bridge.test.ts` 5 个测试通过 + Phase 3b 前面 4 个 task 的测试 = 共 60+ 测试。

- [ ] **Step 5: 验证 typecheck + lint**

Run: `pnpm typecheck && pnpm lint`
Expected: 0 errors 0 warnings。

- [ ] **Step 6: Commit**

```bash
git add src/main/infra/ai/stream-bridge.ts src/main/__tests__/stream-bridge.test.ts
git commit -m "feat(ai): 流式响应 IPC 桥接与 AbortController 中断（§5.5）"
```

---

## Phase 3b 完成验收清单

- [ ] `pnpm install` 无错误无警告（openai 5 安装成功）
- [ ] `pnpm typecheck` 0 errors 0 warnings
- [ ] `pnpm lint` 0 errors 0 warnings
- [ ] `pnpm build` 三入口产物生成（不破坏 Phase 3a）
- [ ] `pnpm test` 全部测试通过（Phase 3a 77 + Phase 3b ≥27 = ≥104 测试）
- [ ] `pg-controller`：start/stop/health 探活 + crashed 事件 + SIGKILL 兜底
- [ ] `ollama-controller`：探活复用 / spawn 启动 / 模型拉取进度 / 崩溃重启
- [ ] `openai-client`：keychain 集成 + 单例缓存 + 显式 apiKey 覆盖
- [ ] `embedding-client`：指向本地 Ollama + embed() 便捷方法
- [ ] `stream-bridge`：迭代 AsyncIterable + AbortController + webContents.isDestroyed 检查
- [ ] git log 至少 5 个 Phase 3b commit
- [ ] 设计文档 §4.3 Infra 层职责全部覆盖（pg/ai 模块）

---

## 后续 Phase 预告

- **Phase 4**: 数据库 schema + Prisma client + migrations + AGE + HNSW + pg-installer（initdb + 扩展加载）
- **Phase 5**: Service 层（9 个 service，消费 @novel-writer/shared 的类型与 schema）
- **Phase 6**: IPC handlers + preload bridge
- **Phase 7**: Renderer 基础（路由、状态、UI 组件库）
- **Phase 8**: Renderer 业务页面
- **Phase 9**: 测试补全（E2E + 集成测试）
- **Phase 10**: 打包发布
