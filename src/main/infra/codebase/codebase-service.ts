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

const CODEGRAPH_COMMAND_TIMEOUT_MS = 60_000;

export interface CodegraphBundle {
  readonly command: string;
  readonly args: readonly string[];
}

let bundleMemo: CodegraphBundle | undefined;

export function resetCodegraphBundleMemo(): void {
  bundleMemo = undefined;
}

export function resolveCodegraphBundle(): CodegraphBundle {
  if (bundleMemo !== undefined) {
    return bundleMemo;
  }
  const bundle = resolveCodegraphBundleOnce();
  bundleMemo = bundle;
  return bundle;
}

function resolveCodegraphBundleOnce(): CodegraphBundle {
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

export function getCodebaseService(): ICodebaseService {
  if (codebaseService === null) {
    codebaseService = new CodebaseService();
  }
  return codebaseService;
}

export function resetCodebaseService(): void {
  codebaseService = null;
}
