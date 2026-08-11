// src/main/infra/search/search-service.ts
// SearchService：基于 @vscode/ripgrep 的内容搜索与文件查找
// ──────────────────────────────────────────────────────────────
// 职责：
// - grep：在文件内容中搜索匹配（正则 / 字面量，大小写敏感可选）
// - glob：按 glob 模式匹配文件路径（不读取内容）
// - dispose：清理子进程句柄（应用退出时调用）
//
// 设计：
// - 基于 @vscode/ripgrep 提供的 rgPath（绝对路径到 ripgrep 可执行文件）
// - 通过 spawn 启动子进程，按行读取 stdout
// - grep 模式使用 --json 输出，解析 JSON Lines 获取匹配 + 上下文
// - glob 模式使用 --files 输出，按行解析文件路径
// - 结果数上限保护：达到 maxResults 后立即关闭子进程，避免 OOM
// - 单例模式：与 FileService / ChatService 一致，便于统一生命周期管理
// ──────────────────────────────────────────────────────────────

import { type ChildProcess, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { GlobRes, GrepMatch, GrepRes } from '@code-agent/shared/main';
import { AppError, ErrorCode } from '@code-agent/shared/main';
import { rgPath } from '@vscode/ripgrep';
import { logger } from '../../utils/logger';

/**
 * grep 方法入参
 *
 * 与 GrepReqSchema 字段对齐，类型独立定义以便测试 mock。
 */
export interface GrepOptions {
  /** 搜索模式（正则或字面量） */
  readonly pattern: string;
  /** 搜索范围（多个目录或文件，空数组表示当前工作目录） */
  readonly paths: readonly string[];
  /** 是否大小写敏感（默认 false） */
  readonly caseSensitive: boolean;
  /** 是否作为正则（默认 true）；false 时作为字面量字符串匹配 */
  readonly isRegex: boolean;
  /** 文件名 glob 过滤（如 '*.ts'） */
  readonly include: string | undefined;
  /** 排除的文件名 glob 数组 */
  readonly exclude: readonly string[];
  /** 最大结果数（达到即停止搜索） */
  readonly maxResults: number;
}

/** glob 方法入参（与 GlobReqSchema 字段对齐） */
export interface GlobOptions {
  /** glob 模式 */
  readonly pattern: string;
  /** 搜索根目录 */
  readonly path: string;
  /** 是否包含隐藏文件（默认 false） */
  readonly includeHidden: boolean;
  /** 最大结果数 */
  readonly maxResults: number;
}

/**
 * SearchService 接口
 *
 * 解耦 IPC handler 对具体类的依赖，便于：
 * - 单元测试：注入 mock 实现，不依赖真实 ripgrep
 * - 未来扩展：替换为其他搜索引擎（如 codegraph 语义搜索）
 */
export interface ISearchService {
  /** 在文件内容中搜索匹配 */
  grep(options: GrepOptions): Promise<GrepRes>;
  /** 按 glob 模式匹配文件路径 */
  glob(options: GlobOptions): Promise<GlobRes>;
  /** 优雅关闭：清理子进程句柄 */
  dispose(): Promise<void>;
}

/**
 * ripgrep --json 输出的 JSON Line 类型
 *
 * 参考 ripgrep 官方文档：https://docs.rs/grep-printer/latest/grep_printer/struct.Standard.html
 * 仅列出本服务关心的 type，其他 type 忽略。
 *
 * 字段名沿用 ripgrep 输出的 snake_case（如 line_number、absolute_offset），
 * 与 JSON.parse 后的对象结构保持一致，避免运行时映射开销。
 * biome.json 已对本文件关闭 useNamingConvention 规则。
 */
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

/**
 * SearchService 默认实现
 *
 * 内部不持有长期状态（每次 grep/glob 都启动新的子进程），
 * dispose 仅用于清理可能残留的子进程。
 *
 * 错误分类：
 * - ripgrep 退出码 0 / 1：正常（1 表示无匹配）
 * - ripgrep 退出码 2：参数错误或路径不存在，包装为 INVALID_INPUT
 * - 子进程启动失败：INTERNAL_ERROR
 * - stdout 解析失败：INTERNAL_ERROR
 */
export class SearchService implements ISearchService {
  /**
   * 子进程启动函数（DI 注入点：测试传 fake，生产默认 node:child_process spawn）
   * 注入而非 mock：外部依赖可替换，业务逻辑保持真实实现
   */
  private readonly spawnFn: typeof spawn;

  constructor(options: { spawnFn?: typeof spawn } = {}) {
    this.spawnFn = options.spawnFn ?? spawn;
  }

  /**
   * 当前活跃的子进程列表（用于 dispose 时统一清理）
   *
   * 注意：grep/glob 是短任务，正常完成后会从 Map 移除。
   * 仅在异常退出 / dispose 调用时仍存活的子进程会在此 Map 中。
   */
  private readonly activeProcesses = new Set<ChildProcess>();

  /**
   * 在文件内容中搜索匹配
   *
   * 流程：
   * 1. 构建 ripgrep 参数（--json --line-number --column -A 2 -B 2 ...）
   * 2. spawn 子进程
   * 3. 按行读取 stdout，解析 JSON
   * 4. 收集所有 match 和 context 行，按 line_number 关联 context 到对应 match
   * 5. 应用 maxResults 截断
   *
   * ripgrep --json 的输出顺序（以 -A 2 -B 2 为例）：
   *   context(B-2) → context(B-1) → match → context(A-1) → context(A-2) → ...
   * 因此需要先收集所有行，再按 line_number 关联 context。
   *
   * @returns { matches, truncated }：matches 最多 maxResults 条，truncated 表示是否被截断
   */
  async grep(options: GrepOptions): Promise<GrepRes> {
    const { pattern, paths, caseSensitive, isRegex, include, exclude, maxResults } = options;

    // 构建 ripgrep 参数
    // --json：输出 JSON Lines
    // --line-number：包含行号
    // --column：包含列号
    // -A 2 / -B 2：匹配前后 2 行上下文
    // -e PATTERN：避免以 - 开头的 pattern 被识别为参数
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

    // 大小写敏感（默认 -i 即忽略大小写，caseSensitive=true 时不加 -i）
    if (!caseSensitive) {
      args.push('-i');
    }

    // 字面量模式（isRegex=false 时加 -F，把 pattern 当作字面字符串）
    if (!isRegex) {
      args.push('-F');
    }

    // 包含的文件名 glob（ripgrep -g 参数）
    if (include !== undefined && include !== '') {
      args.push('-g', include);
    }

    // 排除的文件名 glob（ripgrep -g '!pattern' 表示排除）
    // 兜底：exclude 可能为 undefined（工具层 optional 字段未传），避免 TypeError
    for (const ex of exclude ?? []) {
      if (ex !== '') {
        args.push('-g', `!${ex}`);
      }
    }

    // 搜索路径（空数组时 ripgrep 默认搜索当前目录）
    if (paths.length > 0) {
      args.push(...paths);
    }

    // 临时收集所有行：match 行与 context 行混合
    // ripgrep 输出顺序为 context(B) → match → context(A)，无法在 onLine 时即时组装
    // 因此先收集到临时数组，最后统一组装
    const collectedMatches: Array<{
      file: string;
      line: number;
      column: number;
      text: string;
    }> = [];
    const collectedContexts: Array<{ file: string; line: number; text: string }> = [];
    // totalMatchCount 计数所有 match（不限收集），用于判断是否真的截断
    // collectedMatches 仅保留前 maxResults 条
    let totalMatchCount = 0;

    await this.runRipgrep(args, (line: string) => {
      // 解析 JSON 行，失败时跳过（不阻塞整个搜索）
      const parsed = this.tryParseJsonLine(line) as RipgrepJsonLine | null;
      if (parsed === null) {
        return true;
      }

      // 收集 match 行
      if (parsed.type === 'match') {
        totalMatchCount += 1;
        // 达到 maxResults 后停止收集（但继续计数以判断是否真的截断）
        if (collectedMatches.length >= maxResults) {
          // 已收集够 maxResults 条，主动 kill 子进程避免继续消耗 CPU/IO
          return false;
        }
        const parsedMatch = this.parseMatchLine(parsed);
        if (parsedMatch !== null) {
          collectedMatches.push(parsedMatch);
        }
        return true;
      }

      // 收集 context 行（仅在前 maxResults 个 match 范围内收集，避免无限增长）
      if (parsed.type === 'context') {
        if (totalMatchCount > maxResults) {
          return true;
        }
        // ripgrep --json 的 context 消息结构：{ line_number, lines: { text } }（无 path 字段）
        // 部分版本也可能输出 line 字段；用可选链兜底避免崩溃（真实缺陷修复）
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
      // begin / summary / end 忽略
      return true;
    });

    // 组装 GrepMatch：为每个 match 关联前后 2 行 context
    const matches: GrepMatch[] = collectedMatches.map((m) => {
      // beforeContext：当前文件中 line_number < m.line 的最近 2 行 context
      const before = collectedContexts
        .filter((c) => c.file === m.file && c.line < m.line)
        .sort((a, b) => a.line - b.line)
        .slice(-2)
        .map((c) => c.text);

      // afterContext：当前文件中 line_number > m.line 的最早 2 行 context
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

    // truncated 表示是否真的因超过 maxResults 而截断
    // 注意：ripgrep 退出码 1 表示无匹配（不是错误），此时 totalMatchCount=0
    const truncated = totalMatchCount > maxResults;

    return { matches, truncated };
  }

  /**
   * 按 glob 模式匹配文件路径
   *
   * 流程：
   * 1. 构建 ripgrep 参数（--files -g PATTERN PATH）
   * 2. spawn 子进程
   * 3. 按行读取 stdout（每行一个文件路径）
   * 4. 达到 maxResults 后提前终止
   *
   * 注意：ripgrep --files 默认遵守 .gitignore，行为与 VSCode 文件搜索一致。
   */
  async glob(options: GlobOptions): Promise<GlobRes> {
    const { pattern, path, includeHidden, maxResults } = options;

    const args: string[] = ['--files', '-g', pattern, path];
    // --hidden：包含隐藏文件（默认 ripgrep 跳过隐藏文件）
    if (includeHidden) {
      args.push('--hidden');
    }

    const files: string[] = [];
    let truncated = false;

    await this.runRipgrep(args, (line: string) => {
      // 空行跳过
      if (line === '') {
        return true;
      }
      // 先检查再 push：达到 maxResults 的行不入结果（真实缺陷修复：
      // 原实现先 push 再检查，导致多收 1 条且恰好 maxResults 被误标 truncated）
      if (files.length >= maxResults) {
        truncated = true;
        // 达到 maxResults 后主动 kill 子进程
        return false;
      }
      files.push(line);
      return true;
    });

    return { files, truncated };
  }

  /**
   * 优雅关闭：清理所有活跃的子进程
   *
   * 应用退出时调用，避免子进程句柄泄漏导致进程不退出。
   */
  async dispose(): Promise<void> {
    if (this.activeProcesses.size === 0) {
      return;
    }

    const processes = Array.from(this.activeProcesses);
    for (const proc of processes) {
      try {
        // SIGTERM 优雅终止，不强制 SIGKILL（避免子进程输出缓冲区损坏）
        proc.kill('SIGTERM');
      } catch (error) {
        // kill 失败不阻塞 dispose 流程，仅记录日志
        logger.warn({ error }, 'SearchService 子进程 kill 失败');
      }
    }
    this.activeProcesses.clear();
    logger.info({}, 'SearchService 所有子进程已清理');
  }

  /**
   * 启动 ripgrep 子进程并按行读取 stdout
   *
   * @param args ripgrep 命令行参数
   * @param onLine 每行 stdout 的回调（同步调用），返回 false 时主动 kill 子进程
   * @returns 退出码（0 / 1 正常，2 错误）
   *
   * 优化：onLine 返回 boolean 表示是否继续，false 时主动 kill 子进程
   * 避免达到 maxResults 后子进程继续运行消耗 CPU/IO
   */
  private runRipgrep(args: string[], onLine: (line: string) => boolean): Promise<void> {
    return new Promise((resolve, reject) => {
      // spawn 子进程
      // Windows 上 rgPath 是绝对路径到 ripgrep.exe，不需要 shell
      const child = this.spawnFn(rgPath, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });

      this.activeProcesses.add(child);

      // 统一清理逻辑：从 activeProcesses 移除
      // close/error 都需调用，避免 Set 无限增长
      const cleanup = (): void => {
        this.activeProcesses.delete(child);
      };

      // 子进程启动失败（spawn error 事件）
      child.on('error', (err: Error) => {
        cleanup();
        reject(
          new AppError(ErrorCode.INTERNAL_ERROR, 'ripgrep 启动失败', err, {
            rgPath,
            args,
          }),
        );
      });

      // 读取 stdout 按行处理
      // createInterface 自动按 \n / \r\n 分割
      if (child.stdout === null) {
        cleanup();
        reject(new AppError(ErrorCode.INTERNAL_ERROR, 'ripgrep stdout 为空'));
        return;
      }
      const rl = createInterface({ input: child.stdout });
      rl.on('line', (line: string) => {
        const shouldContinue = onLine(line);
        if (!shouldContinue) {
          // onLine 返回 false：主动 kill 子进程，触发 close 事件
          try {
            child.kill('SIGTERM');
          } catch {
            // 子进程可能已退出，kill 失败忽略
          }
        }
      });

      // stdout error 事件处理：避免 stdout 流错误导致 Promise 永久 pending
      // 注意：readline 会把 input 的 error 转发到自身（Node 17+），必须监听 rl 的 error，
      // 否则 rl.emit('error') 无监听者会抛未捕获异常（真实缺陷修复）
      rl.on('error', (err: Error) => {
        cleanup();
        rl.close();
        try {
          child.kill('SIGTERM');
        } catch {
          // 子进程可能已退出
        }
        reject(
          new AppError(ErrorCode.INTERNAL_ERROR, 'ripgrep stdout 读取失败', err, {
            args,
          }),
        );
      });

      // 子进程退出
      child.on('close', (code: number | null, signal: string | null) => {
        cleanup();
        rl.close();

        // 退出码 0 / 1：正常（1 表示无匹配，不是错误）
        if (code === 0 || code === 1) {
          resolve();
          return;
        }

        // 退出码 2：参数错误或路径不存在
        if (code === 2) {
          reject(new AppError(ErrorCode.INVALID_INPUT, 'ripgrep 参数错误或路径不存在'));
          return;
        }

        // 信号终止（如 SIGTERM，onLine 返回 false 触发的 kill 也会到这里）
        if (signal !== null) {
          logger.warn({ signal, code }, 'ripgrep 子进程被信号终止');
          resolve();
          return;
        }

        // 其他未知退出码
        reject(new AppError(ErrorCode.INTERNAL_ERROR, `ripgrep 异常退出，code=${code}`));
      });
    });
  }

  /**
   * 解析 ripgrep --json 输出的 match 行
   *
   * ripgrep match 行结构：
   * { type: "match", data: { path, line_number, line, submatches: [...] } }
   *
   * 当前简化实现：不合并 context 行（-A/-B 上下文通过 separate context 行输出），
   * 返回的 GrepMatch.beforeContext / afterContext 为空数组。
   *
   * 后续优化：累积 context 行，按 line_number 关联到对应 match。
   *
   * @returns GrepMatch 或 null（解析失败时返回 null）
   */
  private parseMatchLine(line: Extract<RipgrepJsonLine, { type: 'match' }>): GrepMatch | null {
    try {
      const { data } = line;
      // ripgrep 列号是按字节计算的，这里取第一个 submatch 的 start 作为列号
      // 如果没有 submatch（理论上不会发生），默认列号为 0
      const firstSubmatch = data.submatches[0];
      const column = firstSubmatch !== undefined ? firstSubmatch.start : 0;

      // 行文本去掉末尾换行符
      // 兼容不同 ripgrep 版本：match 消息可能用 line 或 lines 字段（真实缺陷修复）
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
      // 解析失败时记录日志，不阻塞整个搜索
      logger.warn({ error, line }, 'SearchService 解析 match 行失败');
      return null;
    }
  }

  /**
   * 尝试解析 JSON 行，失败时返回 null
   *
   * ripgrep --json 输出每行一个 JSON 对象，理论上不会解析失败。
   * 但在子进程异常退出时可能输出半截 JSON，此时跳过即可。
   */
  private tryParseJsonLine(line: string): RipgrepJsonLine | null {
    if (line === '') {
      return null;
    }
    try {
      return JSON.parse(line) as RipgrepJsonLine;
    } catch {
      // 非法 JSON 行直接跳过（不阻塞搜索）
      return null;
    }
  }
}

/** SearchService 单例（内部按具体实现类持有，外部暴露为 ISearchService 接口） */
let searchService: SearchService | null = null;

/**
 * 获取 SearchService 单例
 *
 * 整个应用生命周期共享一个实例。
 *
 * 返回类型为 ISearchService 接口而非具体类：
 * - 强制调用方面向接口编程，不依赖 SearchService 内部细节
 * - ServiceContainer 注入到 IPC handler 时类型一致
 */
export function getSearchService(): ISearchService {
  if (searchService === null) {
    searchService = new SearchService();
  }
  return searchService;
}

/**
 * 重置 SearchService（仅测试用）
 *
 * 调用 dispose 清理所有子进程，并清空单例缓存。
 */
export async function resetSearchService(): Promise<void> {
  if (searchService !== null) {
    await searchService.dispose();
    searchService = null;
  }
}
