// src/main/infra/memory-hub/memory-hub-service.ts
// MemoryHubService：上游 TencentDB-Agent-Memory（MemoryCore gateway）sidecar 生命周期管理
// ──────────────────────────────────────────────────────────────
// 职责：
// - ensureStarted()：懒启动 sidecar 子进程并等待 /health 就绪，返回 MemoryPort
//   · 动态选空闲端口 + 随机 apiKey（每次启动轮换，不落盘）
//   · 生成 gateway.yaml 写入数据目录（端口 / 数据目录 / 蒸馏 LLM / recall 策略）
//   · 以 ELECTRON_RUN_AS_NODE=1 复用 Electron 二进制当 Node 跑（安装包免带 Node）
// - stop()：应用退出时终止子进程（dispose 链中调用）
//
// 边界纪律：
// - 上游入口路径只经环境变量 MEMORY_HUB_ENTRY 传给 launcher；本模块不 import 上游代码
// - dev：hubRoot 指向上游源码目录（tsx 直跑 src）；prod：指向打包的构建产物目录
// ──────────────────────────────────────────────────────────────

import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';

import { logger } from '../../utils/logger';
import { HttpMemoryPort } from './adapter';
import type { MemoryPort } from './types';

const TAG = '[memory-hub]';

/** 就绪等待超时（毫秒） */
const START_TIMEOUT_MS = 20_000;
/** 健康轮询间隔（毫秒） */
const HEALTH_POLL_MS = 300;
/** 单请求超时（健康探测） */
const HEALTH_TIMEOUT_MS = 1500;

/** 蒸馏 LLM 配置（L0→L1 提取由引擎异步调用；缺失时 capture 仍可用，提取降级失败） */
export interface MemoryHubLlmConfig {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
}

/** L0 对话记录（上游 conversations JSONL 只读行；供设置页按会话列出） */
export interface L0Record {
  readonly role: 'user' | 'assistant' | string;
  readonly content: string;
  readonly timestamp: number;
}

/** MemoryHubService 构造选项 */
export interface MemoryHubServiceOptions {
  /**
   * 上游根目录：
   * - dev：解压源码目录（含 node_modules，tsx 可解析）
   * - prod：resources 下打包的产物目录
   */
  readonly hubRoot: string | undefined;
  /** 数据目录（userData/memory-hub）：yaml 配置、launcher、SQLite 全部落这里 */
  readonly dataDir: string;
  /**
   * 蒸馏 LLM 配置（静态值或异步解析器；未提供/解析失败时用占位值，
   * 仅影响 L1/L2 提取质量，L0 记录不受影响）
   */
  readonly llm?: MemoryHubLlmConfig | (() => Promise<MemoryHubLlmConfig | undefined>) | undefined;
}

/** 未配置 hubRoot 时返回的空实现（保证上层零分支：调用即安全降级） */
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
}

/**
 * 延迟解析的 MemoryPort：注册期同步可用，首次调用时才触发 sidecar 启动
 */
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
  };
}

export class MemoryHubService {
  private child: ChildProcess | null = null;
  private port: MemoryPort | null = null;
  private starting: Promise<MemoryPort> | null = null;
  private readonly llmPlaceholder: MemoryHubLlmConfig = {
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'sk-placeholder',
    model: 'gpt-4o-mini',
  };

  constructor(private readonly options: MemoryHubServiceOptions) {}

  /** 是否已配置上游根目录 */
  isConfigured(): boolean {
    return this.options.hubRoot !== undefined && this.options.hubRoot.length > 0;
  }

  /**
   * 按会话读取 L0 对话记录（读上游落盘的 conversations JSONL，只读展示）。
   *
   * 不触发 sidecar 启动：直接读数据文件，即使记忆引擎未配置/未运行也可列出
   * 既有记录（此前走 gateway /search/conversations 需语义 query，无法"列出"某会话）。
   */
  async listL0BySession(sessionKey: string, limit = 20): Promise<L0Record[]> {
    const dir = join(this.options.dataDir, 'data', 'conversations');
    if (!existsSync(dir)) {
      return [];
    }
    const records: L0Record[] = [];
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.jsonl')) continue;
      let text: string;
      try {
        text = readFileSync(join(dir, file), 'utf8');
      } catch {
        continue;
      }
      for (const line of text.split(/\r?\n/)) {
        if (line.trim().length === 0) continue;
        try {
          const rec = JSON.parse(line) as {
            sessionKey?: unknown;
            role?: unknown;
            content?: unknown;
            timestamp?: unknown;
          };
          if (rec.sessionKey === sessionKey) {
            records.push({
              role: typeof rec.role === 'string' ? rec.role : 'unknown',
              content: typeof rec.content === 'string' ? rec.content : '',
              timestamp: typeof rec.timestamp === 'number' ? rec.timestamp : 0,
            });
          }
        } catch {
          // 跳过损坏行（上游日志文件，容忍脏数据）
        }
      }
    }
    records.sort((a, b) => a.timestamp - b.timestamp);
    return records.slice(-limit);
  }

  /**
   * 确保 sidecar 已启动并返回记忆端口（幂等；并发调用合并为一次启动）
   *
   * @throws 启动超时 / 子进程早退时抛错（调用方决定是否容错）
   */
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

  /** 停止 sidecar（幂等；dispose 链调用） */
  async stop(): Promise<void> {
    const child = this.child;
    this.child = null;
    this.port = null;
    if (child !== null && child.exitCode === null) {
      await new Promise<void>((resolve) => {
        child.once('exit', () => resolve());
        child.kill();
        // 兜底：3s 未退出强杀
        setTimeout(() => {
          if (child.exitCode === null) {
            child.kill('SIGKILL');
          }
          resolve();
        }, 3000);
      });
      logger.info({}, `${TAG} sidecar 已停止`);
    }
  }

  // ─── 内部实现 ───

  private async doStart(): Promise<MemoryPort> {
    const hubRoot = this.options.hubRoot;
    if (hubRoot === undefined || hubRoot.length === 0) {
      logger.warn({}, `${TAG} 未配置 MEMORY_HUB_ROOT，记忆引擎以空实现运行`);
      return new UnavailableMemoryPort();
    }
    const entry = this.resolveEntry(hubRoot);
    if (entry === null) {
      throw new Error(`${TAG} 上游入口不存在（hubRoot=${hubRoot}）`);
    }

    const port = await this.pickFreePort();
    const apiKey = randomUUID();
    const dataDir = this.options.dataDir;
    mkdirSync(dataDir, { recursive: true });

    const configPath = await this.writeGatewayConfig(dataDir, port, apiKey);
    const launcherPath = this.writeLauncher(dataDir);

    const useTsx = !entry.isDist;
    const args: string[] = [];
    if (useTsx) {
      args.push('--import', 'tsx');
    }
    args.push(launcherPath);

    logger.info({ hubRoot, entry: entry.path, port, useTsx }, `${TAG} 启动 sidecar`);
    const child = spawn(process.execPath, args, {
      cwd: hubRoot, // 让 --import tsx 从上游 node_modules 解析 loader
      env: {
        ...process.env,
        // biome-ignore lint/style/useNamingConvention: 标准环境变量名
        ELECTRON_RUN_AS_NODE: '1',
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
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;

    let stderrTail = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-2000);
    });
    child.on('exit', (code) => {
      if (this.child === child) {
        logger.warn({ code }, `${TAG} sidecar 进程退出`);
        this.child = null;
        this.port = null;
      }
    });

    const baseUrl = `http://127.0.0.1:${port}`;
    await this.waitUntilHealthy(
      baseUrl,
      apiKey,
      stderrTailGetter(() => stderrTail),
    );

    logger.info({ baseUrl }, `${TAG} sidecar 就绪`);
    return new HttpMemoryPort({ baseUrl, apiKey });
  }

  /** 解析上游入口：优先 dist 构建产物，回退 TS 源码（需 tsx） */
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

  /** 生成 gateway.yaml（全部配置单点生成，便于审计与排障） */
  private async writeGatewayConfig(dataDir: string, port: number, apiKey: string): Promise<string> {
    // 蒸馏 LLM：静态值 / 异步解析器（失败回退占位值，不阻断 sidecar 启动）
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

  /** 写出子进程启动器（内容内联于此，避免打包器遗漏非引用文件） */
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

  /** 轮询 /health 直到就绪或超时（子进程早退立即失败并带 stderr 尾巴） */
  private async waitUntilHealthy(
    baseUrl: string,
    apiKey: string,
    stderrTail: () => string,
  ): Promise<void> {
    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (this.child !== null && this.child.exitCode !== null) {
        throw new Error(
          `${TAG} sidecar 启动即退出（code=${this.child.exitCode}）\n${stderrTail()}`,
        );
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
      } catch {
        // 未就绪，继续轮询
      }
      await new Promise((resolve) => setTimeout(resolve, HEALTH_POLL_MS));
    }
    void this.stop();
    throw new Error(`${TAG} sidecar 就绪超时（${START_TIMEOUT_MS}ms）\n${stderrTail()}`);
  }

  /** 选取空闲回环端口（listen(0) 后释放；存在极小竞态，健康检查兜底） */
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

function stderrTailGetter(get: () => string): () => string {
  return get;
}
