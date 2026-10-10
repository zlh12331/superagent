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

const ROOTS_TTL_MS = 2000;

let rootsCache: { readonly at: number; readonly roots: readonly string[] } | null = null;

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

export interface ConfineOptions {
  readonly allowUserGrant?: boolean;
}

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

function makePathGuards(rootsProvider: () => Promise<readonly string[]>) {
  const guard = (path: string): Promise<string> => confineToWorkspace(path, rootsProvider);
  const guardRead = (path: string): Promise<string> =>
    confineToWorkspace(path, rootsProvider, { allowUserGrant: true });
  return { guard, guardRead };
}

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
