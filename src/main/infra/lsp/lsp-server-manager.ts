// （Copyright 2026 Qwen Team，SPDX-License-Identifier: Apache-2.0）的

import { logger } from '../../utils/logger';
import type { LsLanguage, LsServerSpec } from './ls-config';
import { languageForFile, SUPPORTED_LS_LANGUAGES, serverSpecForLanguage } from './ls-config';
import { LspClient } from './lsp-client';

/** 语言服务器管理器选项 */
export interface LspServerManagerOptions {
  /** 按语言覆盖服务器启动规格（结构化；来自设置 lsp.serverCommands 经 parseServerCommand 转换） */
  readonly serverOverrides?: Readonly<Record<string, LsServerSpec>>;
  /** 请求超时（毫秒） */
  readonly timeoutMs?: number;
}

/**
 * LSP 服务器管理器（可复用实例；按 根目录×语言 复用语言服务器）
 */
export class LspServerManager {
  private readonly serverOverrides: Readonly<Record<string, LsServerSpec>>;
  private readonly timeoutMs: number;

  /**
   * 客户端构造器（DI 注入点：测试传 fake，生产默认 LspClient）
   * 注入而非 mock：外部依赖可替换，业务逻辑保持真实实现
   */
  private readonly clientCtor: typeof LspClient;

  private readonly clients = new Map<string, LspClient>();
  private readonly pending = new Map<string, Promise<LspClient>>();
  private disposed = false;

  constructor(options?: LspServerManagerOptions & { lspClientCtor?: typeof LspClient }) {
    this.serverOverrides = options?.serverOverrides ?? {};
    this.timeoutMs = options?.timeoutMs ?? 15_000;
    this.clientCtor = options?.lspClientCtor ?? LspClient;
  }

  /**
   * 获取（或懒启动）指定根目录与文件语言的服务器
   *
   * 语言由 filePath 扩展名决定；同一根目录下不同语言各自独立客户端。
   * 并发安全：并发调用共享同一初始化 Promise。
   *
   * @param rootUri 工作区根目录（file:// URI）
   * @param filePath 目标文件绝对路径（扩展名 → 语言路由）
   * @throws 文件类型未收录 / 已释放 / 启动失败
   */
  async getClient(rootUri: string, filePath: string): Promise<LspClient> {
    if (this.disposed) {
      throw new Error('LspServerManager 已释放');
    }
    const language = languageForFile(filePath);
    if (language === undefined) {
      throw new Error(
        `不支持的文件类型：${filePath}（已注册语言服务器：${SUPPORTED_LS_LANGUAGES.join('/')}）`,
      );
    }
    const cacheKey = `${rootUri}::${language}`;
    const cached = this.clients.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }
    const inFlight = this.pending.get(cacheKey);
    if (inFlight !== undefined) {
      return inFlight;
    }
    const boot = this.boot(rootUri, language);
    this.pending.set(cacheKey, boot);
    try {
      const client = await boot;
      if (this.disposed) {
        await client.dispose().catch(() => {});
        throw new Error('LspServerManager 已释放');
      }
      this.clients.set(cacheKey, client);
      return client;
    } finally {
      this.pending.delete(cacheKey);
    }
  }

  /** 统一释放全部服务器（应用退出/工作区切换） */
  async disposeAll(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    const pendingBoots = [...this.pending.values()];
    if (pendingBoots.length > 0) {
      await Promise.allSettled(pendingBoots);
    }
    const clients = [...this.clients.values()];
    this.clients.clear();
    await Promise.allSettled(clients.map((client) => client.dispose()));
    logger.info({ count: clients.length }, 'LSP 服务器全部释放');
  }

  /** 启动单个服务器（initialize 失败清理资源） */
  private async boot(rootUri: string, language: LsLanguage): Promise<LspClient> {
    const spec = serverSpecForLanguage(language, this.serverOverrides);
    const client = new this.clientCtor({
      command: spec.command,
      args: spec.args,
      rootUri,
      timeoutMs: this.timeoutMs,
    });
    try {
      await client.initialize();
      return client;
    } catch (err: unknown) {
      await client.dispose().catch(() => {});
      throw err;
    }
  }
}
