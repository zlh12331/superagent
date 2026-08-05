// src/main/infra/lsp/lsp-server-manager.ts
// LSP 服务器管理器：按根目录懒加载 + 复用（对齐 qwen LspServerManager 语义收敛）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 根目录 → LspClient 的懒加载注册表（同一根目录复用同一语言服务器）
// - 并发安全：并发 getClient 共享同一初始化 Promise（防重复握手）
// - disposeAll：应用退出/切换工作区时统一释放
//
// 借鉴声明：
// 本模块参考 qwen-code 参考项目 packages/core/src/lsp/LspServerManager.ts
// （Copyright 2026 Qwen Team，SPDX-License-Identifier: Apache-2.0）的
// 多服务器编排语义，按我们的技术栈收敛重写：
// - 移除配置加载器/连接工厂（服务器命令由构造注入，配置走我们的 settings）
// - 保留核心语义：懒加载 + 复用 + 统一释放
// ──────────────────────────────────────────────────────────────

import { logger } from '../../utils/logger';
import { LspClient } from './lsp-client';

/** 语言服务器命令配置 */
export interface LspServerManagerOptions {
  /** 启动命令（缺省 typescript-language-server） */
  readonly command?: string;
  /** 启动参数（缺省 ['--stdio']） */
  readonly args?: readonly string[];
  /** 请求超时（毫秒） */
  readonly timeoutMs?: number;
}

/**
 * LSP 服务器管理器（可复用实例；按根目录复用语言服务器）
 */
export class LspServerManager {
  private readonly command: string;
  private readonly args: readonly string[];
  private readonly timeoutMs: number;
  private readonly clients = new Map<string, LspClient>();
  private readonly pending = new Map<string, Promise<LspClient>>();
  private disposed = false;

  constructor(options?: LspServerManagerOptions) {
    this.command = options?.command ?? 'typescript-language-server';
    this.args = options?.args ?? ['--stdio'];
    this.timeoutMs = options?.timeoutMs ?? 15_000;
  }

  /**
   * 获取（或懒启动）指定根目录的语言服务器
   *
   * 并发安全：并发调用共享同一初始化 Promise。
   */
  async getClient(rootUri: string): Promise<LspClient> {
    if (this.disposed) {
      throw new Error('LspServerManager 已释放');
    }
    const cached = this.clients.get(rootUri);
    if (cached !== undefined) {
      return cached;
    }
    const inFlight = this.pending.get(rootUri);
    if (inFlight !== undefined) {
      return inFlight;
    }
    const boot = this.boot(rootUri);
    this.pending.set(rootUri, boot);
    try {
      const client = await boot;
      this.clients.set(rootUri, client);
      return client;
    } finally {
      this.pending.delete(rootUri);
    }
  }

  /** 统一释放全部服务器（应用退出/工作区切换） */
  async disposeAll(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    const clients = [...this.clients.values()];
    this.clients.clear();
    await Promise.allSettled(clients.map((client) => client.dispose()));
    logger.info({ count: clients.length }, 'LSP 服务器全部释放');
  }

  /** 启动单个服务器（initialize 失败清理资源） */
  private async boot(rootUri: string): Promise<LspClient> {
    const client = new LspClient({
      command: this.command,
      args: this.args,
      rootUri,
      timeoutMs: this.timeoutMs,
    });
    try {
      await client.initialize();
      return client;
    } catch (err: unknown) {
      // 启动失败：释放半开资源，不缓存
      await client.dispose().catch(() => {});
      throw err;
    }
  }
}
