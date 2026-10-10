import { type ChildProcess, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { GlobRes, GrepMatch, GrepRes } from '@code-agent/shared/main';
import { AppError, ErrorCode } from '@code-agent/shared/main';
import { rgPath } from '@vscode/ripgrep';
import { logger } from '../../utils/logger';
import { terminateChild } from '../../utils/terminate-child';

export interface GrepOptions {
  readonly pattern: string;
  readonly paths: readonly string[];
  readonly caseSensitive: boolean;
  readonly isRegex: boolean;
  readonly include: string | undefined;
  readonly exclude: readonly string[];
  readonly maxResults: number;
}

export interface GlobOptions {
  readonly pattern: string;
  readonly path: string;
  readonly includeHidden: boolean;
  readonly maxResults: number;
}

export interface ISearchService {
  grep(options: GrepOptions): Promise<GrepRes>;
  glob(options: GlobOptions): Promise<GlobRes>;
  dispose(): Promise<void>;
}

type RipgrepJsonLine =
  | { type: 'begin'; data: { path: { text: string } } }
  | {
      type: 'match';
      data: {
        path: { text: string };
        line_number: number;
        absolute_offset: number;
        line: { text: string };
        submatches: ReadonlyArray<{
          match: { text: string };
          start: number;
          end: number;
        }>;
      };
    }
  | {
      type: 'context';
      data: {
        path: { text: string };
        line_number: number;
        line: { text: string };
      };
    }
  | { type: 'summary'; data: unknown }
  | { type: 'end'; data: unknown };

function assertSafeSearchPaths(paths: readonly string[]): void {
  const unsafe = paths.find((p) => p.startsWith('-'));
  if (unsafe !== undefined) {
    throw new AppError(ErrorCode.INVALID_INPUT, `非法搜索路径（不得以 - 开头）：${unsafe}`);
  }
}

function appendSearchPaths(args: string[], paths: readonly string[]): void {
  if (paths.length === 0) {
    return;
  }
  assertSafeSearchPaths(paths);
  args.push('--', ...paths);
}

export class SearchService implements ISearchService {
  private readonly spawnFn: typeof spawn;

  constructor(options: { spawnFn?: typeof spawn } = {}) {
    this.spawnFn = options.spawnFn ?? spawn;
  }

  private readonly activeProcesses = new Set<ChildProcess>();

  async grep(options: GrepOptions): Promise<GrepRes> {
    const { pattern, paths, caseSensitive, isRegex, include, exclude, maxResults } = options;

    const args: string[] = [
      '--json',
      '--line-number',
      '--column',
      '-A',
      '2',
      '-B',
      '2',
      '-e',
      pattern,
    ];

    if (!caseSensitive) {
      args.push('-i');
    }

    if (!isRegex) {
      args.push('-F');
    }

    if (include !== undefined && include !== '') {
      args.push('-g', include);
    }

    for (const ex of exclude ?? []) {
      if (ex !== '') {
        args.push('-g', `!${ex}`);
      }
    }

    appendSearchPaths(args, paths);

    const collectedMatches: Array<{
      file: string;
      line: number;
      column: number;
      text: string;
    }> = [];
    const collectedContexts: Array<{ file: string; line: number; text: string }> = [];
    let totalMatchCount = 0;

    await this.runRipgrep(args, (line: string) => {
      const parsed = this.tryParseJsonLine(line) as RipgrepJsonLine | null;
      if (parsed === null) {
        return true;
      }

      if (parsed.type === 'match') {
        totalMatchCount += 1;
        if (collectedMatches.length >= maxResults) {
          return false;
        }
        const parsedMatch = this.parseMatchLine(parsed);
        if (parsedMatch !== null) {
          collectedMatches.push(parsedMatch);
        }
        return true;
      }

      if (parsed.type === 'context') {
        if (totalMatchCount > maxResults) {
          return true;
        }
        const data = parsed.data as {
          path?: { text?: string };
          line_number?: number;
          line?: { text?: string };
          lines?: { text?: string };
        };
        const lineData = data.line ?? data.lines;
        collectedContexts.push({
          file: data.path?.text ?? '',
          line: data.line_number ?? 0,
          text: lineData?.text?.replace(/\r?\n$/, '') ?? '',
        });
      }
      return true;
    });

    const matches: GrepMatch[] = collectedMatches.map((m) => {
      const before = collectedContexts
        .filter((c) => c.file === m.file && c.line < m.line)
        .sort((a, b) => a.line - b.line)
        .slice(-2)
        .map((c) => c.text);

      const after = collectedContexts
        .filter((c) => c.file === m.file && c.line > m.line)
        .sort((a, b) => a.line - b.line)
        .slice(0, 2)
        .map((c) => c.text);

      return {
        file: m.file,
        line: m.line,
        column: m.column,
        text: m.text,
        beforeContext: before,
        afterContext: after,
      };
    });

    const truncated = totalMatchCount > maxResults;

    return { matches, truncated };
  }

  async glob(options: GlobOptions): Promise<GlobRes> {
    const { pattern, path, includeHidden, maxResults } = options;

    if (path.startsWith('-')) {
      throw new AppError(ErrorCode.INVALID_INPUT, `非法搜索路径（不得以 - 开头）：${path}`);
    }
    const args: string[] = ['--files', '-g', pattern, '--', path];
    if (includeHidden) {
      args.push('--hidden');
    }

    const files: string[] = [];
    let truncated = false;

    await this.runRipgrep(args, (line: string) => {
      if (line === '') {
        return true;
      }
      if (files.length >= maxResults) {
        truncated = true;
        return false;
      }
      files.push(line);
      return true;
    });

    return { files, truncated };
  }

  async dispose(): Promise<void> {
    if (this.activeProcesses.size === 0) {
      return;
    }

    const processes = Array.from(this.activeProcesses);
    await Promise.all(processes.map((proc) => terminateChild(proc, 'search-ripgrep')));
    this.activeProcesses.clear();
    logger.info({}, 'SearchService 所有子进程已清理');
  }

  private runRipgrep(args: string[], onLine: (line: string) => boolean): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = this.spawnFn(rgPath, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });

      this.activeProcesses.add(child);

      const cleanup = (): void => {
        this.activeProcesses.delete(child);
      };

      child.on('error', (err: Error) => {
        cleanup();
        reject(
          new AppError(ErrorCode.INTERNAL_ERROR, 'ripgrep 启动失败', err, {
            rgPath,
            args,
          }),
        );
      });

      if (child.stdout === null) {
        cleanup();
        reject(new AppError(ErrorCode.INTERNAL_ERROR, 'ripgrep stdout 为空'));
        return;
      }
      const rl = createInterface({ input: child.stdout });
      rl.on('line', (line: string) => {
        const shouldContinue = onLine(line);
        if (!shouldContinue) {
          try {
            child.kill('SIGTERM');
          } catch {}
        }
      });

      rl.on('error', (err: Error) => {
        cleanup();
        rl.close();
        try {
          child.kill('SIGTERM');
        } catch {}
        reject(
          new AppError(ErrorCode.INTERNAL_ERROR, 'ripgrep stdout 读取失败', err, {
            args,
          }),
        );
      });

      child.on('close', (code: number | null, signal: string | null) => {
        cleanup();
        rl.close();

        if (code === 0 || code === 1) {
          resolve();
          return;
        }

        if (code === 2) {
          reject(new AppError(ErrorCode.INVALID_INPUT, 'ripgrep 参数错误或路径不存在'));
          return;
        }

        if (signal !== null) {
          logger.warn({ signal, code }, 'ripgrep 子进程被信号终止');
          resolve();
          return;
        }

        reject(new AppError(ErrorCode.INTERNAL_ERROR, `ripgrep 异常退出，code=${code}`));
      });
    });
  }

  private parseMatchLine(line: Extract<RipgrepJsonLine, { type: 'match' }>): GrepMatch | null {
    try {
      const { data } = line;
      const firstSubmatch = data.submatches[0];
      const column = firstSubmatch !== undefined ? firstSubmatch.start : 0;

      const matchData = data as {
        path?: { text?: string };
        line_number?: number;
        line?: { text?: string };
        lines?: { text?: string };
      };
      const lineData = matchData.line ?? matchData.lines;
      const text = lineData?.text?.replace(/\r?\n$/, '') ?? '';

      return {
        file: matchData.path?.text ?? '',
        line: matchData.line_number ?? 0,
        column,
        text,
        beforeContext: [],
        afterContext: [],
      };
    } catch (error) {
      logger.warn({ error, line }, 'SearchService 解析 match 行失败');
      return null;
    }
  }

  private tryParseJsonLine(line: string): RipgrepJsonLine | null {
    if (line === '') {
      return null;
    }
    try {
      return JSON.parse(line) as RipgrepJsonLine;
    } catch {
      return null;
    }
  }
}

let searchService: SearchService | null = null;

export function getSearchService(): ISearchService {
  if (searchService === null) {
    searchService = new SearchService();
  }
  return searchService;
}

export async function resetSearchService(): Promise<void> {
  if (searchService !== null) {
    await searchService.dispose();
    searchService = null;
  }
}
