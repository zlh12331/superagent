// src/main/infra/codebase/codebase-service.ts
// CodebaseService：codegraph CLI 封装（代码智能查询）
// ──────────────────────────────────────────────────────────────
// 职责：
// - query：结构化符号搜索（返回符号列表 + 相关度评分）
// - explore：区域探索（自然语言查询，返回相关符号源码 + 调用路径 markdown）
// - node：符号详情（源码 + 调用链，或文件模式：文件内容 + 依赖）
// - callers：调用方查询（谁调用了此符号）
// - callees：被调用方查询（此符号调用了哪些符号）
// - impact：影响分析（修改此符号会影响哪些代码）
// - dispose：kill 所有活跃子进程（应用退出兜底）
//
// 设计：
// - 通过 child_process.spawn('codegraph', [...args]) 调用 codegraph CLI
// - codegraph 是本地代码智能工具（@colbymchenry/codegraph），已通过 codegraph init 索引项目
// - query 用 --json 输出结构化数据，其他命令输出 markdown 文本
// - path 必须为已初始化 codegraph 索引的项目根目录
// - 错误分类：codegraph 命令失败（超时/执行失败/退出码/JSON 解析）→ INTERNAL_ERROR
//   （注：未初始化目录暂未单独分类 INVALID_INPUT——需 codegraph 退出码语义，待分类逻辑完善）
// - 单例模式：与 FileService / GitService 一致，便于统一生命周期管理
//
// 内存泄漏防护（M5）：
// - activeProcesses 追踪所有活跃子进程，dispose 时统一 kill
// - 每条 codegraph 命令强制 60s 超时（explore/impact 可能较慢），
//   超时后 SIGTERM 子进程并 reject
// - 子进程 close/error 时主动从 activeProcesses 移除 + clearTimeout
// ──────────────────────────────────────────────────────────────

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

/** 超时后 SIGTERM 子进程并 reject（explore/impact 可能较慢） */
const CODEGRAPH_COMMAND_TIMEOUT_MS = 60_000;

/** 平台包启动命令（command + 前置 args） */
export interface CodegraphBundle {
  /** 可执行文件路径（Windows = 捆绑 node.exe；其他 = bin/codegraph 启动器） */
  readonly command: string;
  /** 前置参数（Windows liftoff 标志 + 入口，非 Windows 为空） */
  readonly args: readonly string[];
}

/**
 * 解析 codegraph 平台包启动命令（生产 process.resourcesPath / dev pnpm .pnpm）
 *
 * @colbymchenry/codegraph 以 optionalDependencies 分发各平台捆绑包
 * （vendored Node 24 + app，esbuild 同款模式）。Windows 包内含 node.exe 与
 * lib/dist/bin/codegraph.js 入口（npm-shim 同款：--liftoff-only 规避
 * tree-sitter WASM 在 Node≥22 的 Zone OOM）；其他平台为 bin/codegraph 启动器。
 */
export function resolveCodegraphBundle(): CodegraphBundle {
  const target = `${process.platform}-${process.arch}`;
  let dir: string;
  if (app.isPackaged) {
    // 生产：electron-builder extraResources 拷贝（resources/codegraph/）
    dir = join(process.resourcesPath, 'codegraph');
  } else {
    // dev：pnpm 隔离布局 node_modules/.pnpm/@colbymchenry+codegraph-<target>@*/
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

/**
 * query 方法入参
 *
 * 与 CodebaseQueryReqSchema 字段对齐，类型独立定义以便测试 mock。
 */
export interface CodebaseQueryOptions {
  /** 项目根路径（绝对路径，codegraph 索引所在目录） */
  readonly path: string;
  /** 搜索关键词 */
  readonly search: string;
  /** 最大返回结果数 */
  readonly limit: number;
  /** 按符号种类过滤（可选） */
  readonly kind: string | undefined;
}

/**
 * explore 方法入参
 */
export interface CodebaseExploreOptions {
  readonly path: string;
  /** 自然语言查询（数组形式对齐 CLI variadic 参数） */
  readonly query: readonly string[];
  /** 包含源码的最大文件数 */
  readonly maxFiles: number;
}

/**
 * node 方法入参
 *
 * 支持两种模式：
 * - 符号模式：传入 name，返回符号源码 + 调用链
 * - 文件模式：传入 file，返回文件内容 + 依赖分析
 */
export interface CodebaseNodeOptions {
  readonly path: string;
  /** 符号名（可选，省略时返回项目概览） */
  readonly name: string | undefined;
  /** 文件模式：文件路径 */
  readonly file: string | undefined;
  /** 文件模式：起始行（1-based） */
  readonly offset: number | undefined;
  /** 文件模式：最大行数 */
  readonly limit: number | undefined;
  /** 文件模式：仅返回符号映射 + 依赖 */
  readonly symbolsOnly: boolean | undefined;
}

/**
 * callers / callees 方法入参
 */
export interface CodebaseCallOptions {
  readonly path: string;
  /** 目标符号名 */
  readonly symbol: string;
  /** 最大返回结果数 */
  readonly limit: number;
}

/**
 * impact 方法入参
 */
export interface CodebaseImpactOptions {
  readonly path: string;
  readonly symbol: string;
  /** 遍历深度 */
  readonly depth: number;
}

/**
 * CodebaseService 接口
 *
 * 解耦 IPC handler 对具体类的依赖，便于：
 * - 单元测试：注入 mock 实现，不依赖真实 codegraph CLI
 * - 未来扩展：替换为其他代码智能工具（如 ctags / LSIF）
 */
export interface ICodebaseService {
  /** 结构化符号搜索 */
  query(options: CodebaseQueryOptions): Promise<CodebaseQueryRes>;
  /** 区域探索（自然语言查询） */
  explore(options: CodebaseExploreOptions): Promise<CodebaseExploreRes>;
  /** 符号详情或文件内容 */
  node(options: CodebaseNodeOptions): Promise<CodebaseNodeRes>;
  /** 调用方查询 */
  callers(options: CodebaseCallOptions): Promise<CodebaseCallersRes>;
  /** 被调用方查询 */
  callees(options: CodebaseCallOptions): Promise<CodebaseCalleesRes>;
  /** 影响分析 */
  impact(options: CodebaseImpactOptions): Promise<CodebaseImpactRes>;
  /**
   * 确保目标目录已建立 codegraph 索引（懒索引：未索引时执行 init，首次较慢）
   */
  ensureIndexed(path: string): Promise<void>;
  /**
   * 优雅关闭：kill 所有活跃子进程
   *
   * 应用退出时调用，避免 spawn 出去的 codegraph 子进程未结束导致进程退出延迟。
   * 正常完成的子进程会从 activeProcesses 自动移除，dispose 仅清理异常残留的子进程。
   */
  dispose(): Promise<void>;
}

/**
 * CodebaseService 默认实现
 *
 * 内部通过 activeProcesses 追踪所有活跃子进程：
 * - runCodegraph 启动子进程时加入 Set，close/error 时移除
 * - dispose 时统一 SIGTERM 残留子进程（应用退出兜底）
 *
 * 每条 codegraph 命令强制超时（CODEGRAPH_COMMAND_TIMEOUT_MS），避免：
 * - codegraph 索引大项目时遍历挂死
 * - 子进程异常不退出导致 Promise 永久 pending
 *
 * 错误分类：
 * - codegraph 命令执行失败：INTERNAL_ERROR
 * - stdout JSON 解析失败：INTERNAL_ERROR
 */
export class CodebaseService implements ICodebaseService {
  /**
   * 子进程启动函数（DI 注入点：测试传 fake，生产默认 node:child_process）
   * 注入而非 mock：外部依赖可替换，业务逻辑保持真实实现
   */
  private readonly spawnFn: typeof spawn;
  /** 单条命令超时（DI 注入点：测试可缩短验证超时路径） */
  private readonly commandTimeoutMs: number;
  /** 平台包定位（DI 注入点：测试传 fake 保持断言稳定；生产默认 resolveCodegraphBundle） */
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

  /**
   * 活跃子进程集合：用于 dispose 时统一清理
   *
   * 正常完成的子进程会从 Set 自动移除（close 事件触发），
   * 仅在异常退出 / dispose 调用时仍存活的子进程会留在 Set 中。
   */
  private readonly activeProcesses = new Set<ChildProcess>();
  /**
   * 索引中路径 → in-flight Promise（2026-09-08 修复）
   *
   * 并发 ensureIndexed 合并到同一 Promise，避免多个 codegraph init
   * 同时写同一 .codegraph 目录。
   */
  private readonly indexingInFlight = new Map<string, Promise<void>>();
  /**
   * 结构化符号搜索
   *
   * 调用 `codegraph query <search> -p <path> -l <limit> -k <kind> -j`
   * -j 启用 JSON 输出，解析为 CodebaseQueryResult[]。
   */
  async query(options: CodebaseQueryOptions): Promise<CodebaseQueryRes> {
    const { path, search, limit, kind } = options;

    const args = ['query', search, '-p', path];
    // limit 可选：直接调用方可能不传（与 zod schema 一致），避免拼出 '-l undefined'
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

  /**
   * 区域探索
   *
   * 调用 `codegraph explore <query...> -p <path> --max-files <n>`
   * 输出 markdown 文本（含相关符号源码 + 调用路径）。
   */
  async explore(options: CodebaseExploreOptions): Promise<CodebaseExploreRes> {
    const { path, query, maxFiles } = options;
    const args = ['explore', ...query, '-p', path];
    // maxFiles 可选：避免拼出 '--max-files undefined'
    if (maxFiles !== undefined) {
      args.push('--max-files', String(maxFiles));
    }
    const { stdout } = await this.runCodegraph(args, path);
    return { markdown: stdout };
  }

  /**
   * 符号详情或文件内容
   *
   * 符号模式：`codegraph node <name> -p <path>`
   * 文件模式：`codegraph node -p <path> -f <file> [--offset <n>] [--limit <n>] [--symbols-only]`
   */
  async node(options: CodebaseNodeOptions): Promise<CodebaseNodeRes> {
    const { path, name, file, offset, limit, symbolsOnly } = options;

    const args: string[] = ['node'];
    // name 是可选位置参数，存在时放在第一个
    if (name !== undefined && name.length > 0) {
      args.push(name);
    }
    args.push('-p', path);

    // 文件模式参数
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

  /**
   * 调用方查询
   *
   * 调用 `codegraph callers <symbol> -p <path> -l <limit>`
   * 输出 markdown 文本（调用方列表 + 调用位置）。
   */
  async callers(options: CodebaseCallOptions): Promise<CodebaseCallersRes> {
    const { path, symbol, limit } = options;
    const args = ['callers', symbol, '-p', path, '-l', String(limit)];
    const { stdout } = await this.runCodegraph(args, path);
    return { markdown: stdout };
  }

  /**
   * 被调用方查询
   *
   * 调用 `codegraph callees <symbol> -p <path> -l <limit>`
   * 输出 markdown 文本（被调用方列表 + 调用位置）。
   */
  async callees(options: CodebaseCallOptions): Promise<CodebaseCalleesRes> {
    const { path, symbol, limit } = options;
    const args = ['callees', symbol, '-p', path, '-l', String(limit)];
    const { stdout } = await this.runCodegraph(args, path);
    return { markdown: stdout };
  }

  /**
   * 影响分析
   *
   * 调用 `codegraph impact <symbol> -p <path> -d <depth>`
   * 输出 markdown 文本（影响范围分析）。
   */
  async impact(options: CodebaseImpactOptions): Promise<CodebaseImpactRes> {
    const { path, symbol, depth } = options;
    const args = ['impact', symbol, '-p', path, '-d', String(depth)];
    const { stdout } = await this.runCodegraph(args, path);
    return { markdown: stdout };
  }

  /**
   * 优雅关闭：kill 所有活跃子进程
   *
   * 应用退出时调用，避免异常残留的 codegraph 子进程句柄泄漏导致进程退出延迟。
   * 正常完成的子进程会从 activeProcesses 自动移除，dispose 仅清理异常残留。
   *
   * 幂等：多次调用安全（Set 已清空时为 no-op）。
   */
  async dispose(): Promise<void> {
    if (this.activeProcesses.size === 0) {
      return;
    }
    const processes = Array.from(this.activeProcesses);
    for (const proc of processes) {
      try {
        // SIGTERM 优雅终止（SIGKILL 会损坏子进程输出缓冲区）
        proc.kill('SIGTERM');
      } catch (error) {
        logger.warn({ error }, 'CodebaseService 子进程 kill 失败');
      }
    }
    this.activeProcesses.clear();
    logger.info({}, 'CodebaseService 所有子进程已清理');
  }

  // ─── 内部辅助方法 ───────────────────────────────────

  /**
   * 确保目标目录已建立 codegraph 索引（懒索引，方案 A）
   *
   * 检查 <path>/.codegraph 目录是否存在：
   * - 存在：直接返回（已索引）
   * - 不存在：执行 `codegraph init <path>` 建初始索引——大项目首次较慢，
   *   由 runCodegraph 的 60s 超时兜底（超时抛 AppError，工具层向 LLM 返回提示）
   *
   * 并发去重（2026-09-08 修复）：同一路径的并发调用合并为同一个 in-flight
   * Promise——此前多会话/子代理并行调用会对同一目录同时跑 `codegraph init`，
   * 多个进程并发写同一 .codegraph 索引可能产出损坏/半写索引。
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

  /**
   * 执行 codegraph 命令并返回 stdout
   *
   * @param args codegraph 命令参数（如 ['query', 'AgentService', '-j']）
   * @param cwd 工作目录（同时作为 -p 参数已传入 args）
   * @returns stdout 输出（字符串）
   * @throws AppError(INTERNAL_ERROR) codegraph 命令执行失败
   */
  private runCodegraph(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      // 平台包定位（DI 可注入）：Windows 用捆绑 node.exe + liftoff 标志（npm-shim 同款），
      // 其他平台用 bin/codegraph——生产走 resourcesPath，dev 走 .pnpm，不再依赖 PATH
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

      // 超时控制：60s 内未完成则 SIGTERM 子进程并 reject
      // 避免 codegraph 遍历大项目挂死或子进程异常不退出导致 Promise 永久 pending
      const timeoutId = setTimeout(() => {
        try {
          child.kill('SIGTERM');
        } catch {
          // 子进程可能已退出，kill 失败忽略
        }
        reject(
          new AppError(
            ErrorCode.INTERNAL_ERROR,
            `codegraph 命令超时（${this.commandTimeoutMs}ms）`,
            undefined,
            { args, cwd },
          ),
        );
      }, this.commandTimeoutMs);

      // 统一清理逻辑：清超时定时器 + 从 activeProcesses 移除
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

  /**
   * 解析 codegraph query --json 输出
   *
   * 输出格式：CodebaseQueryResult[] 的 JSON 字符串
   * 空结果时 codegraph 可能输出 '[]' 或空字符串，统一兜底为空数组。
   *
   * @throws AppError(INTERNAL_ERROR) JSON 解析失败
   */
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
      // 信任 codegraph 输出结构（已通过 schema 校验入参，CLI 输出格式由版本保证）
      return parsed as CodebaseQueryResult[];
    } catch (error) {
      throw new AppError(ErrorCode.INTERNAL_ERROR, 'codegraph query JSON 解析失败', error, {
        stdout: trimmed.slice(0, 500),
      });
    }
  }
}

/** CodebaseService 单例（内部按具体实现类持有，外部暴露为 ICodebaseService 接口） */
let codebaseService: CodebaseService | null = null;

/**
 * 获取 CodebaseService 单例
 *
 * 整个应用生命周期共享一个实例。
 *
 * 返回类型为 ICodebaseService 接口而非具体类：
 * - 强制调用方面向接口编程，不依赖 CodebaseService 内部细节
 * - ServiceContainer 注入到 IPC handler 时类型一致
 */
export function getCodebaseService(): ICodebaseService {
  if (codebaseService === null) {
    codebaseService = new CodebaseService();
  }
  return codebaseService;
}

/**
 * 重置 CodebaseService（仅测试用）
 *
 * 仅清空单例缓存。dispose 由 ServiceContainer 单独 await 调用
 * （与 resetGitService 风格一致）。
 */
export function resetCodebaseService(): void {
  codebaseService = null;
}
