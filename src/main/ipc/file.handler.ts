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

import type { InferHandlers, IPC_DEFINITIONS } from '@code-agent/shared/main';

import type { IFileService } from '../infra/file/file-service';
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
}

/**
 * 创建文件域 handler 实现
 *
 * @param deps 依赖项：包含 IFileService 实例
 */
export function createFileHandlers(
  deps: FileHandlerDeps,
): InferHandlers<typeof IPC_DEFINITIONS, IpcHandlerContext>['file'] {
  const { fileService } = deps;

  return {
    // 读取文件：支持大文件分批读取（offset/limit）
    // 入参由 FileReadReqSchema 校验（path 非空、offset/limit 为非负整数）
    // 返回文件内容（UTF-8 解码）+ 总行数（渲染层据此判断是否分批）
    read: async (input) => {
      return fileService.read({
        path: input.path,
        offset: input.offset,
        limit: input.limit,
      });
    },

    // 写入文件：覆盖或追加
    // append=true 时使用 O_APPEND 模式追加，避免覆盖已有内容
    // createDirs=true 时自动创建父目录（避免 ENOENT）
    write: async (input) => {
      return fileService.write({
        path: input.path,
        content: input.content,
        append: input.append,
        createDirs: input.createDirs,
      });
    },

    // 列出目录内容：递归深度可控（默认 1 层，最大 10 层）
    // includeHidden=false 时跳过 .git / .vscode 等隐藏文件/目录
    list: async (input) => {
      return fileService.list({
        path: input.path,
        depth: input.depth,
        includeHidden: input.includeHidden,
      });
    },

    // 开始文件监听：基于 chokidar v5 监听指定目录
    // 关键：传入 ctx.sender（WebContents）作为事件推送目标，
    // 后续文件变更会通过 file:watch:event 事件推送到该 webContents
    // 返回 watcherId，渲染层用此 id 关联后续事件并在停止时传给 watchStop
    watchStart: async (input, ctx) => {
      const handle = await fileService.watch({
        path: input.path,
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
        path: input.path,
        createDirs: input.createDirs,
      });
    },

    // 创建新目录：递归创建父目录（mkdir -p 语义）
    createDir: async (input) => {
      return fileService.createDir({
        path: input.path,
      });
    },

    // 删除文件或目录：recursive=true（默认）递归删除目录
    delete: async (input) => {
      return fileService.delete({
        path: input.path,
        recursive: input.recursive,
      });
    },

    // 重命名/移动：overwrite=false（默认）时目标已存在则报错
    rename: async (input) => {
      return fileService.rename({
        oldPath: input.oldPath,
        newPath: input.newPath,
        overwrite: input.overwrite,
      });
    },
  };
}
