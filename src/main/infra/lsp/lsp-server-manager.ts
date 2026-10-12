// lsp-server-manager.ts：语言服务器生命周期管理——按 (rootUri, language) 缓存客户端，
// 并发请求共享同一启动 Promise（防重复 spawn）；退出全量回收
import { logger } from '../../utils/logger';
import type { LsLanguage, LsServerSpec } from './ls-config';
import { languageForFile, SUPPORTED_LS_LANGUAGES, serverSpecForLanguage } from './ls-config';
import { LspClient } from './lsp-client';

/** 管理器选项：服务器规格覆盖（用户配置）与请求超时 */
export interface LspServerManagerOptions {
  readonly serverOverrides?: Readonly<Record<string, LsServerSpec>>;
  readonly timeoutMs?: number;
}

/** 按根目录 × 语言维度的 LSP 客户端池 */
export class LspServerManager {
  private readonly serverOverrides: Readonly<Record<string, LsServerSpec>>;
  private readonly timeoutMs: number;

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
   * 取（或启动）对应语言服务器客户端：缓存命中即用，未命中启动并缓存；
   * 并发调用合并到同一 boot Promise
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
