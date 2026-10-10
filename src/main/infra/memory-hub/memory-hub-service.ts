import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { INVALIDATION_DOMAINS } from '@code-agent/shared/main';
import { logger } from '../../utils/logger';
import { broadcastInvalidation } from '../invalidation/invalidation';
import { HttpMemoryPort } from './adapter';
import {
  type EngineLauncher,
  type EngineProcessHandle,
  type LaunchEngineOptions,
  launchEngineProcess,
} from './engine-process';
import { countL0Records, listL0SessionKeys, readSessionRecords } from './l0-inspect';
import { removeSessionLinesFromJsonl } from './l0-rewrite';
import type { MemoryPort } from './types';

const TAG = '[memory-hub]';

const START_TIMEOUT_MS = 60_000;
const HEALTH_POLL_MS = 300;
const HEALTH_TIMEOUT_MS = 1500;

export interface MemoryHubLlmConfig {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
}

export interface L0Record {
  readonly role: 'user' | 'assistant' | string;
  readonly content: string;
  readonly timestamp: number;
}

export interface MemoryHubServiceOptions {
  readonly hubRoot: string | undefined;
  readonly dataDir: string;
  readonly llm?: MemoryHubLlmConfig | (() => Promise<MemoryHubLlmConfig | undefined>) | undefined;
  readonly launcher?: EngineLauncher | undefined;
}

class UnavailableMemoryPort implements MemoryPort {
  async health(): Promise<boolean> {
    return false;
  }
  async capture(): Promise<{ l0Recorded: number; schedulerNotified: boolean }> {
    return { l0Recorded: 0, schedulerNotified: false };
  }
  async recall(): Promise<{ ok: boolean; context: string; memoryCount: number; message?: string }> {
    return { ok: false, context: '', memoryCount: 0, message: 'memory-hub not configured' };
  }
  async searchMemories(): Promise<{ content: string; total: number }> {
    return { content: '', total: 0 };
  }
  async searchConversations(): Promise<{ content: string; total: number }> {
    return { content: '', total: 0 };
  }
  async clear(): Promise<{ ok: boolean; deletedCount: number; message?: string }> {
    return { ok: false, deletedCount: 0, message: 'memory-hub not configured' };
  }
}

export function createDeferredMemoryPort(getService: () => MemoryHubService): MemoryPort {
  const via = async <T>(fn: (p: MemoryPort) => Promise<T>): Promise<T> =>
    fn(await getService().ensureStarted());
  return {
    health: () => via((p) => p.health()),
    capture: (input) => via((p) => p.capture(input)),
    recall: (input) => via((p) => p.recall(input)),
    searchMemories: (query, limit) => via((p) => p.searchMemories(query, limit)),
    searchConversations: (query, limit, sessionKey) =>
      via((p) => p.searchConversations(query, limit, sessionKey)),
    clear: (sessionKey) => via((p) => p.clear(sessionKey)),
  };
}

export class MemoryHubService {
  private child: EngineProcessHandle | null = null;
  private port: MemoryPort | null = null;
  private starting: Promise<MemoryPort> | null = null;
  private readonly llmPlaceholder: MemoryHubLlmConfig = {
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'sk-placeholder',
    model: 'gpt-4o-mini',
  };

  constructor(private readonly options: MemoryHubServiceOptions) {}

  isConfigured(): boolean {
    return this.options.hubRoot !== undefined && this.options.hubRoot.length > 0;
  }

  isRunning(): boolean {
    return this.child !== null && !this.child.hasExited();
  }

  async probeHealth(): Promise<boolean> {
    if (!this.isRunning()) {
      return false;
    }
    try {
      return (await this.port?.health()) ?? false;
    } catch {
      return false;
    }
  }

  async countRecords(): Promise<{ sessionCount: number; recordCount: number }> {
    return countL0Records(this.options.dataDir);
  }

  async listKnownSessionKeys(): Promise<string[]> {
    return listL0SessionKeys(this.options.dataDir);
  }

  async listL0BySession(sessionKey: string, limit = 20): Promise<L0Record[]> {
    return readSessionRecords(this.options.dataDir, sessionKey, limit);
  }

  async removeL0JsonlBySession(sessionKey: string): Promise<number> {
    return removeSessionLinesFromJsonl(this.options.dataDir, [sessionKey]);
  }

  async removeL0JsonlBySessions(sessionKeys: readonly string[]): Promise<number> {
    return removeSessionLinesFromJsonl(this.options.dataDir, sessionKeys);
  }

  async ensureStarted(): Promise<MemoryPort> {
    if (this.port !== null) {
      return this.port;
    }
    if (this.starting !== null) {
      return this.starting;
    }
    this.starting = this.doStart()
      .then((port) => {
        this.port = port;
        return port;
      })
      .finally(() => {
        this.starting = null;
      });
    return this.starting;
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.child = null;
    this.port = null;
    if (child === null || child.hasExited()) {
      return;
    }
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        resolve();
      };
      child.onExit(finish);
      child.kill();
      setTimeout(finish, 3000);
    });
    logger.info({}, `${TAG} sidecar 已停止`);
    broadcastInvalidation([INVALIDATION_DOMAINS.memory]);
  }

  private async doStart(): Promise<MemoryPort> {
    const hubRoot = this.options.hubRoot;
    if (hubRoot === undefined || hubRoot.length === 0) {
      logger.warn({}, `${TAG} 未配置 MEMORY_HUB_ROOT，记忆引擎以空实现运行`);
      return new UnavailableMemoryPort();
    }
    const entry = this.resolveEntry(hubRoot);
    if (entry === null) {
      logger.error(
        { hubRoot },
        `${TAG} hubRoot 下找不到上游入口（dist/gateway/server.js 或 src/gateway/server.ts），` +
          `本产物未捆绑记忆引擎，以空实现运行`,
      );
      return new UnavailableMemoryPort();
    }

    const port = await this.pickFreePort();
    const apiKey = randomUUID();
    const dataDir = this.options.dataDir;
    mkdirSync(dataDir, { recursive: true });

    migrateLegacyDataDir(dataDir);

    const configPath = await this.writeGatewayConfig(dataDir, port, apiKey);
    const launcherPath = this.writeLauncher(dataDir);

    const useTsx = !entry.isDist;

    logger.info({ hubRoot, entry: entry.path, port, useTsx }, `${TAG} 启动 sidecar`);
    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      // biome-ignore lint/style/useNamingConvention: 标准环境变量名
      NODE_OPTIONS: '',
      // biome-ignore lint/style/useNamingConvention: 标准环境变量名
      MEMORY_HUB_ENTRY: entry.path,
      // biome-ignore lint/style/useNamingConvention: 上游约定的配置环境变量名
      TDAI_GATEWAY_CONFIG: configPath,
      // biome-ignore lint/style/useNamingConvention: 上游约定的配置环境变量名
      TDAI_METADATA_SQLITE_BASE_DIR: join(dataDir, 'metadata'),
      // biome-ignore lint/style/useNamingConvention: 上游约定的配置环境变量名
      TDAI_DEPLOY_MODE: 'standalone',
      // biome-ignore lint/style/useNamingConvention: 上游约定的配置环境变量名
      MEMORY_TENCENTDB_ROOT: dataDir,
    };

    const child = this.launchEngine({ launcherPath, cwd: hubRoot, env: childEnv, useTsx });
    this.child = child;
    child.onExit((code) => {
      if (this.child === child) {
        logger.warn({ code }, `${TAG} sidecar 进程退出`);
        this.child = null;
        this.port = null;
        broadcastInvalidation([INVALIDATION_DOMAINS.memory]);
      }
    });

    const baseUrl = `http://127.0.0.1:${port}`;
    await this.waitUntilHealthy(baseUrl, apiKey, () => child.stderrTail());

    logger.info({ baseUrl }, `${TAG} sidecar 就绪`);
    broadcastInvalidation([INVALIDATION_DOMAINS.memory]);
    return new HttpMemoryPort({ baseUrl, apiKey });
  }

  private launchEngine(options: LaunchEngineOptions): EngineProcessHandle {
    const launcher = this.options.launcher ?? launchEngineProcess;
    return launcher(options);
  }

  private resolveEntry(hubRoot: string): { path: string; isDist: boolean } | null {
    const distEntry = join(hubRoot, 'dist', 'gateway', 'server.js');
    if (existsSync(distEntry)) {
      return { path: distEntry, isDist: true };
    }
    const srcEntry = join(hubRoot, 'src', 'gateway', 'server.ts');
    if (existsSync(srcEntry)) {
      return { path: srcEntry, isDist: false };
    }
    return null;
  }

  private async writeGatewayConfig(dataDir: string, port: number, apiKey: string): Promise<string> {
    const llmOption = this.options.llm;
    const resolvedLlm =
      typeof llmOption === 'function' ? await llmOption() : (llmOption ?? undefined);
    const llm = resolvedLlm ?? this.llmPlaceholder;
    const q = (v: string): string => `'${v.replaceAll("'", "''")}'`;
    const yaml = [
      'server:',
      `  port: ${port}`,
      '  host: 127.0.0.1',
      `  apiKey: ${q(apiKey)}`,
      'data:',
      `  baseDir: ${q(join(dataDir, 'data'))}`,
      'llm:',
      '  provider: openai-compatible',
      `  baseUrl: ${q(llm.baseUrl)}`,
      `  apiKey: ${q(llm.apiKey)}`,
      `  model: ${q(llm.model)}`,
      'memory:',
      '  recall:',
      '    enabled: true',
      '    strategy: keyword',
      '',
    ].join('\n');
    const configPath = join(dataDir, 'gateway.yaml');
    writeFileSync(configPath, yaml, 'utf8');
    return configPath;
  }

  private writeLauncher(dataDir: string): string {
    const launcherPath = join(dataDir, 'launcher.mjs');
    const script = [
      "import { pathToFileURL } from 'node:url';",
      'const mod = await import(pathToFileURL(process.env.MEMORY_HUB_ENTRY).href);',
      'await new mod.TdaiGateway().start();',
      'setInterval(() => {}, 1 << 30);',
      '',
    ].join('\n');
    writeFileSync(launcherPath, script, 'utf8');
    return launcherPath;
  }

  private async waitUntilHealthy(
    baseUrl: string,
    apiKey: string,
    stderrTail: () => string,
  ): Promise<void> {
    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (this.child?.hasExited()) {
        throw new Error(`${TAG} sidecar 启动即退出\n${stderrTail()}`);
      }
      try {
        const res = await fetch(`${baseUrl}/health`, {
          headers: {
            // biome-ignore lint/style/useNamingConvention: HTTP 标准头名
            Authorization: `Bearer ${apiKey}`,
          },
          signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
        });
        if (res.ok) {
          const body = (await res.json()) as { status?: string };
          if (body.status === 'ok') {
            return;
          }
        }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, HEALTH_POLL_MS));
    }
    void this.stop();
    throw new Error(`${TAG} sidecar 就绪超时（${START_TIMEOUT_MS}ms）\n${stderrTail()}`);
  }

  private pickFreePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = net.createServer();
      server.unref();
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (address === null || typeof address === 'string') {
          server.close();
          reject(new Error('failed to pick free port'));
          return;
        }
        const port = address.port;
        server.close(() => resolve(port));
      });
    });
  }
}

export function migrateLegacyDataDir(newRoot: string, homeDir?: string): number {
  try {
    const home = homeDir ?? homedir();
    const legacyRoot = join(home, '.memory-tencentdb', 'memory-tdai');
    if (!existsSync(legacyRoot)) {
      return 0;
    }
    let migrated = 0;
    for (const entry of readdirSync(legacyRoot, { withFileTypes: true })) {
      const src = join(legacyRoot, entry.name);
      const dest = join(newRoot, entry.name);
      if (existsSync(dest)) {
        continue;
      }
      try {
        cpSync(src, dest, { recursive: true, force: true });
        migrated += 1;
      } catch {}
    }
    if (migrated > 0) {
      logger.info(
        { legacyRoot, newRoot, migrated },
        `${TAG} 已迁移主目录遗留数据至 userData（旧目录保留未删，可手动清理）`,
      );
    }
    return migrated;
  } catch (error) {
    logger.warn(
      { error: error instanceof Error ? error.message : String(error) },
      `${TAG} 遗留数据迁移失败（忽略，引擎照常启动）`,
    );
    return 0;
  }
}
