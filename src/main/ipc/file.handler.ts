import type { InferHandlers, IPC_DEFINITIONS } from '@code-agent/shared/main';
import { AppError, ErrorCode } from '@code-agent/shared/main';

import { resolveWithinWorkspace } from '../infra/ai/tools/path-guard';
import type { IFileService } from '../infra/file/file-service';
import { normalizeTreeIgnorePatterns } from '../infra/file/tree-ignore';
import { matchUserGrantedReadPath } from '../infra/file/user-grants';
import { readSetting } from '../infra/storage/settings-pref';
import type { IpcHandlerContext } from '../utils/wrap';

/**
 * 文件域 handler 依赖
 *
 * 通过依赖注入解耦 handler 与具体 FileService 实现：
 * - 生产环境：ServiceContainer 注入默认 FileService 实例
 * - 测试环境：可注入 mock 实现，不依赖真实文件系统
 */
export interface FileHandlerDeps {
  /** FileService 实例（由 ServiceContainer 注入） */
  readonly fileService: IFileService;
  /**
   * 可选：工作区根集合提供者（边界来源）
   *
   * 缺省实现读取会话 workingDir 集合（见 defaultWorkspaceRoots）；
   * 测试或多根工作区可注入自定义实现。返回绝对路径数组。
   */
  readonly workspaceRoots?: () => Promise<readonly string[]>;
}

/** 工作区根集合缓存 TTL：文件树展开会在毫秒级多次调用 list，避免每次查库 */
const ROOTS_TTL_MS = 2000;

/** 会话 workingDir 集合缓存（模块级：所有 handler 实例共享同一份边界） */
let rootsCache: { readonly at: number; readonly roots: readonly string[] } | null = null;

/**
 * 默认边界来源：会话表中出现过的 workingDir（最近 50 个）
 *
 * - 动态 import session-service：避免单测 / 非 Electron 环境把 electron + DB 拉进模块图
 * - 任何异常（DB 未初始化等）→ 空集合，由 confineToWorkspace fail closed
 */
export async function defaultWorkspaceRoots(): Promise<readonly string[]> {
  const now = Date.now();
  if (rootsCache !== null && now - rootsCache.at < ROOTS_TTL_MS) {
    return rootsCache.roots;
  }
  let roots: readonly string[] = [];
  try {
    const { getSessionService } = await import('../infra/storage/session-service');
    const res = await getSessionService().listRecentDirs({ limit: 50 });
    roots = res.dirs.map((dir) => dir.workingDir).filter((dir) => dir.length > 0);
  } catch {
    roots = [];
  }
  rootsCache = { at: now, roots };
  return roots;
}

/** confineToWorkspace 可选行为 */
export interface ConfineOptions {
  /**
   * 是否查询「用户手势授权」表（仅 file:read 置 true）
   *
   * true 时：路径若为用户用原生对话框亲手选中并登记过的精确文件，直接放行——
   * 这是工作区外文件（聊天附件）的唯一合法读取通道，授权来源在主进程，渲染层无法伪造。
   */
  readonly allowUserGrant?: boolean;
}

/**
 * 将渲染层传入的路径收口到工作区内
 *
 * @param inputPath 渲染层路径（相对或绝对）
 * @param rootsProvider 边界来源
 * @param opts 可选行为（allowUserGrant：登记过的用户选中路径放行）
 * @returns 通过校验的绝对路径（交给 FileService 的即此值）
 * @throws AppError(UNAUTHORIZED) 越界 / 无任何工作区根（fail closed）
 * @throws AppError(INVALID_INPUT) 空路径（由 resolveWithinWorkspace 抛出）
 */
export async function confineToWorkspace(
  inputPath: string,
  rootsProvider: () => Promise<readonly string[]>,
  opts?: ConfineOptions,
): Promise<string> {
  if (opts?.allowUserGrant === true) {
    const granted = matchUserGrantedReadPath(inputPath);
    if (granted !== null) return granted;
  }
  const roots = await rootsProvider();
  if (roots.length === 0) {
    throw new AppError(
      ErrorCode.UNAUTHORIZED,
      `无法确定工作区边界（无会话工作目录），已拒绝访问：${inputPath}`,
    );
  }
  let lastDenied: AppError | null = null;
  for (const root of roots) {
    try {
      return resolveWithinWorkspace(inputPath, root).resolved;
    } catch (error: unknown) {
      if (error instanceof AppError && error.code === ErrorCode.UNAUTHORIZED) {
        lastDenied = error;
        continue;
      }
      throw error;
    }
  }
  throw (
    lastDenied ?? new AppError(ErrorCode.UNAUTHORIZED, `路径越权访问：${inputPath} 超出工作区范围`)
  );
}

/**
 * 构建路径收口函数对
 *
 * - guard：写/列/删/改名一律严格，只看工作区边界
 * - guardRead：读取专用，额外允许命中「用户手势授权」表。只有 read 走这条通道——
 *   用户原生对话框选中的工作区外附件才读得到；写/删/改名不查该表，
 *   避免授权面从「读一个文件」扩成「改一个文件」。
 */
function makePathGuards(rootsProvider: () => Promise<readonly string[]>) {
  const guard = (path: string): Promise<string> => confineToWorkspace(path, rootsProvider);
  const guardRead = (path: string): Promise<string> =>
    confineToWorkspace(path, rootsProvider, { allowUserGrant: true });
  return { guard, guardRead };
}

/**
 * 创建文件域 handler 实现
 *
 * @param deps 依赖项：包含 IFileService 实例与可选工作区根提供者
 */
export function createFileHandlers(
  deps: FileHandlerDeps,
): InferHandlers<typeof IPC_DEFINITIONS, IpcHandlerContext>['file'] {
  const { fileService } = deps;
  const { guard, guardRead } = makePathGuards(deps.workspaceRoots ?? defaultWorkspaceRoots);

  return {
    read: async (input) => {
      return fileService.read({
        path: await guardRead(input.path),
        offset: input.offset,
        limit: input.limit,
      });
    },

    write: async (input) => {
      return fileService.write({
        path: await guard(input.path),
        content: input.content,
        append: input.append,
        createDirs: input.createDirs,
      });
    },

    list: async (input) => {
      let userPatterns: string[] = [];
      try {
        const workspace = readSetting('workspace') as { treeIgnorePatterns?: unknown } | undefined;
        userPatterns = normalizeTreeIgnorePatterns(workspace?.treeIgnorePatterns);
      } catch {}
      return fileService.list({
        path: await guard(input.path),
        depth: input.depth,
        includeHidden: input.includeHidden,
        ...(userPatterns.length > 0 ? { ignorePatterns: userPatterns } : {}),
      });
    },

    watchStart: async (input, ctx) => {
      const handle = await fileService.watch({
        path: await guard(input.path),
        webContents: ctx.sender,
      });
      return { watcherId: handle.watcherId };
    },

    watchStop: async (input) => {
      const stopped = fileService.unwatch(input.watcherId);
      return { stopped };
    },

    create: async (input) => {
      return fileService.createFile({
        path: await guard(input.path),
        createDirs: input.createDirs,
      });
    },

    createDir: async (input) => {
      return fileService.createDir({
        path: await guard(input.path),
      });
    },

    delete: async (input) => {
      return fileService.delete({
        path: await guard(input.path),
        recursive: input.recursive,
      });
    },

    rename: async (input) => {
      return fileService.rename({
        oldPath: await guard(input.oldPath),
        newPath: await guard(input.newPath),
        overwrite: input.overwrite,
      });
    },
  };
}
