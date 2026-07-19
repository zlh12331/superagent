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

import { type ChildProcess, spawn } from 'node:child_process';
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
 *
 * - stopped：未启动或已停止
 * - starting：spawn 后等待端口就绪
 * - running：探活成功，可接收连接
 * - crashed：进程意外退出（非 0 退出码）
 * - stopping：收到 stop 请求，等待 exit
 */
export type OllamaStatus = 'stopped' | 'starting' | 'running' | 'crashed' | 'stopping';

/**
 * 模型拉取进度事件
 *
 * ollama pull 每行输出一个 JSON 对象，包含 status / completed / total
 */
export interface PullProgressEvent {
  /** 状态字符串（pulling / success 等） */
  readonly status: string;
  /** 已完成字节数 */
  readonly completed?: number;
  /** 总字节数 */
  readonly total?: number;
}

/**
 * 状态变更事件
 */
export interface OllamaStatusChangeEvent {
  /** 当前状态 */
  readonly status: OllamaStatus;
  /** 进程退出码（仅 crashed 状态有值） */
  readonly code?: number;
}

/**
 * 启动时探活最大重试次数
 *
 * Ollama 启动需要时间（加载模型），轮询 /api/tags
 */
const START_MAX_RETRIES = 30;

/**
 * 启动时探活间隔（毫秒）
 */
const START_RETRY_INTERVAL_MS = 1000;

/**
 * 停止超时（毫秒）
 *
 * SIGTERM 后等 5 秒，未退出则 SIGKILL
 */
const STOP_TIMEOUT_MS = 5000;

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
      logger.info(
        { host: this.config.host, port: this.config.port },
        'Ollama 已运行，复用现有进程',
      );
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
        // biome-ignore lint/style/useNamingConvention: OLLAMA_HOST 是 Ollama 官方环境变量名（大写下划线）
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

    // stdout/stderr 转发到日志
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
   * 优雅停止：SIGTERM → 等 5s → SIGKILL 兜底
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
   *
   * @throws AppError(ErrorCode.OLLAMA_NOT_RUNNING) API 不可达
   */
  private async fetchTags(): Promise<{ models?: Array<{ name: string }> }> {
    const response = await fetch(this.apiUrl('/api/tags'));
    if (!response.ok) {
      throw new AppError(
        ErrorCode.OLLAMA_NOT_RUNNING,
        `获取 Ollama 模型列表失败：${response.status}`,
      );
    }
    return response.json() as Promise<{ models?: Array<{ name: string }> }>;
  }

  /**
   * 等待 Ollama 健康就绪
   *
   * 每 retryIntervalMs 探活一次，最多重试 maxRetries 次
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
   *
   * 退避公式：2000 * 2^(restartCount-1)，即 2s / 4s / 8s
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
    // 指数退避：第 1 次重启等 2s，第 2 次 4s，第 3 次 8s
    const backoff = 2000 * 2 ** (this.restartCount - 1);
    logger.warn({ restartCount: this.restartCount, backoff }, 'Ollama 崩溃，准备重启');

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
