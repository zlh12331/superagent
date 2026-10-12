// file.handler.ts：file 域 IPC——读写/列举/监听/建删改名，全部方法过工作区路径守卫后才进 fileService
// 边界：守卫逻辑（confineToWorkspace）也导出给 IPC 之外的调用方（如集成层）复用
import type { InferHandlers, IPC_DEFINITIONS } from '@code-agent/shared/main';
import { AppError, ErrorCode } from '@code-agent/shared/main';

import { resolveWithinWorkspace } from '../infra/ai/tools/path-guard';
import type { IFileService } from '../infra/file/file-service';
import { normalizeTreeIgnorePatterns } from '../infra/file/tree-ignore';
import { matchUserGrantedReadPath } from '../infra/file/user-grants';
import { readSetting } from '../infra/storage/settings-pref';
import type { IpcHandlerContext } from '../utils/wrap';

export interface FileHandlerDeps {
  readonly fileService: IFileService;
  readonly workspaceRoots?: () => Promise<readonly string[]>;
}

// 工作区根列表短 TTL 缓存：listRecentDirs 是 DB 查询，而 guard 在每个文件操作前都要跑
const ROOTS_TTL_MS = 2000;

let rootsCache: { readonly at: number; readonly roots: readonly string[] } | null = null;

/** 默认工作区根 = 最近 50 个会话的工作目录（动态导入防启动期循环依赖） */
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

/** 读路径 confinement 选项：allowUserGrant = 用户经对话框选过的路径直接放行 */
export interface ConfineOptions {
  readonly allowUserGrant?: boolean;
}

/**
 * 把路径约束到工作区：依次尝试每个会话工作目录，全部越界才拒绝；
 * allowUserGrant 时先查用户手动授权清单（对话框选择），命中即放行（不再要求在工作区内）
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

// 双守卫：guard = 严格工作区内（写/删/改名）；guardRead = 额外认用户授权路径（只读放行）
function makePathGuards(rootsProvider: () => Promise<readonly string[]>) {
  const guard = (path: string): Promise<string> => confineToWorkspace(path, rootsProvider);
  const guardRead = (path: string): Promise<string> =>
    confineToWorkspace(path, rootsProvider, { allowUserGrant: true });
  return { guard, guardRead };
}

/** 依赖注入工厂：workspaceRoots 可注入（测试），缺省用最近会话目录 */
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
