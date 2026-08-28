// src/main/infra/remote/remote-control.ts
// 移动端远程控制（直连模式，不走云端）
// ──────────────────────────────────────────────────────────────
// 目标：移动端 App 通过局域网直连桌面端，远程驱动 Agent 执行。
// 设计约束（用户明确）：直连模式、不依赖云端中继。
//
// 阶段 2 交付（传输层落地）：
// - HTTP 桥接（node:http，零新依赖）：
//   · POST /command——命令入口，JSON body { sessionToken, text, clientId }，
//     令牌校验后经 validateAndRoute 路由（503 未启动 / 403 令牌不匹配 / 400 参数无效）
//   · GET /info——配对元数据（服务标识 / 实例名 / 端口，不含令牌）
// - 局域网发现（node:dgram UDP 广播）：运行中按间隔向 {broadcastAddress}:{discoveryPort}
//   广播公告 { service, version, name, port, protocol }（不含令牌）；
//   移动端在发现端口监听公告即可拿到直连地址
// - WebSocket 流式回推为后续阶段（需引入 ws 依赖，随移动端客户端一起评估）
//
// 安全设计：
// - 会话令牌：每次 start 生成（移动端扫码/输码配对），命令路由前校验
// - 令牌永不通过发现公告 / /info 泄露
// - 命令体上限 64KB（防滥用）；未知路径 404
// - 命令执行复用 IM 桥接的无头执行路径（approvalMode 受控），不新开执行通道：
//   由桥接层订阅 onCommand 挂载执行器，本层只管校验与路由
// ──────────────────────────────────────────────────────────────

import { randomUUID } from 'node:crypto';
import { createSocket, type Socket as UdpSocket } from 'node:dgram';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { hostname } from 'node:os';
import { logger } from '../../utils/logger';

/** 发现公告服务标识（移动端按此过滤公告包） */
const DISCOVERY_SERVICE_TYPE = 'code-agent-remote';
/** 公告格式版本（移动端兼容判断） */
const DISCOVERY_PROTOCOL_VERSION = 1;
/** 命令请求体上限（字节） */
const MAX_COMMAND_BODY_BYTES = 64 * 1024;

/** 发现广播默认参数：全网广播 + 常规间隔（生产默认；测试注入单播与短间隔） */
const DEFAULT_DISCOVERY_PORT = 45918;
const DEFAULT_BROADCAST_INTERVAL_MS = 3000;
const DEFAULT_BROADCAST_ADDRESS = '255.255.255.255';

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
 * 远程控制服务构造参数（测试注入用；生产全部走默认值）
 */
export interface RemoteControlOptions {
  /** HTTP 监听端口（默认 0 = 随机端口，经发现公告/配对界面告知） */
  readonly httpPort?: number;
  /** UDP 发现公告端口（移动端监听端口） */
  readonly discoveryPort?: number;
  /** 公告广播间隔毫秒数 */
  readonly broadcastIntervalMs?: number;
  /** 公告目标地址（默认全网广播 255.255.255.255；测试注入 127.0.0.1 单播） */
  readonly broadcastAddress?: string;
  /** 实例名（公告展示名，默认主机名） */
  readonly instanceName?: string;
}

/**
 * 远程控制服务接口（移动端直连）
 *
 * 实现约定：
 * - start 幂等：重复调用返回已启动状态；令牌每次启动重新生成
 * - stop 可重入：未启动时 no-op；关闭 HTTP 监听与发现广播
 * - onCommand 返回 unsubscribe；stop 时自动清理
 * - 命令执行结果由调用方（桥接层）回发，本层只管校验与路由
 */
export interface IRemoteControlService {
  /** 启动 HTTP 监听 + 发现广播（LAN 直连），返回本次会话令牌 */
  start(): Promise<string>;
  /** 停止监听与广播（可重入） */
  stop(): Promise<void>;
  /** 是否运行中 */
  isRunning(): boolean;
  /** 当前会话令牌（未启动为 null） */
  getSessionToken(): string | null;
  /** HTTP 监听端口（未启动为 null；配对二维码 / 手动输入展示用） */
  getPort(): number | null;
  /**
   * 订阅命令（移动端命令路由挂载点）
   *
   * 收到命令后先校验令牌：不匹配直接拒绝（返回 false）。
   * 匹配则调用监听器；监听器返回 true 表示已处理。
   */
  onCommand(handler: (command: RemoteCommand) => Promise<boolean>): () => void;
}

/**
 * 远程控制服务（阶段 2：HTTP 桥接 + UDP 局域网发现）
 *
 * @example
 * ```ts
 * const token = await service.start();
 * service.onCommand(async (cmd) => bridge.execute(cmd));
 * ```
 */
export class RemoteControlService implements IRemoteControlService {
  private running = false;
  private sessionToken: string | null = null;
  private httpPort: number | null = null;
  private readonly commandListeners = new Set<(command: RemoteCommand) => Promise<boolean>>();

  private readonly httpPortOption: number;
  private readonly discoveryPort: number;
  private readonly broadcastIntervalMs: number;
  private readonly broadcastAddress: string;
  private readonly instanceName: string;

  private server: Server | null = null;
  private discoverySocket: UdpSocket | null = null;
  private broadcastTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: RemoteControlOptions = {}) {
    this.httpPortOption = options.httpPort ?? 0;
    this.discoveryPort = options.discoveryPort ?? DEFAULT_DISCOVERY_PORT;
    this.broadcastIntervalMs = options.broadcastIntervalMs ?? DEFAULT_BROADCAST_INTERVAL_MS;
    this.broadcastAddress = options.broadcastAddress ?? DEFAULT_BROADCAST_ADDRESS;
    this.instanceName = options.instanceName ?? hostname();
  }

  async start(): Promise<string> {
    if (this.running) {
      return this.sessionToken ?? '';
    }
    this.sessionToken = randomUUID();
    await this.startHttpServer();
    this.startDiscovery();
    this.running = true;
    logger.info(
      { port: this.httpPort, discoveryPort: this.discoveryPort },
      '远程控制已启动（LAN 直连：HTTP 命令入口 + UDP 发现广播）',
    );
    return this.sessionToken;
  }

  async stop(): Promise<void> {
    if (this.broadcastTimer !== null) {
      clearInterval(this.broadcastTimer);
      this.broadcastTimer = null;
    }
    if (this.discoverySocket !== null) {
      const socket = this.discoverySocket;
      this.discoverySocket = null;
      await new Promise<void>((resolve) => {
        socket.close(() => resolve());
      });
    }
    if (this.server !== null) {
      const server = this.server;
      this.server = null;
      this.httpPort = null;
      // keep-alive 连接不阻塞关闭（fetch 等客户端连接残留）
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
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

  getPort(): number | null {
    return this.httpPort;
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

  /** 启动 HTTP 命令入口（0.0.0.0，端口缺省随机） */
  private async startHttpServer(): Promise<void> {
    const server = createServer((req, res) => {
      this.handleRequest(req, res);
    });
    server.on('clientError', (err, socket) => {
      logger.warn({ error: err.message }, '远程控制 HTTP client 错误');
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.httpPortOption, '0.0.0.0', () => resolve());
    });
    server.on('error', (err: unknown) => {
      logger.error({ error: err }, '远程控制 HTTP 服务异常');
    });
    this.server = server;
    this.httpPort = (server.address() as AddressInfo).port;
  }

  /** 启动 UDP 发现广播（绑定失败降级为仅 HTTP 直连，不阻断启动） */
  private startDiscovery(): void {
    const socket = createSocket({ type: 'udp4', reuseAddr: true });
    socket.on('error', (err: unknown) => {
      logger.warn({ error: err }, '远程控制发现广播异常（HTTP 直连不受影响）');
    });
    socket.bind(() => {
      try {
        socket.setBroadcast(true);
      } catch (err: unknown) {
        logger.warn({ error: err }, '远程控制广播开启失败（降级单播/直连）');
      }
      const announce = (): void => {
        const payload = JSON.stringify({
          service: DISCOVERY_SERVICE_TYPE,
          version: DISCOVERY_PROTOCOL_VERSION,
          name: this.instanceName,
          port: this.httpPort,
          protocol: 'http',
        });
        socket.send(payload, this.discoveryPort, this.broadcastAddress);
      };
      announce();
      this.broadcastTimer = setInterval(announce, this.broadcastIntervalMs);
    });
    this.discoverySocket = socket;
  }

  /** HTTP 请求路由（仅 /info 与 /command，其余 404） */
  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const done = (status: number, body: unknown): void => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'GET' && req.url === '/info') {
      // 配对元数据：不含令牌（令牌仅经用户显式配对动作分发）
      done(200, {
        service: DISCOVERY_SERVICE_TYPE,
        version: DISCOVERY_PROTOCOL_VERSION,
        name: this.instanceName,
        port: this.httpPort,
        requiresToken: true,
      });
      return;
    }
    if (req.method === 'POST' && req.url === '/command') {
      this.handleCommandRequest(req, done);
      return;
    }
    done(404, { error: 'not found' });
  }

  /** 命令请求处理：读体（64KB 上限）→ 解析 → 令牌校验 → 路由 */
  private handleCommandRequest(
    req: IncomingMessage,
    done: (status: number, body: unknown) => void,
  ): void {
    const chunks: Buffer[] = [];
    let size = 0;
    let oversized = false;
    req.on('data', (chunk: Buffer) => {
      if (oversized) {
        return;
      }
      size += chunk.length;
      if (size > MAX_COMMAND_BODY_BYTES) {
        oversized = true;
        done(413, { error: 'payload too large' });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (oversized) {
        return;
      }
      if (!this.running) {
        done(503, { error: 'remote control not running' });
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        done(400, { error: 'invalid json' });
        return;
      }
      const command = parseRemoteCommand(parsed);
      if (command === null) {
        done(400, { error: 'invalid command' });
        return;
      }
      if (this.sessionToken === null || command.sessionToken !== this.sessionToken) {
        logger.warn({ clientId: command.clientId }, '远程命令令牌不匹配，已拒绝');
        done(403, { error: 'forbidden' });
        return;
      }
      void this.validateAndRoute(command).then((accepted) => {
        done(200, { accepted });
      });
    });
    req.on('error', () => {
      // 客户端中断：响应已无意义，静默
    });
  }
}

/** 命令体结构校验（系统边界：外部客户端输入，逐字段校验） */
function parseRemoteCommand(parsed: unknown): RemoteCommand | null {
  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }
  const { sessionToken, text, clientId } = parsed as Record<string, unknown>;
  if (
    typeof sessionToken !== 'string' ||
    sessionToken.length === 0 ||
    typeof text !== 'string' ||
    text.trim().length === 0 ||
    text.length > 8192 ||
    typeof clientId !== 'string' ||
    clientId.length === 0 ||
    clientId.length > 128
  ) {
    return null;
  }
  return { sessionToken, text, clientId };
}
