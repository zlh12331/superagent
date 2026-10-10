import { logger } from '../../utils/logger';
import type { LsLanguage, LsServerSpec } from './ls-config';
import { languageForFile, SUPPORTED_LS_LANGUAGES, serverSpecForLanguage } from './ls-config';
import { LspClient } from './lsp-client';

export interface LspServerManagerOptions {
  readonly serverOverrides?: Readonly<Record<string, LsServerSpec>>;
  readonly timeoutMs?: number;
}

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
