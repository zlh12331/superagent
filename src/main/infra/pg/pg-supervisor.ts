// src/main/infra/pg/pg-supervisor.ts
// PostgreSQL 子进程崩溃自愈管理器
// 设计文档 §7.8 PG 子进程健康监控 + §1.1 进程拓扑
//
// 职责：
// 1. 包装 PgController，对外暴露相同接口（start/stop/isHealthy/getStatus + EventEmitter）
// 2. 监听 PgController 的 crashed 事件，按指数退避自动重启
// 3. 重启期间状态为 'restarting'，状态变更透传给上层（status-broadcaster）
// 4. 重启全部失败后进入 'dead' 状态并广播
// 5. 用户主动 stop() 时不触发自动重启
//
// 指数退避策略（设计文档 §7.8）：
// - 第 1 次重启：等待 5s 后尝试
// - 第 2 次重启：等待 10s 后尝试
// - 第 3 次重启：等待 30s 后尝试
// - 3 次均失败 → 进入 'dead' 状态
//
// 注意：
// - 采用依赖注入：构造函数接受 PgController 实例，便于测试传入 mock
// - 透明转发 PgController 的所有 status-change 事件，并新增 'restarting' / 'dead'
// - 重启成功后 restartAttempts 重置为 0（避免单次崩溃累积到 dead）
// - 用户 stop() 时设置 isStopping 标记，避免触发重启
// - 重启期间调用 stop() 会取消等待中的 restart 定时器

import { EventEmitter } from 'node:events';
import { logger } from '../../utils/logger';
import type { PgController } from './pg-controller';
import type { PgStatus, PgStatusChangeEvent } from './pg-types';

/** 重启退避间隔（毫秒）：5s / 10s / 30s（设计文档 §7.8） */
const RESTART_BACKOFF_MS = [5_000, 10_000, 30_000] as const;

/** 最大重启次数（达到后进入 'dead' 状态） */
const MAX_RESTART_ATTEMPTS = RESTART_BACKOFF_MS.length;

/**
 * PostgreSQL 子进程崩溃自愈管理器
 *
 * 包装 PgController，在 PG 进程意外退出（crashed）时按指数退避自动重启。
 * 对外暴露与 PgController 相同的接口（start/stop/isHealthy/getStatus + EventEmitter），
 * 可直接替换 PgController 使用（db-init.ts / status-broadcaster.ts 无需改动业务逻辑）。
 *
 * @example
 * ```ts
 * const supervisor = new PgSupervisor(new PgController({ binaryPath, dataDir, port: 5433 }));
 * supervisor.on('status-change', (e) => logger.info({ e }, 'PG 状态变更'));
 * await supervisor.start();
 * // ... PG 运行中 ...
 * // 若 PG 进程意外退出 → supervisor 自动尝试重启 3 次
 * // 若全部失败 → 进入 'dead' 状态
 * await supervisor.stop();
 * ```
 */
export class PgSupervisor extends EventEmitter {
  /** 被包装的 PgController 实例（依赖注入，便于测试传入 mock） */
  private readonly controller: PgController;

  /** 当前 supervisor 状态（含 'restarting' / 'dead'，可能领先于 controller 状态） */
  private currentStatus: PgStatus = 'stopped';

  /** 用户主动 stop 时设置，避免触发自动重启 */
  private isStopping = false;

  /** 当前已尝试重启次数（重启成功后重置为 0） */
  private restartAttempts = 0;

  /** 等待中的重启定时器（用于 stop() 时取消） */
  private restartTimer: NodeJS.Timeout | null = null;

  /**
   * @param controller 被包装的 PgController 实例（依赖注入，便于测试传入 mock）
   */
  constructor(controller: PgController) {
    super();
    this.controller = controller;

    // 透传 controller 的 status-change 事件，并拦截 crashed 启动自动重启
    this.controller.on('status-change', (event: PgStatusChangeEvent) => {
      // 用户主动 stop 期间不触发自动重启
      // 注意：'crashed' 与 'stopped' 都可能是 stop 触发的（SIGTERM 后 exit code=0 走 stopped，非 0 走 crashed）
      if (this.isStopping) {
        this.currentStatus = event.status;
        this.emit('status-change', event);
        return;
      }

      // 非 stop 场景：正常透传
      this.currentStatus = event.status;
      this.emit('status-change', event);

      // crashed 后自动重启（仅在非 stop 场景触发）
      if (event.status === 'crashed') {
        void this.scheduleRestart();
      }
    });
  }

  /**
   * 启动 PG 子进程（首次启动）
   *
   * @throws AppError(PG_START_FAILED) 端口探活失败
   */
  async start(): Promise<void> {
    // 重置 stop 标记与重启计数（每次 start 视为全新启动）
    this.isStopping = false;
    this.restartAttempts = 0;
    this.currentStatus = 'starting';
    // start 由 controller 内部 setStatus('starting') 并 emit，supervisor 的 listener 会转发
    await this.controller.start();
  }

  /**
   * 停止 PG 子进程（用户主动停止）
   *
   * - 取消等待中的 restart 定时器（若有）
   * - 设置 isStopping 标记，避免 stop 期间触发自动重启
   * - 委托 controller.stop() 完成 SIGTERM → 5s → SIGKILL 流程
   */
  async stop(): Promise<void> {
    this.isStopping = true;

    // 取消等待中的重启定时器（如果在 restarting 状态被用户 stop）
    if (this.restartTimer !== null) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
      logger.info({}, 'PG 重启等待被用户 stop 取消');
    }

    await this.controller.stop();

    // stop 完成后重置标记（确保下次 start 不被污染）
    this.isStopping = false;
    this.restartAttempts = 0;
    this.currentStatus = 'stopped';
  }

  /**
   * 健康探活（委托 controller）
   */
  async isHealthy(): Promise<boolean> {
    return this.controller.isHealthy();
  }

  /**
   * 获取当前状态
   *
   * 注意：返回 supervisor 视角的状态，可能为 'restarting' / 'dead'
   * （controller 自身不感知这两个状态）
   */
  getStatus(): PgStatus {
    return this.currentStatus;
  }

  /**
   * 安排下一次重启尝试
   *
   * - 若已达到 MAX_RESTART_ATTEMPTS，进入 'dead' 状态并广播
   * - 否则等待 RESTART_BACKOFF_MS[attempts] ms 后调用 doRestart
   *
   * 注意：本方法仅在 crashed 后调用，restartAttempts 表示"即将进行的第 N 次尝试"
   */
  private scheduleRestart(): void {
    if (this.restartAttempts >= MAX_RESTART_ATTEMPTS) {
      logger.error(
        { attempts: this.restartAttempts },
        `PG 重启 ${MAX_RESTART_ATTEMPTS} 次均失败，进入 dead 状态`,
      );
      this.currentStatus = 'dead';
      this.emit('status-change', { status: 'dead' } satisfies PgStatusChangeEvent);
      return;
    }

    const delay = RESTART_BACKOFF_MS[this.restartAttempts];
    if (delay === undefined) {
      // 理论不可达（restartAttempts < MAX_RESTART_ATTEMPTS 时 backoff 一定有值）
      // TS noUncheckedIndexedAccess: true 下需要显式断言
      this.currentStatus = 'dead';
      this.emit('status-change', { status: 'dead' } satisfies PgStatusChangeEvent);
      return;
    }

    // attempts 在此处递增（即将进行第 attempts+1 次尝试）
    this.restartAttempts += 1;
    const attempt = this.restartAttempts;
    this.currentStatus = 'restarting';
    this.emit('status-change', { status: 'restarting', attempt } satisfies PgStatusChangeEvent);

    logger.warn({ attempt, delayMs: delay }, `PG 崩溃，${delay}ms 后尝试第 ${attempt} 次重启`);

    // setTimeout.unref() 让定时器不阻止 Node 退出（应用关闭时无需等待）
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      void this.doRestart();
    }, delay);
    this.restartTimer.unref();
  }

  /**
   * 执行一次重启尝试
   *
   * - 成功：重置 restartAttempts，状态由 controller.start() 内部 emit 'running' 透传
   * - 失败：递归调用 scheduleRestart 排下次尝试
   */
  private async doRestart(): Promise<void> {
    try {
      logger.info({ attempt: this.restartAttempts }, 'PG 重启尝试');
      // crashed 后 controller.child 已为 null，可直接 start
      // start 内部会 emit 'starting' → 'running'，supervisor 透传
      await this.controller.start();
      // 成功后重置 attempts，避免单次崩溃累积到 dead
      const recoveredAttempts = this.restartAttempts;
      this.restartAttempts = 0;
      logger.info({ recoveredAttempts }, 'PG 重启成功');
    } catch (err) {
      logger.error(
        {
          attempt: this.restartAttempts,
          error: err instanceof Error ? err.message : String(err),
        },
        'PG 重启尝试失败',
      );
      // 继续下一次重启（scheduleRestart 内部会判断是否达到上限）
      this.scheduleRestart();
    }
  }
}
