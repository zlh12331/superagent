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
//
// 阶段 2.5 交付（可驱动 Agent）：
// - 命令监听器返回 RemoteCommandResult { accepted, reply }：POST /command 同步等待
//   桥接执行完成后把结果文本随响应回传（局域网直连可接受分钟级长请求）
// - 活动计数（activeCommands / lastCommandAt）供设置面板展示执行状态
// - stop() 不清命令订阅：订阅是桥接层的结构性挂载（与配对话轮无关），
//   清掉会导致"关闭再开启"后命令被接收却无人执行
//
// 阶段 3 交付（增量回传 + 开箱可用客户端）：
// - POST /command 支持 SSE（请求头 Accept: text/event-stream）：回合内逐帧回推
//   hello / delta / tool / error，收尾以 end 携带完整 reply 与 reason。
//   不带该头的客户端仍是原同步 JSON 语义（向后兼容，移动端可按能力择一）
//   流式期间每 15s 发一次注释心跳，避免分钟级静默连接被客户端超时掐断；
//   不引入 ws 依赖（SSE 是 HTTP 上的既有语义，断线由客户端重连）
// - GET /：内置手机 Web 控制页（remote-web-client.ts），配对地址/二维码扫开即用
//   —— 令牌经 URL fragment 传入（浏览器不会随请求发往服务端），页面读后即焚
//
// 安全设计：
// - 会话令牌：每次 start 生成（移动端扫码/输码配对），命令路由前校验
// - 令牌永不通过发现公告 / /info 泄露
// - 命令体上限 64KB（防滥用）；未知路径 404
// - 命令执行复用 IM 桥接同款无头执行路径（AgentService.startAgent 无头 +
//   approvalMode 门控 + transcript 落库），不新开执行通道：
//   由 RemoteAgentBridge 订阅 onCommand 挂载执行器，本层只管校验与路由
// ──────────────────────────────────────────────────────────────

import { randomUUID } from 'node:crypto';
import { createSocket, type Socket as UdpSocket } from 'node:dgram';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { hostname } from 'node:os';
import { logger } from '../../utils/logger';
import { REMOTE_CLIENT_CSP, REMOTE_CLIENT_HTML } from './remote-web-client';

/** 发现公告服务标识（移动端按此过滤公告包） */
const DISCOVERY_SERVICE_TYPE = 'code-agent-remote';
/** 公告格式版本（移动端兼容判断） */
const DISCOVERY_PROTOCOL_VERSION = 1;
/** 命令请求体上限（字节） */
const MAX_COMMAND_BODY_BYTES = 64 * 1024;
/** SSE 保活注释帧间隔（回合可静默数分钟，需定期唤醒中间层与客户端超时） */
const SSE_HEARTBEAT_MS = 15_000;

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
 * 远程控制命令执行结果（桥接层 → 传输层 → 移动端响应）
 */
export interface RemoteCommandResult {
  /** 是否已被某个监听器接管执行 */
  readonly accepted: boolean;
  /** 回传给移动端的执行结果文本（未接管时可缺省） */
  readonly reply?: string;
  /** 回合结束原因（completed / aborted / max-steps / error / timeout；流式 end 帧携带） */
  readonly reason?: string;
}

/**
 * 回合增量事件（桥接层 → 传输层 → SSE 帧）
 *
 * 与 TurnEventType 的映射刻意收窄：远程控制面只需"正文在长、工具在跑、出错了"，
 * 内部事件（step 计数、usage、reasoning）不外泄给局域网客户端。
 */
export type RemoteTurnEvent =
  | { readonly type: 'delta'; readonly text: string }
  | { readonly type: 'tool'; readonly toolName: string }
  | { readonly type: 'error'; readonly message: string };

/**
 * 命令事件回推通道（监听器在回合执行中调用）
 *
 * 流式（SSE）请求下由传输层写入事件帧；非流式请求下为 noop ——
 * 监听器无需区分两种调用方式，同步语义只是丢弃增量、保留最终 reply。
 */
export type RemoteCommandEmitter = (event: RemoteTurnEvent) => void;

const NOOP_EMITTER: RemoteCommandEmitter = () => {};

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
 * - stop 可重入：未启动时 no-op；关闭 HTTP 监听与发现广播（不清 onCommand 订阅——
 *   订阅由桥接层生命周期管理，与配对话轮无关）
 * - onCommand 返回 unsubscribe（桥接层 unmount 调用；stop 不清理）
 * - 命令执行结果由桥接层回传（reply 字段随 HTTP 响应返回移动端）
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
  /** 实例名（发现公告展示名 = 主机名，配对界面标题用） */
  getInstanceName(): string;
  /** 命令执行活动（设置面板实时状态：执行中命令数 + 最近到达时间） */
  getActivity(): { activeCommands: number; lastCommandAt: number | null };
  /**
   * 订阅命令（移动端命令路由挂载点）
   *
   * 收到命令后先校验令牌：不匹配直接拒绝。
   * 匹配则依次调用监听器，首个 accepted=true 的监听器结果即为响应结果。
   * emit 用于回合内增量回传（流式请求写 SSE 帧；非流式请求为 noop）。
   */
  onCommand(
    handler: (command: RemoteCommand, emit: RemoteCommandEmitter) => Promise<RemoteCommandResult>,
  ): () => void;
  /**
   * 校验令牌并路由命令（传输层收到命令后调用）
   *
   * @param emit 增量事件通道；缺省为 noop（调用方只要最终 reply）
   * @returns accepted=true 表示已被监听器执行（含回传文本）；
   *          未启动 / 令牌不匹配 / 无监听器接管时 accepted=false
   */
  validateAndRoute(
    command: RemoteCommand,
    emit?: RemoteCommandEmitter,
  ): Promise<RemoteCommandResult>;
}

/**
 * 远程控制服务（阶段 2：HTTP 桥接 + UDP 局域网发现；阶段 2.5：命令执行结果回传）
 *
 * @example
 * ```ts
 * const token = await service.start();
 * service.onCommand(async (cmd) => bridge.execute(cmd)); // 返回 { accepted, reply }
 * ```
 */
export class RemoteControlService implements IRemoteControlService {
  private running = false;
  private sessionToken: string | null = null;
  private httpPort: number | null = null;
  /** 执行中命令数（监听器 in-flight 计数；面板状态展示） */
  private activeCommands = 0;
  /** 最近一次命令到达时间（当前配对话轮内） */
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
    // 新的配对话轮：活动计数归零（面板不残留上一轮的执行时间与在跑计数）
    this.activeCommands = 0;
    this.lastCommandAt = null;
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
    this.activeCommands = 0;
    // 不清 commandListeners：订阅是桥接层的结构性挂载（RemoteAgentBridge.unmount
    // 负责解除）。此处清空会导致"关闭再开启"后命令被接收却无人执行。
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

  /**
   * 校验令牌并路由命令（传输层收到命令后调用）
   *
   * @param emit 增量事件通道（流式请求写 SSE 帧；缺省 noop）
   * @returns 首个 accepted=true 的监听器结果；未启动/令牌不匹配/无人接管时 accepted=false
   */
  async validateAndRoute(
    command: RemoteCommand,
    emit?: RemoteCommandEmitter,
  ): Promise<RemoteCommandResult> {
    if (!this.running || this.sessionToken === null) {
      return { accepted: false };
    }
    if (command.sessionToken !== this.sessionToken) {
      logger.warn({ clientId: command.clientId }, '远程命令令牌不匹配，已拒绝');
      return { accepted: false };
    }
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

  /** HTTP 请求路由（/ 手机控制页 · /info 配对元数据 · /command 命令入口，其余 404） */
  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const done = (status: number, body: unknown): void => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const path = (req.url ?? '/').split('?')[0] ?? '/';
    if (req.method === 'GET' && path === '/') {
      // 手机控制页：纯静态，令牌由页面自身从 URL fragment 读取（fragment 不入服务端）
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
    if (req.method === 'POST' && path === '/command') {
      this.handleCommandRequest(req, res, done);
      return;
    }
    done(404, { error: 'not found' });
  }

  /** 命令请求处理：读体（64KB 上限）→ 解析 → 令牌校验 → 路由（JSON / SSE） */
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
      // 校验全部通过后才按客户端能力分流：SSE 边执行边回推，JSON 同步等结果
      if (wantsEventStream(req)) {
        this.routeAsStream(command, res);
        return;
      }
      // 同步等待桥接执行完成：结果文本随本响应回传（局域网直连，长请求可接受）
      void this.validateAndRoute(command).then((result) => {
        done(200, result);
      });
    });
    req.on('error', () => {
      // 客户端中断：响应已无意义，静默
    });
  }

  /**
   * 流式路由：SSE 响应头 + hello 帧 → 回合增量帧 → end 帧收尾
   *
   * 客户端断连后写入静默丢弃：回合不中断（无头执行与 transcript 落库在桥接层，
   * 与本次连接无关），重连后可在桌面端会话历史看到完整结果。
   */
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
      // data 单行 JSON：换行已在字符串内转义，无需 SSE 多行 data 折行
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    // 分钟级静默连接（长思考/长工具）易被客户端与代理判超时的保活注释帧
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

/** 客户端是否要求 SSE 流式回传（Accept 头协商；缺省走同步 JSON） */
function wantsEventStream(req: IncomingMessage): boolean {
  const accept = req.headers.accept;
  const value = Array.isArray(accept) ? accept.join(',') : accept;
  return typeof value === 'string' && value.includes('text/event-stream');
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
