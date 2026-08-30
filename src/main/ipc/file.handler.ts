// src/main/ipc/file.handler.ts
// 文件域 IPC handler（FileService 暴露给渲染层的入口，定义表驱动）
//
// 实现 9 个请求-响应方法：
// - read        读取文件内容（支持 offset/limit 分批）
// - write       写入文件（覆盖或追加，可选自动创建父目录）
// - list        递归列出目录内容（深度可控）
// - watchStart  开始监听文件变更，返回 watcherId
// - watchStop   停止指定 watcherId 的监听
// - create      创建新文件（空文件，若已存在则报错）
// - createDir   创建新目录（递归创建父目录）
// - delete      删除文件或目录（目录递归删除）
// - rename      重命名/移动文件或目录
//
// 流式事件由 FileService 主动推送（不在此 handler 返回）：
// - file:watch:event  文件变更事件（携带 watcherId 关联）
//
// 设计要点：
// - DI 模式：通过 ServiceContainer 注入 IFileService 实例
// - watchStart 需要使用 ctx.sender（WebContents）传给 FileService.watch()，
//   后续文件变更事件会通过该 webContents.send 推送回渲染层
// - handler 内不直接调用 webContents.send，所有事件推送由 FileService 内部处理
//   （保持 handler 简单 + 关注点分离）
//
// ── P0 安全：渲染层文件 API 工作区收口 ──────────────────────────
// FileService 本身只校验「绝对路径」（assertAbsolutePath），不校验边界：
// agent 工具路径由 path-guard 在工具层收口，而渲染层直接调用 file:* 时
// 此前可以读写/删除任意磁盘路径（含 C:\Users\<u>\.ssh\*）。
// 现在所有带 path 的入参在 handler 层统一经过 resolveWithinWorkspace 收口：
// - 边界集合 = 会话绑定过的 workingDir 并集（session:listRecentDirs 同源）
// - 复用 path-guard 同一份解析逻辑（相对路径、../ 遍历、realpath 二次校验），
//   避免两套边界实现漂移
// - 越界抛 AppError(UNAUTHORIZED)，由 wrap 转成标准 IPC 错误
// - 拿不到任何根目录时 fail closed（拒绝一切访问），而不是放开
// 已知边界代价（诚实记录，非沙箱）：
// 1. 收口粒度是「历史打开过的项目集合」，不是「当前窗口正在使用的项目」——
//    IpcHandlerContext 只有 traceId + sender，主进程无法得知渲染层当前会话，
//    要收窄到单会话需改 wrap.ts/定义表由渲染层显式携带 sessionId（跨 owner 协作项）
// 2. 通过 dialog:pickFiles 选中的工作区外文件（聊天附件）会被拒绝读取，
//    需要「用户显式授权单次路径」机制才能真正支持；当前降级表现为附件读取失败。
// ──────────────────────────────────────────────────────────────

import type { InferHandlers, IPC_DEFINITIONS } from '@code-agent/shared/main';
import { AppError, ErrorCode } from '@code-agent/shared/main';

import { resolveWithinWorkspace } from '../infra/ai/tools/path-guard';
import type { IFileService } from '../infra/file/file-service';
import { normalizeTreeIgnorePatterns } from '../infra/file/tree-ignore';
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
    // 查询失败 ≠ 「无边界」：返回空集，调用侧一律拒绝
    roots = [];
  }
  rootsCache = { at: now, roots };
  return roots;
}

/**
 * 将渲染层传入的路径收口到工作区内
 *
 * @param inputPath 渲染层路径（相对或绝对）
 * @param rootsProvider 边界来源
 * @returns 通过校验的绝对路径（交给 FileService 的即此值）
 * @throws AppError(UNAUTHORIZED) 越界 / 无任何工作区根（fail closed）
 * @throws AppError(INVALID_INPUT) 空路径（由 resolveWithinWorkspace 抛出）
 */
export async function confineToWorkspace(
  inputPath: string,
  rootsProvider: () => Promise<readonly string[]>,
): Promise<string> {
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
      // 多根语义：任一根内即为合法（相对路径按「第一个命中的根」解析）
      return resolveWithinWorkspace(inputPath, root);
    } catch (error: unknown) {
      if (error instanceof AppError && error.code === ErrorCode.UNAUTHORIZED) {
        lastDenied = error;
        continue;
      }
      // 非越界错误（如空路径 INVALID_INPUT）直接透出，不被多根循环吞掉
      throw error;
    }
  }
  throw (
    lastDenied ?? new AppError(ErrorCode.UNAUTHORIZED, `路径越权访问：${inputPath} 超出工作区范围`)
  );
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
  const rootsProvider = deps.workspaceRoots ?? defaultWorkspaceRoots;
  /** 单路径收口 */
  const guard = (path: string): Promise<string> => confineToWorkspace(path, rootsProvider);

  return {
    // 读取文件：支持大文件分批读取（offset/limit）
    // 入参由 FileReadReqSchema 校验（path 非空、offset/limit 为非负整数）
    // 返回文件内容（UTF-8 解码）+ 总行数（渲染层据此判断是否分批）
    read: async (input) => {
      return fileService.read({
        path: await guard(input.path),
        offset: input.offset,
        limit: input.limit,
      });
    },

    // 写入文件：覆盖或追加
    // append=true 时使用 O_APPEND 模式追加，避免覆盖已有内容
    // createDirs=true 时自动创建父目录（避免 ENOENT）
    write: async (input) => {
      return fileService.write({
        path: await guard(input.path),
        content: input.content,
        append: input.append,
        createDirs: input.createDirs,
      });
    },

    // 列出目录内容：递归深度可控（默认 1 层，最大 10 层）
    // includeHidden=false 时跳过 .git / .vscode 等隐藏文件/目录
    list: async (input) => {
      // 忽略模式：现读用户设置（workspace.treeIgnorePatterns）——改后下一次 list 即生效。
      // 读取失败（DB 异常等）降级为无用户模式，不阻断文件树；内置 node_modules 基线由 service 合并
      let userPatterns: string[] = [];
      try {
        const workspace = readSetting('workspace') as { treeIgnorePatterns?: unknown } | undefined;
        userPatterns = normalizeTreeIgnorePatterns(workspace?.treeIgnorePatterns);
      } catch {
        // 降级路径
      }
      return fileService.list({
        path: await guard(input.path),
        depth: input.depth,
        includeHidden: input.includeHidden,
        ...(userPatterns.length > 0 ? { ignorePatterns: userPatterns } : {}),
      });
    },

    // 开始文件监听：基于 chokidar v5 监听指定目录
    // 关键：传入 ctx.sender（WebContents）作为事件推送目标，
    // 后续文件变更会通过 file:watch:event 事件推送到该 webContents
    // 返回 watcherId，渲染层用此 id 关联后续事件并在停止时传给 watchStop
    watchStart: async (input, ctx) => {
      const handle = await fileService.watch({
        path: await guard(input.path),
        webContents: ctx.sender,
      });
      return { watcherId: handle.watcherId };
    },

    // 停止指定 watcher：通过 watcherId 定位并关闭对应的 chokidar watcher
    // 返回 stopped=true 表示成功停止，stopped=false 表示 watcherId 不存在（可能已自动停止）
    watchStop: async (input) => {
      const stopped = fileService.unwatch(input.watcherId);
      return { stopped };
    },

    // 创建新文件：空文件，已存在时抛 ALREADY_EXISTS
    // createDirs=true 时自动创建父目录
    create: async (input) => {
      return fileService.createFile({
        path: await guard(input.path),
        createDirs: input.createDirs,
      });
    },

    // 创建新目录：递归创建父目录（mkdir -p 语义）
    createDir: async (input) => {
      return fileService.createDir({
        path: await guard(input.path),
      });
    },

    // 删除文件或目录：recursive 必填（P0 契约，schema 已收紧）——
    // true 递归删除目录；false 仅空目录/文件（非空抛 ENOTEMPTY）
    delete: async (input) => {
      return fileService.delete({
        path: await guard(input.path),
        recursive: input.recursive,
      });
    },

    // 重命名/移动：overwrite=false（默认）时目标已存在则报错
    // P0：源与目标都必须在工作区内——只校验一侧等于允许
    // 「把工作区外文件移进来」或「把工作区文件搬到工作区外」
    rename: async (input) => {
      return fileService.rename({
        oldPath: await guard(input.oldPath),
        newPath: await guard(input.newPath),
        overwrite: input.overwrite,
      });
    },
  };
}
