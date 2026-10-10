// remote-control.ts：远程控制服务——HTTP 命令入口（token 鉴权 + SSE 事件流）+ UDP 局域网发现广播
// 边界：命令的业务执行在 RemoteAgentBridge（挂桥），本服务只管网络面/鉴权/频控
import { randomUUID } from 'node:crypto';
import { createSocket, type Socket as UdpSocket } from 'node:dgram';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { hostname } from 'node:os';
import type { RemoteBindScope } from '@code-agent/shared/main';
import { logger } from '../../utils/logger';
import { resolveBindAddress } from '../storage/remote-pref';
import { REMOTE_CLIENT_CSP, REMOTE_CLIENT_HTML } from './remote-web-client';

// 发现广播：UDP 45918 每 3s 一次全网段（仅 lan 范围），协议版本号防新旧客户端误配对
const DISCOVERY_SERVICE_TYPE = 'code-agent-remote';
const DISCOVERY_PROTOCOL_VERSION = 1;
// 命令体 64KB 上限（SSE 之外的另一面是防超大请求体占内存）
const MAX_COMMAND_BODY_BYTES = 64 * 1024;
const SSE_HEARTBEAT_MS = 15_000;

const DEFAULT_DISCOVERY_PORT = 45918;
const DEFAULT_BROADCAST_INTERVAL_MS = 3000;
const DEFAULT_BROADCAST_ADDRESS = '255.255.255.255';

// 鉴权频控：启动后 60s 窗口内失败 ≥10 次即封禁到重启（防在线爆破 session token）
const AUTH_WINDOW_MS = 60_000;
const AUTH_FAIL_LIMIT = 10;

/** 远程命令（渲染桥/移动端 web 客户端经 HTTP POST 提交） */
export interface RemoteCommand {
  readonly sessionToken: string;
  readonly text: string;
  readonly clientId: string;
}

export interface RemoteCommandResult {
  readonly accepted: boolean;
  readonly reply?: string;
  readonly reason?: string;
}

export type RemoteTurnEvent =
  | { readonly type: 'delta'; readonly text: string }
  | { readonly type: 'tool'; readonly toolName: string }
  | { readonly type: 'error'; readonly message: string };

export type RemoteCommandEmitter = (event: RemoteTurnEvent) => void;

const NOOP_EMITTER: RemoteCommandEmitter = () => {};

export interface RemoteControlOptions {
  readonly httpPort?: number;
  readonly bindScope?: RemoteBindScope;
  readonly discoveryPort?: number;
  readonly broadcastIntervalMs?: number;
  readonly broadcastAddress?: string;
  readonly instanceName?: string;
}

/** 远程控制服务契约（IPC handler 与 agent 桥共同消费） */
export interface IRemoteControlService {
  start(): Promise<string>;
  stop(): Promise<void>;
  isRunning(): boolean;
  getSessionToken(): string | null;
  getPort(): number | null;
  getBindScope(): RemoteBindScope;
  getBindAddress(): string | null;
  getInstanceName(): string;
  setBindScope(scope: RemoteBindScope): Promise<void>;
  getActivity(): { activeCommands: number; lastCommandAt: number | null };
  onCommand(
    handler: (command: RemoteCommand, emit: RemoteCommandEmitter) => Promise<RemoteCommandResult>,
  ): () => void;
  validateAndRoute(
    command: RemoteCommand,
    emit?: RemoteCommandEmitter,
  ): Promise<RemoteCommandResult>;
}

/** 远程控制服务：HTTP 命令入口 + UDP 发现广播的生命周期持有者 */
export class RemoteControlService implements IRemoteControlService {
  private running = false;
  private sessionToken: string | null = null;
  private bindScope: RemoteBindScope;
  private authWindowStartAt = 0;
  private authFailCount = 0;
  private httpPort: number | null = null;
  private bindAddress: string | null = null;
  private activeCommands = 0;
  private lastCommandAt: number | null = null;
  private readonly commandListeners = new Set<
    (command: RemoteCommand, emit: RemoteCommandEmitter) => Promise<RemoteCommandResult>
  >();

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
    this.bindScope = options.bindScope ?? 'lan';
    this.discoveryPort = options.discoveryPort ?? DEFAULT_DISCOVERY_PORT;
    this.broadcastIntervalMs = options.broadcastIntervalMs ?? DEFAULT_BROADCAST_INTERVAL_MS;
    this.broadcastAddress = options.broadcastAddress ?? DEFAULT_BROADCAST_ADDRESS;
    this.instanceName = options.instanceName ?? hostname();
  }

  /**
   * 启动服务：生成会话 token → HTTP 监听 → lan 范围加发发现广播
   *
   * @returns 会话 token（客户端配对凭证；重复 start 幂等返回现有 token）
   */
  async start(): Promise<string> {
    if (this.running) {
      return this.sessionToken ?? '';
    }
    this.sessionToken = randomUUID();
    this.activeCommands = 0;
    this.lastCommandAt = null;
    await this.startHttpServer();
    if (this.bindScope === 'lan') {
      this.startDiscovery();
    }
    this.running = true;
    logger.info(
      {
        port: this.httpPort,
        bindAddress: this.bindAddress,
        bindScope: this.bindScope,
        discoveryPort: this.bindScope === 'lan' ? this.discoveryPort : null,
      },
      this.bindScope === 'lan'
        ? '远程控制已启动（LAN 直连：HTTP 命令入口 + UDP 发现广播）'
        : '远程控制已启动（仅本机：HTTP 命令入口，无发现广播）',
    );
    return this.sessionToken;
  }

  async stop(): Promise<void> {
    await this.stopDiscovery();
    await this.stopHttpServer();
    this.running = false;
    this.sessionToken = null;
    this.activeCommands = 0;
    this.lastCommandAt = null;
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

  getBindScope(): RemoteBindScope {
    return this.bindScope;
  }

  getBindAddress(): string | null {
    return this.bindAddress;
  }

  async setBindScope(scope: RemoteBindScope): Promise<void> {
    if (scope === this.bindScope) {
      return;
    }
    if (!this.running) {
      this.bindScope = scope;
      logger.info({ scope }, '远程控制绑定范围已更新（未运行，下次启动生效）');
      return;
    }
    const previous: RemoteBindScope = this.bindScope;
    await this.stopDiscovery();
    await this.stopHttpServer();
    this.bindScope = scope;
    try {
      await this.startHttpServer();
      if (scope === 'lan') {
        this.startDiscovery();
      }
    } catch (err) {
      this.bindScope = previous;
      try {
        await this.startHttpServer();
        if (previous === 'lan') {
          this.startDiscovery();
        }
        logger.error({ error: err, scope: previous }, '远程控制绑定范围切换失败，已回滚到原范围');
      } catch (rollbackErr) {
        this.running = false;
        this.sessionToken = null;
        this.activeCommands = 0;
        this.lastCommandAt = null;
        logger.error({ error: rollbackErr }, '远程控制绑定范围切换回滚失败，服务已停止');
      }
      throw err;
    }
    logger.info(
      { scope, port: this.httpPort, bindAddress: this.bindAddress },
      '远程控制绑定范围已切换（监听按新地址重启）',
    );
  }

  getInstanceName(): string {
    return this.instanceName;
  }

  getActivity(): { activeCommands: number; lastCommandAt: number | null } {
    return { activeCommands: this.activeCommands, lastCommandAt: this.lastCommandAt };
  }

  onCommand(
    handler: (command: RemoteCommand, emit: RemoteCommandEmitter) => Promise<RemoteCommandResult>,
  ): () => void {
    this.commandListeners.add(handler);
    return () => {
      this.commandListeners.delete(handler);
    };
  }

  async validateAndRoute(
    command: RemoteCommand,
    emit?: RemoteCommandEmitter,
  ): Promise<RemoteCommandResult> {
    if (!this.running || this.sessionToken === null) {
      return { accepted: false };
    }
    const now = Date.now();
    if (now - this.authWindowStartAt > AUTH_WINDOW_MS) {
      this.authWindowStartAt = now;
      this.authFailCount = 0;
    }
    if (this.authFailCount >= AUTH_FAIL_LIMIT) {
      logger.warn({ clientId: command.clientId }, '远程命令认证失败次数超限，本窗口内拒绝');
      return { accepted: false };
    }
    if (command.sessionToken !== this.sessionToken) {
      this.authFailCount += 1;
      logger.warn(
        { clientId: command.clientId, failCount: this.authFailCount },
        '远程命令令牌不匹配，已拒绝',
      );
      return { accepted: false };
    }
    this.authFailCount = 0;
    const emitEvent = emit ?? NOOP_EMITTER;
    this.activeCommands += 1;
    this.lastCommandAt = Date.now();
    try {
      for (const listener of this.commandListeners) {
        try {
          const result = await listener(command, emitEvent);
          if (result.accepted) {
            return result;
          }
        } catch (err: unknown) {
          logger.error({ error: err }, '远程命令监听器异常');
        }
      }
      return { accepted: false };
    } finally {
      this.activeCommands -= 1;
    }
  }

  private async startHttpServer(): Promise<void> {
    const server = createServer((req, res) => {
      this.handleRequest(req, res);
    });
    server.on('clientError', (err, socket) => {
      logger.warn({ error: err.message }, '远程控制 HTTP client 错误');
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    });
    const bindAddress = resolveBindAddress(this.bindScope);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.httpPortOption, bindAddress, () => resolve());
    });
    server.on('error', (err: unknown) => {
      logger.error({ error: err }, '远程控制 HTTP 服务异常');
    });
    this.server = server;
    const address = server.address() as AddressInfo;
    this.httpPort = address.port;
    this.bindAddress = address.address;
  }

  private async stopDiscovery(): Promise<void> {
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
  }

  private async stopHttpServer(): Promise<void> {
    if (this.server !== null) {
      const server = this.server;
      this.server = null;
      this.httpPort = null;
      this.bindAddress = null;
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  }

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

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const done = (status: number, body: unknown): void => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const path = (req.url ?? '/').split('?')[0] ?? '/';
    if (req.method === 'GET' && path === '/') {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': REMOTE_CLIENT_CSP,
      });
      res.end(REMOTE_CLIENT_HTML);
      return;
    }
    if (req.method === 'GET' && path === '/info') {
      done(200, {
        service: DISCOVERY_SERVICE_TYPE,
        version: DISCOVERY_PROTOCOL_VERSION,
        name: this.instanceName,
        port: this.httpPort,
        requiresToken: true,
      });
      return;
    }
    if (req.method === 'POST' && path === '/command') {
      this.handleCommandRequest(req, res, done);
      return;
    }
    done(404, { error: 'not found' });
  }

  private handleCommandRequest(
    req: IncomingMessage,
    res: ServerResponse,
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
      if (wantsEventStream(req)) {
        this.routeAsStream(command, res);
        return;
      }
      void this.validateAndRoute(command).then((result) => {
        done(200, result);
      });
    });
    req.on('error', () => {});
  }

  private routeAsStream(command: RemoteCommand, res: ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
      Connection: 'keep-alive',
    });
    let closed = false;
    const write = (event: string, data: unknown): void => {
      if (closed || res.writableEnded) {
        return;
      }
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const heartbeat = setInterval(() => {
      if (!closed && !res.writableEnded) {
        res.write(': ping\n\n');
      }
    }, SSE_HEARTBEAT_MS);
    heartbeat.unref?.();
    res.on('close', () => {
      closed = true;
      clearInterval(heartbeat);
    });
    write('hello', { protocol: DISCOVERY_PROTOCOL_VERSION, clientId: command.clientId });
    void this.validateAndRoute(command, (event) => {
      write(event.type, event);
    }).then((result) => {
      write('end', result);
      clearInterval(heartbeat);
      if (!res.writableEnded) {
        res.end();
      }
    });
  }
}

function wantsEventStream(req: IncomingMessage): boolean {
  const accept = req.headers.accept;
  const value = Array.isArray(accept) ? accept.join(',') : accept;
  return typeof value === 'string' && value.includes('text/event-stream');
}

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
