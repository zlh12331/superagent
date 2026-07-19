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

import { type ChildProcess, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createConnection, type Socket } from 'node:net';
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
        // biome-ignore lint/style/useNamingConvention: PGPORT 是 PostgreSQL 官方环境变量名（大写下划线）
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

    // child.pid 类型为 number | undefined，exactOptionalPropertyTypes 下需过滤 undefined
    const pid = child.pid;
    this.setStatus('running', pid !== undefined ? { pid } : {});
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
