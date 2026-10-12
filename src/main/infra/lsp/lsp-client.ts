// lsp-client.ts：单语言服务器客户端——stdio JSON-RPC（Content-Length 帧）、initialize 握手、
// 请求/通知收发。定义/引用/hover 三方法由上游组合
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { logger } from '../../utils/logger';
import { terminateChild } from '../../utils/terminate-child';

/** LSP 位置/区间/位置引用（uri 为 file:// 形态，与协议一致） */
export interface LspPosition {
  readonly line: number;
  readonly character: number;
}

export interface LspRange {
  readonly start: LspPosition;
  readonly end: LspPosition;
}

export interface LspLocation {
  readonly uri: string;
  readonly range: LspRange;
}

export interface LspDefinition extends LspLocation {}

export interface LspReference extends LspLocation {}

export interface LspHoverResult {
  readonly contents: string;
  readonly range?: LspRange;
}

/** 服务器启动配置（command 为 PATH 内可执行；timeoutMs 作用于单次请求等待） */
export interface LspServerConfig {
  readonly command: string;
  readonly args?: readonly string[];
  readonly rootUri: string;
  readonly timeoutMs?: number;
}

interface ResponseMessage {
  readonly jsonrpc: '2.0';
  readonly id: number;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string };
}

/**
 * LSP 客户端：按 id 配对请求/响应（pending 表），输入流按 Content-Length 分帧解析；
 * 请求级超时（默认 15s）防服务器卡死拖死调用方
 */
export class LspClient {
  private readonly command: string;
  private readonly args: readonly string[];
  private readonly rootUri: string;
  private readonly timeoutMs: number;
  private readonly loggerTag: string;

  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (r: unknown) => void; reject: (e: Error) => void }
  >();
  private readBuffer: Buffer = Buffer.alloc(0);
  private initialized = false;
  private disposed = false;

  constructor(config: LspServerConfig) {
    this.command = config.command;
    this.args = config.args ?? [];
    this.rootUri = config.rootUri;
    this.timeoutMs = config.timeoutMs ?? 15_000;
    this.loggerTag = `lsp:${this.command}`;
  }

  async initialize(): Promise<void> {
    if (this.disposed) {
      throw new Error(`${this.loggerTag} 已释放`);
    }
    if (this.child !== null) {
      return;
    }
    this.child = spawn(this.command, [...this.args], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.child.stderr.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: Buffer) => {
      this.readBuffer = Buffer.concat([this.readBuffer, chunk]);
      this.drainFrames();
    });
    this.child.stderr.on('data', (chunk: string) => {
      logger.debug({ tag: this.loggerTag, chunk: chunk.slice(0, 500) }, 'LSP stderr');
    });
    this.child.on('exit', (code, signal) => {
      const reason = `退出码 ${code ?? 'null'} 信号 ${signal ?? 'null'}`;
      this.failAllPending(new Error(`${this.loggerTag} 服务器退出：${reason}`));
      this.child = null;
    });
    this.child.on('error', (error: Error) => {
      logger.warn({ tag: this.loggerTag, error: error.message }, 'LSP 服务器启动失败');
      this.failAllPending(new Error(`${this.loggerTag} 服务器启动失败：${error.message}`));
      this.child = null;
    });

    await this.request('initialize', {
      processId: process.pid,
      rootUri: this.rootUri,
      capabilities: {},
    });
    this.notify('initialized', {});
    this.initialized = true;
    logger.info({ tag: this.loggerTag }, 'LSP 服务器初始化完成');
  }

  async definition(uri: string, position: LspPosition): Promise<LspDefinition[]> {
    this.ensureReady();
    const result = await this.request('textDocument/definition', {
      textDocument: { uri },
      position,
    });
    return normalizeLocations(result);
  }

  async references(uri: string, position: LspPosition): Promise<LspReference[]> {
    this.ensureReady();
    const result = await this.request('textDocument/references', {
      textDocument: { uri },
      position,
      context: { includeDeclaration: true },
    });
    return normalizeLocations(result);
  }

  async hover(uri: string, position: LspPosition): Promise<LspHoverResult | null> {
    this.ensureReady();
    const result = await this.request('textDocument/hover', {
      textDocument: { uri },
      position,
    });
    if (result === null || typeof result !== 'object') {
      return null;
    }
    const hover = result as { contents?: unknown; range?: LspRange };
    const contents = hoverString(hover.contents);
    if (contents === null) {
      return null;
    }
    return {
      contents,
      ...(hover.range !== undefined ? { range: hover.range } : {}),
    };
  }

  async requestRaw(method: string, params: unknown): Promise<unknown> {
    this.ensureReady();
    return this.request(method, params);
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    if (this.child !== null) {
      try {
        await this.request('shutdown', null);
      } catch {}
      this.notify('exit', null);
      await terminateChild(this.child, this.loggerTag);
      this.child = null;
    }
    this.failAllPending(new Error(`${this.loggerTag} 已释放`));
  }

  private ensureReady(): void {
    if (!this.initialized) {
      throw new Error(`${this.loggerTag} 未初始化（请先调用 initialize）`);
    }
    if (this.child === null) {
      throw new Error(`${this.loggerTag} 服务器不可用`);
    }
  }

  private request(method: string, params: unknown): Promise<unknown> {
    if (this.child === null) {
      return Promise.reject(new Error(`${this.loggerTag} 服务器未启动`));
    }
    const id = this.nextId;
    this.nextId += 1;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${this.loggerTag} 请求超时（${method}）`));
      }, this.timeoutMs);
      this.pending.set(id, {
        resolve: (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.writeFrame({
        jsonrpc: '2.0',
        id,
        method,
        ...(params !== null && params !== undefined ? { params } : {}),
      });
    });
  }

  private notify(method: string, params: unknown): void {
    this.writeFrame({
      jsonrpc: '2.0',
      method,
      ...(params !== null && params !== undefined ? { params } : {}),
    });
  }

  private writeFrame(message: object): void {
    if (this.child === null) {
      return;
    }
    const body = JSON.stringify(message);
    this.child.stdin.write(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`);
  }

  private drainFrames(): void {
    for (;;) {
      const headerEnd = this.readBuffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) {
        return;
      }
      const header = this.readBuffer.subarray(0, headerEnd).toString('utf8');
      const match = /Content-Length: (\d+)/i.exec(header);
      if (match === null) {
        this.readBuffer = this.readBuffer.subarray(headerEnd + 4);
        continue;
      }
      const length = Number(match[1]);
      const frameStart = headerEnd + 4;
      if (this.readBuffer.length < frameStart + length) {
        return;
      }
      const body = this.readBuffer.subarray(frameStart, frameStart + length).toString('utf8');
      this.readBuffer = this.readBuffer.subarray(frameStart + length);
      this.dispatchFrame(body);
    }
  }

  private dispatchFrame(body: string): void {
    let message: ResponseMessage;
    try {
      message = JSON.parse(body) as ResponseMessage;
    } catch {
      logger.warn({ tag: this.loggerTag, body: body.slice(0, 200) }, 'LSP 帧解析失败');
      return;
    }
    if (typeof message.id === 'number') {
      const entry = this.pending.get(message.id);
      if (entry === undefined) {
        return;
      }
      this.pending.delete(message.id);
      if (message.error !== undefined) {
        entry.reject(
          new Error(
            `${this.loggerTag} 请求错误（${message.error.code}）：${message.error.message}`,
          ),
        );
      } else {
        entry.resolve(message.result);
      }
    } else {
      logger.debug(
        {
          tag: this.loggerTag,
          method: (message as { method?: string }).method ?? message.id,
          body: body.slice(0, 300),
        },
        'LSP 通知',
      );
    }
  }

  private failAllPending(error: Error): void {
    for (const entry of this.pending.values()) {
      entry.reject(error);
    }
    this.pending.clear();
  }
}

function normalizeLocations(result: unknown): LspLocation[] {
  if (result === null || result === undefined) {
    return [];
  }
  if (Array.isArray(result)) {
    return result
      .filter((item): item is LspLocation => isLocation(item))
      .map((item) => ({ uri: item.uri, range: item.range }));
  }
  if (isLocation(result)) {
    return [{ uri: result.uri, range: result.range }];
  }
  return [];
}

function hoverString(contents: unknown): string | null {
  if (typeof contents === 'string') {
    return contents;
  }
  if (Array.isArray(contents)) {
    const parts = contents.map((item) => {
      if (typeof item === 'string') {
        return item;
      }
      if (
        typeof item === 'object' &&
        item !== null &&
        'value' in item &&
        typeof item.value === 'string'
      ) {
        return item.value;
      }
      return null;
    });
    const nonNull = parts.filter((p): p is string => p !== null);
    return nonNull.length > 0 ? nonNull.join('\n') : null;
  }
  if (
    typeof contents === 'object' &&
    contents !== null &&
    'value' in contents &&
    typeof contents.value === 'string'
  ) {
    return contents.value;
  }
  return null;
}

function isLocation(value: unknown): value is LspLocation {
  return (
    typeof value === 'object' &&
    value !== null &&
    'uri' in value &&
    typeof (value as { uri: unknown }).uri === 'string' &&
    'range' in value &&
    typeof (value as { range: unknown }).range === 'object'
  );
}
