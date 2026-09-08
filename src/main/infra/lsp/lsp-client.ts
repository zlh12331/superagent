// src/main/infra/lsp/lsp-client.ts
// LSP 客户端：JSON-RPC over stdio（对齐 qwen NativeLspClient 语义收敛）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 语言服务器进程管理（spawn / shutdown / dispose）
// - JSON-RPC 2.0 帧编解码（Content-Length 头）+ 请求-响应 id 匹配 + 超时
// - 代码智能请求：definition / references / hover（对齐 qwen LspDefinition/LspReference/LspHoverResult）
//
// 借鉴声明：
// 本模块参考 qwen-code 参考项目 packages/core/src/lsp/
// （Copyright 2026 Qwen Team，SPDX-License-Identifier: Apache-2.0）的
// NativeLspClient（原生 LSP 客户端）语义，按我们的技术栈收敛重写：
// - 移除 vscode-languageserver-protocol 依赖（自写 JSON-RPC 帧，零依赖）
// - 移除连接工厂/服务器管理（多服务器编排由调用方负责；本模块单服务器）
// - 保留核心方法：initialize / definition / references / hover
// ──────────────────────────────────────────────────────────────

import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { logger } from '../../utils/logger';
import { terminateChild } from '../../utils/terminate-child';

/** LSP 位置（行/列均 0 基） */
export interface LspPosition {
  readonly line: number;
  readonly character: number;
}

/** LSP 范围 */
export interface LspRange {
  readonly start: LspPosition;
  readonly end: LspPosition;
}

/** LSP 位置引用（定义/引用统一收敛） */
export interface LspLocation {
  readonly uri: string;
  readonly range: LspRange;
}

/** 定义结果 */
export interface LspDefinition extends LspLocation {}

/** 引用结果 */
export interface LspReference extends LspLocation {}

/** 悬停结果 */
export interface LspHoverResult {
  readonly contents: string;
  readonly range?: LspRange;
}

/** LSP 服务器配置 */
export interface LspServerConfig {
  /** 启动命令（如 typescript-language-server） */
  readonly command: string;
  /** 启动参数（如 ['--stdio']） */
  readonly args?: readonly string[];
  /** 初始化根目录（file:// URI） */
  readonly rootUri: string;
  /** 请求超时（毫秒，默认 15s） */
  readonly timeoutMs?: number;
}

/** 响应消息 */
interface ResponseMessage {
  readonly jsonrpc: '2.0';
  readonly id: number;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string };
}

/**
 * LSP 客户端（单语言服务器；调用方负责生命周期）
 *
 * 用法：new LspClient(config) → initialize() → definition/references/hover → dispose()
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

  /**
   * 启动服务器并完成 initialize 握手
   *
   * @throws 启动失败/握手超时/服务器退出
   */
  async initialize(): Promise<void> {
    if (this.disposed) {
      throw new Error(`${this.loggerTag} 已释放`);
    }
    if (this.child !== null) {
      return; // 幂等
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
    // spawn 失败（命令不存在等）：error 事件而非 exit，需单独处理
    this.child.on('error', (error: Error) => {
      logger.warn({ tag: this.loggerTag, error: error.message }, 'LSP 服务器启动失败');
      this.failAllPending(new Error(`${this.loggerTag} 服务器启动失败：${error.message}`));
      this.child = null;
    });

    // initialize 握手
    await this.request('initialize', {
      processId: process.pid,
      rootUri: this.rootUri,
      capabilities: {},
    });
    // initialized 通知（无响应）
    this.notify('initialized', {});
    this.initialized = true;
    logger.info({ tag: this.loggerTag }, 'LSP 服务器初始化完成');
  }

  /** 文本定义（跳转声明位置） */
  async definition(uri: string, position: LspPosition): Promise<LspDefinition[]> {
    this.ensureReady();
    const result = await this.request('textDocument/definition', {
      textDocument: { uri },
      position,
    });
    return normalizeLocations(result);
  }

  /** 文本引用（查找所有引用位置） */
  async references(uri: string, position: LspPosition): Promise<LspReference[]> {
    this.ensureReady();
    const result = await this.request('textDocument/references', {
      textDocument: { uri },
      position,
      context: { includeDeclaration: true },
    });
    return normalizeLocations(result);
  }

  /** 悬停信息 */
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

  /**
   * 原始 JSON-RPC 请求（扩展方法用；返回服务器原始 result）
   *
   * 用于未封装的方法（如 textDocument/documentSymbol、workspace/symbol）。
   */
  async requestRaw(method: string, params: unknown): Promise<unknown> {
    this.ensureReady();
    return this.request(method, params);
  }

  /** 关闭服务器（shutdown + exit 通知） */
  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    if (this.child !== null) {
      try {
        await this.request('shutdown', null);
      } catch {
        // shutdown 失败不阻断清理
      }
      this.notify('exit', null);
      // 2026-09-08 可靠性修复：SIGTERM → 3s SIGKILL 升级（此前只发一次 SIGTERM，
      // 语言服务器忽略信号时会残留句柄，Electron 延迟退出）
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

  /** 请求-响应（带超时；未决表 id 匹配） */
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

  /** 通知（无响应） */
  private notify(method: string, params: unknown): void {
    this.writeFrame({
      jsonrpc: '2.0',
      method,
      ...(params !== null && params !== undefined ? { params } : {}),
    });
  }

  /** Content-Length 帧写入 */
  private writeFrame(message: object): void {
    if (this.child === null) {
      return;
    }
    const body = JSON.stringify(message);
    this.child.stdin.write(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`);
  }

  /** 缓冲解析：按 Content-Length 切帧并分派响应 */
  private drainFrames(): void {
    for (;;) {
      const headerEnd = this.readBuffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) {
        return;
      }
      const header = this.readBuffer.subarray(0, headerEnd).toString('utf8');
      const match = /Content-Length: (\d+)/i.exec(header);
      if (match === null) {
        // 头损坏：丢弃该帧头
        this.readBuffer = this.readBuffer.subarray(headerEnd + 4);
        continue;
      }
      const length = Number(match[1]);
      const frameStart = headerEnd + 4;
      if (this.readBuffer.length < frameStart + length) {
        return; // 帧未收全（按字节）
      }
      const body = this.readBuffer.subarray(frameStart, frameStart + length).toString('utf8');
      this.readBuffer = this.readBuffer.subarray(frameStart + length);
      this.dispatchFrame(body);
    }
  }

  /** 帧分派：响应匹配未决表；服务器通知记录 */
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
      // 服务器主动通知（window/logMessage 等）：记录日志
      // 通知帧无 id；method 在请求体字段（ResponseMessage 类型不含，需类型扩展）
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

  /** 服务器退出：拒绝全部未决请求 */
  private failAllPending(error: Error): void {
    for (const entry of this.pending.values()) {
      entry.reject(error);
    }
    this.pending.clear();
  }
}

/** LSP 位置结果归一化：单对象或数组 → 数组 */
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

/** 悬停内容归一化：string | MarkedString | MarkedString[] → string */
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

/** Location 形状判定（弱耦合纯函数） */
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
