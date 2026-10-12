// codebase-service.ts：代码库语义检索——驱动 vendored codegraph 平台二进制（子进程）做
// 查询/探索/调用图/影响面分析；首次使用先建索引（.codegraph 目录为哨兵）
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type {
  CodebaseCalleesRes,
  CodebaseCallersRes,
  CodebaseExploreRes,
  CodebaseImpactRes,
  CodebaseNodeRes,
  CodebaseQueryRes,
  CodebaseQueryResult,
} from '@code-agent/shared/main';
import { AppError, ErrorCode } from '@code-agent/shared/main';
import { app } from 'electron';
import { logger } from '../../utils/logger';
import { terminateChild } from '../../utils/terminate-child';

// 单命令 60s：语义查询/建索引都可能数秒，但不能无限等
const CODEGRAPH_COMMAND_TIMEOUT_MS = 60_000;

/** codegraph 启动方式：win32 用捆绑 node 跑 js 入口，其余平台直接执行平台二进制 */
export interface CodegraphBundle {
  readonly command: string;
  readonly args: readonly string[];
}

// bundle 解析结果记忆化：pnpm 目录扫描每次调 IO，不该每条命令重扫
let bundleMemo: CodegraphBundle | undefined;

/** 清空 bundle 记忆（测试隔离用） */
export function resetCodegraphBundleMemo(): void {
  bundleMemo = undefined;
}

/** 解析 codegraph 可执行（带记忆化；失败抛 AppError 带修复指引） */
export function resolveCodegraphBundle(): CodegraphBundle {
  if (bundleMemo !== undefined) {
    return bundleMemo;
  }
  const bundle = resolveCodegraphBundleOnce();
  bundleMemo = bundle;
  return bundle;
}

function resolveCodegraphBundleOnce(): CodegraphBundle {
  // 平台专属包按 {platform}-{arch} 命名；dev 从 pnpm 虚拟store找最新版本目录，
  // 打包态由 prepare-codegraph.mjs 拷到 resources/codegraph
  const target = `${process.platform}-${process.arch}`;
  let dir: string;
  if (app.isPackaged) {
    dir = join(process.resourcesPath, 'codegraph');
  } else {
    const pnpmRoot = join(process.cwd(), 'node_modules', '.pnpm');
    const prefix = `@colbymchenry+codegraph-${target}@`;
    const candidates = readdirSync(pnpmRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.startsWith(prefix))
      .map((e) => e.name)
      .sort();
    const latest = candidates.at(-1);
    if (latest === undefined) {
      throw new AppError(
        ErrorCode.INTERNAL_ERROR,
        `codegraph 平台包未安装（${target}）——请执行 pnpm install 或检查 node_modules/.pnpm`,
      );
    }
    dir = join(pnpmRoot, latest, 'node_modules', '@colbymchenry', `codegraph-${target}`);
  }
  if (process.platform === 'win32') {
    return {
      command: join(dir, 'node.exe'),
      args: [
        '--liftoff-only',
        '--disable-warning=ExperimentalWarning',
        join(dir, 'lib', 'dist', 'bin', 'codegraph.js'),
      ],
    };
  }
  return { command: join(dir, 'bin', 'codegraph'), args: [] };
}

// win32 特例：平台包内不带独立 node 二进制，用捆绑的 node.exe 跑 js 入口
//（--liftoff-only 跳过 npm 启动逻辑，禁实验警告防 stderr 噪音）
export interface CodebaseQueryOptions {
  readonly path: string;
  readonly search: string;
  readonly limit: number;
  readonly kind: string | undefined;
}

export interface CodebaseExploreOptions {
  readonly path: string;
  readonly query: readonly string[];
  readonly maxFiles: number;
}

export interface CodebaseNodeOptions {
  readonly path: string;
  readonly name: string | undefined;
  readonly file: string | undefined;
  readonly offset: number | undefined;
  readonly limit: number | undefined;
  readonly symbolsOnly: boolean | undefined;
}

export interface CodebaseCallOptions {
  readonly path: string;
  readonly symbol: string;
  readonly limit: number;
}

export interface CodebaseImpactOptions {
  readonly path: string;
  readonly symbol: string;
  readonly depth: number;
}

/** 代码库服务接口（codebase 工具与 IPC 共同消费） */
export interface ICodebaseService {
  query(options: CodebaseQueryOptions): Promise<CodebaseQueryRes>;
  explore(options: CodebaseExploreOptions): Promise<CodebaseExploreRes>;
  node(options: CodebaseNodeOptions): Promise<CodebaseNodeRes>;
  callers(options: CodebaseCallOptions): Promise<CodebaseCallersRes>;
  callees(options: CodebaseCallOptions): Promise<CodebaseCalleesRes>;
  impact(options: CodebaseImpactOptions): Promise<CodebaseImpactRes>;
  ensureIndexed(path: string): Promise<void>;
  dispose(): Promise<void>;
}

export class CodebaseService implements ICodebaseService {
  // spawn/timeout/bundle 解析全可注入（测试不打真实子进程）
  private readonly spawnFn: typeof spawn;
  private readonly commandTimeoutMs: number;
  private readonly resolveBundle: () => CodegraphBundle;

  constructor(
    options: {
      spawnFn?: typeof spawn;
      timeoutMs?: number;
      resolveBundle?: () => CodegraphBundle;
    } = {},
  ) {
    this.spawnFn = options.spawnFn ?? spawn;
    this.commandTimeoutMs = options.timeoutMs ?? CODEGRAPH_COMMAND_TIMEOUT_MS;
    this.resolveBundle = options.resolveBundle ?? resolveCodegraphBundle;
  }

  private readonly activeProcesses = new Set<ChildProcess>();
  // 同路径建索引去重：并发 ensureIndexed 共享同一 Promise，不叠加子进程
  private readonly indexingInFlight = new Map<string, Promise<void>>();
  async query(options: CodebaseQueryOptions): Promise<CodebaseQueryRes> {
    const { path, search, limit, kind } = options;

    const args = ['query', search, '-p', path];
    if (limit !== undefined) {
      args.push('-l', String(limit));
    }
    args.push('-j');
    if (kind !== undefined && kind.length > 0) {
      args.push('-k', kind);
    }

    const { stdout } = await this.runCodegraph(args, path);
    const results = this.parseQueryResults(stdout);
    return { results };
  }

  async explore(options: CodebaseExploreOptions): Promise<CodebaseExploreRes> {
    const { path, query, maxFiles } = options;
    const args = ['explore', ...query, '-p', path];
    if (maxFiles !== undefined) {
      args.push('--max-files', String(maxFiles));
    }
    const { stdout } = await this.runCodegraph(args, path);
    return { markdown: stdout };
  }

  async node(options: CodebaseNodeOptions): Promise<CodebaseNodeRes> {
    const { path, name, file, offset, limit, symbolsOnly } = options;

    const args: string[] = ['node'];
    if (name !== undefined && name.length > 0) {
      args.push(name);
    }
    args.push('-p', path);

    if (file !== undefined && file.length > 0) {
      args.push('-f', file);
    }
    if (offset !== undefined) {
      args.push('--offset', String(offset));
    }
    if (limit !== undefined) {
      args.push('--limit', String(limit));
    }
    if (symbolsOnly === true) {
      args.push('--symbols-only');
    }

    const { stdout } = await this.runCodegraph(args, path);
    return { markdown: stdout };
  }

  async callers(options: CodebaseCallOptions): Promise<CodebaseCallersRes> {
    const { path, symbol, limit } = options;
    const args = ['callers', symbol, '-p', path, '-l', String(limit)];
    const { stdout } = await this.runCodegraph(args, path);
    return { markdown: stdout };
  }

  async callees(options: CodebaseCallOptions): Promise<CodebaseCalleesRes> {
    const { path, symbol, limit } = options;
    const args = ['callees', symbol, '-p', path, '-l', String(limit)];
    const { stdout } = await this.runCodegraph(args, path);
    return { markdown: stdout };
  }

  async impact(options: CodebaseImpactOptions): Promise<CodebaseImpactRes> {
    const { path, symbol, depth } = options;
    const args = ['impact', symbol, '-p', path, '-d', String(depth)];
    const { stdout } = await this.runCodegraph(args, path);
    return { markdown: stdout };
  }

  async dispose(): Promise<void> {
    if (this.activeProcesses.size === 0) {
      return;
    }
    const processes = Array.from(this.activeProcesses);
    await Promise.all(processes.map((proc) => terminateChild(proc, 'codegraph')));
    this.activeProcesses.clear();
    logger.info({}, 'CodebaseService 所有子进程已清理');
  }

  /**
   * 确保路径已建索引：.codegraph 目录存在即视为已索引（幂等哨兵），
   * 否则跑 init（并发调用按路径合并）
   */
  async ensureIndexed(path: string): Promise<void> {
    if (existsSync(join(path, '.codegraph'))) {
      return;
    }
    const inFlight = this.indexingInFlight.get(path);
    if (inFlight !== undefined) {
      return inFlight;
    }
    const task = this.runCodegraph(['init', path], path)
      .then(() => undefined)
      .finally(() => {
        this.indexingInFlight.delete(path);
      });
    this.indexingInFlight.set(path, task);
    return task;
  }

  // 子进程统一管理：登记 activeProcesses（dispose 时 SIGTERM/SIGKILL 收尾）、
  // 超时杀进程、非零退出码带 stderr 报 AppError
  private runCodegraph(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const bundle = this.resolveBundle();
      const child = this.spawnFn(bundle.command, [...bundle.args, ...args], {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      this.activeProcesses.add(child);

      let stdout = '';
      let stderr = '';

      if (child.stdout !== null) {
        child.stdout.on('data', (chunk: Buffer) => {
          stdout += chunk.toString('utf-8');
        });
      }
      if (child.stderr !== null) {
        child.stderr.on('data', (chunk: Buffer) => {
          stderr += chunk.toString('utf-8');
        });
      }

      const timeoutId = setTimeout(() => {
        try {
          child.kill('SIGTERM');
        } catch {}
        reject(
          new AppError(
            ErrorCode.INTERNAL_ERROR,
            `codegraph 命令超时（${this.commandTimeoutMs}ms）`,
            undefined,
            { args, cwd },
          ),
        );
      }, this.commandTimeoutMs);

      const cleanup = (): void => {
        clearTimeout(timeoutId);
        this.activeProcesses.delete(child);
      };

      child.on('error', (err: Error) => {
        cleanup();
        reject(
          new AppError(ErrorCode.INTERNAL_ERROR, 'codegraph 命令启动失败', err, {
            args,
            cwd,
          }),
        );
      });

      child.on('close', (code: number | null) => {
        cleanup();
        if (code === 0) {
          resolve({ stdout, stderr });
          return;
        }
        reject(
          new AppError(ErrorCode.INTERNAL_ERROR, `codegraph 命令失败（code=${code}）`, undefined, {
            args,
            cwd,
            stderr,
          }),
        );
      });
    });
  }

  private parseQueryResults(stdout: string): CodebaseQueryResult[] {
    const trimmed = stdout.trim();
    if (trimmed.length === 0) {
      return [];
    }
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (!Array.isArray(parsed)) {
        throw new Error('Expected array output from codegraph query --json');
      }
      return parsed as CodebaseQueryResult[];
    } catch (error) {
      throw new AppError(ErrorCode.INTERNAL_ERROR, 'codegraph query JSON 解析失败', error, {
        stdout: trimmed.slice(0, 500),
      });
    }
  }
}

let codebaseService: CodebaseService | null = null;

/** 惰性单例（服务容器经此取用） */
export function getCodebaseService(): ICodebaseService {
  if (codebaseService === null) {
    codebaseService = new CodebaseService();
  }
  return codebaseService;
}

/** 重置单例（dispose 链与测试用） */
export function resetCodebaseService(): void {
  codebaseService = null;
}
