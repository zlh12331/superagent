// src/main/infra/remote/remote-control.ts
// 移动端远程控制预留（直连模式，不走云端）
// ──────────────────────────────────────────────────────────────
// 目标：移动端 App 通过局域网直连桌面端，远程驱动 Agent 执行。
// 设计约束（用户明确）：直连模式、不依赖云端中继。
//
// 本轮交付（架构预留，非完整实现）：
// - IRemoteControlService 接口：会话令牌 / 本地监听 / 命令路由
// - RemoteControlService 骨架：状态机 + 令牌生成 + 命令挂载点
// - 网络传输层（WebSocket/HTTP 监听）与移动端客户端为后续阶段：
//   接口已就位，实现时只需填充 start() 内部（监听 + 握手鉴权）
//
// 安全设计：
// - 会话令牌：每次 start 生成（移动端扫码/输码配对），命令路由前校验
// - 命令执行复用 IM 桥接的无头执行路径（approvalMode 受控），不新开执行通道
// ──────────────────────────────────────────────────────────────

import { randomUUID } from 'node:crypto';
import { logger } from '../../utils/logger';

/**
 * 远程控制命令（移动端 → 桌面端）
 */
export interface RemoteCommand {
  /** 会话令牌（配对时生成，命令路由前校验） */
  readonly sessionToken: string;
  /** 命令文本（如："查看当前项目状态" / "执行 pnpm test"） */
  readonly text: string;
  /** 客户端标识（移动端设备名等） */
  readonly clientId: string;
}

/**
 * 远程控制服务接口（移动端直连预留）
 *
 * 实现约定：
 * - start 幂等：重复调用返回已启动状态；令牌每次启动重新生成
 * - stop 可重入：未启动时 no-op
 * - onCommand 返回 unsubscribe；stop 时自动清理
 * - 命令执行结果由调用方（桥接层）回发，本层只管路由
 */
export interface IRemoteControlService {
  /** 启动本地监听（LAN 直连），返回本次会话令牌 */
  start(): Promise<string>;
  /** 停止监听（可重入） */
  stop(): Promise<void>;
  /** 是否运行中 */
  isRunning(): boolean;
  /** 当前会话令牌（未启动为 null） */
  getSessionToken(): string | null;
  /**
   * 订阅命令（移动端命令路由挂载点）
   *
   * 收到命令后先校验令牌：不匹配直接拒绝（返回 false）。
   * 匹配则调用监听器；监听器返回 true 表示已处理。
   */
  onCommand(handler: (command: RemoteCommand) => Promise<boolean>): () => void;
}

/**
 * 远程控制服务（骨架实现）
 *
 * 传输层未实现：start() 当前仅生成令牌 + 置运行态。
 * 后续接入 WebSocket/HTTP 监听时，在 start() 内启动服务并
 * 将收到的命令经 validateAndRoute 分发。
 */
export class RemoteControlService implements IRemoteControlService {
  private running = false;
  private sessionToken: string | null = null;
  private readonly commandListeners = new Set<(command: RemoteCommand) => Promise<boolean>>();

  async start(): Promise<string> {
    if (this.running) {
      return this.sessionToken ?? '';
    }
    this.running = true;
    this.sessionToken = randomUUID();
    logger.info({ sessionToken: this.sessionToken.slice(0, 8) }, '远程控制已启动（直连模式）');
    // TODO(2026-08-11)：阶段 2——启动远程控制服务（WebSocket/HTTP 桥接，LAN 直连 + 局域网发现）
    return this.sessionToken;
  }

  async stop(): Promise<void> {
    this.running = false;
    this.sessionToken = null;
    this.commandListeners.clear();
    logger.info({}, '远程控制已停止');
  }

  isRunning(): boolean {
    return this.running;
  }

  getSessionToken(): string | null {
    return this.sessionToken;
  }

  onCommand(handler: (command: RemoteCommand) => Promise<boolean>): () => void {
    this.commandListeners.add(handler);
    return () => {
      this.commandListeners.delete(handler);
    };
  }

  /**
   * 校验令牌并路由命令（传输层收到命令后调用）
   *
   * @returns true = 已处理；false = 令牌不匹配或监听器均未处理
   */
  async validateAndRoute(command: RemoteCommand): Promise<boolean> {
    if (!this.running || this.sessionToken === null) {
      return false;
    }
    if (command.sessionToken !== this.sessionToken) {
      logger.warn({ clientId: command.clientId }, '远程命令令牌不匹配，已拒绝');
      return false;
    }
    let handled = false;
    for (const listener of this.commandListeners) {
      try {
        if (await listener(command)) {
          handled = true;
        }
      } catch (err: unknown) {
        logger.error({ error: err }, '远程命令监听器异常');
      }
    }
    return handled;
  }
}
