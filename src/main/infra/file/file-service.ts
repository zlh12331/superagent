// src/main/infra/file/file-service.ts
// FileService：主进程文件读写 + 目录列表 + 文件监听能力
// ──────────────────────────────────────────────────────────────
// 职责：
// - read：读取文件内容（支持大文件分批读取 offset/limit）
// - write：写入文件（覆盖 / 追加，可选自动创建父目录）
// - list：递归列出目录内容（深度可控，可包含隐藏文件）
// - watch / unwatch：基于 chokidar v5 监听文件变更，推送 file:watch 事件
// - dispose：统一清理所有 watcher（应用退出时调用）
//
// 设计：
// - 接口化（IFileService）：与 IChatService 一致，便于测试 mock 与未来替换实现
// - 单例模式：通过 getFileService() 获取，整个应用生命周期共享一个实例
// - 错误分类：把 Node.js 原生 errno 映射到项目 ErrorCode（NOT_FOUND / UNAUTHORIZED / FS_*）
// - 路径校验：当前 P2 阶段仅做基础校验（非空、绝对路径），workingDir 边界检查
//   由后续 P3 PermissionService 统一引入（避免越权访问）
// - 文件监听：chokidar v5 是 ESM，事件名需映射到 file:watch payload
//   （'add'/'addDir' → 'create'，'change' → 'modify'，'unlink'/'unlinkDir' → 'delete'）
// ──────────────────────────────────────────────────────────────

import { randomUUID } from 'node:crypto';
import { promises as fs, type Stats } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type {
  FileCreateDirRes,
  FileCreateRes,
  FileDeleteRes,
  FileEntry,
  FileListRes,
  FileReadRes,
  FileRenameRes,
  FileWatchEventPayload,
  FileWriteRes,
} from '@code-agent/shared/main';
import { AppError, ErrorCode, IPC_DEFINITIONS } from '@code-agent/shared/main';
import chardet from 'chardet';
import { type FSWatcher, watch } from 'chokidar';
import type { WebContents } from 'electron';
import iconv from 'iconv-lite';
import { emitEvent } from '../../utils/emit-event';
import { logger } from '../../utils/logger';

/** UTF-8 同族编码（chardet 检测结果 → 无需转码直接解码） */
const UTF8_LIKE_ENCODINGS = new Set(['UTF-8', 'ASCII']);

/**
 * 规范化 chardet 检测结果 → iconv-lite 可解码的编码名
 *
 * - null / UTF-8 同族 → 'utf-8'（直接 Buffer.toString）
 * - 其他（GB2312/GB18030/windows-1252 等）→ 小写（iconv-lite 兼容大小写）
 */
function normalizeEncoding(detected: string | null): string {
  if (detected === null || UTF8_LIKE_ENCODINGS.has(detected)) {
    return 'utf-8';
  }
  return detected.toLowerCase();
}

/**
 * read 方法入参
 *
 * 注意：与 FileReadReqSchema 字段对齐，但类型独立定义以便测试 mock。
 * offset/limit 用 `number | undefined` 而非 `?: number` 兼容 exactOptionalPropertyTypes。
 */
export interface FileReadOptions {
  /** 文件绝对路径 */
  readonly path: string;
  /** 起始行（0-based），省略时从第 0 行开始 */
  readonly offset: number | undefined;
  /** 读取行数，省略时读到文件末尾 */
  readonly limit: number | undefined;
}

/** write 方法入参（与 FileWriteReqSchema 字段对齐） */
export interface FileWriteOptions {
  readonly path: string;
  readonly content: string;
  /** 是否追加（默认 false 覆盖） */
  readonly append: boolean;
  /** 是否自动创建父目录（默认 true） */
  readonly createDirs: boolean;
}

/** list 方法入参（与 FileListReqSchema 字段对齐） */
export interface FileListOptions {
  readonly path: string;
  /** 递归深度（1=仅直接子项，最大 10） */
  readonly depth: number;
  /** 是否包含隐藏文件（点开头文件/目录） */
  readonly includeHidden: boolean;
}

/** watch 方法入参 */
export interface FileWatchOptions {
  /** 监听根目录（绝对路径） */
  readonly path: string;
  /** 接收 file:watch 事件的 webContents（通常是发起请求的窗口） */
  readonly webContents: WebContents;
}

/** watch 方法返回值：watcherId 用于后续 unwatch */
export interface FileWatchHandle {
  /** watcher 唯一 ID（用于 unwatch 时定位） */
  readonly watcherId: string;
}

/** createFile 方法入参 */
export interface FileCreateOptions {
  /** 文件绝对路径（父目录不存在时自动创建） */
  readonly path: string;
  /** 是否自动创建父目录（默认 true） */
  readonly createDirs: boolean;
}

/** createDir 方法入参 */
export interface FileCreateDirOptions {
  /** 目录绝对路径（递归创建父目录） */
  readonly path: string;
}

/** delete 方法入参 */
export interface FileDeleteOptions {
  /** 目标绝对路径（文件或目录） */
  readonly path: string;
  /** 是否递归删除目录（必填：true 递归删除；false 仅空目录/文件） */
  readonly recursive: boolean;
}

/** rename 方法入参 */
export interface FileRenameOptions {
  /** 原路径（绝对路径） */
  readonly oldPath: string;
  /** 新路径（绝对路径） */
  readonly newPath: string;
  /** 目标已存在时是否覆盖（默认 false） */
  readonly overwrite: boolean;
}

/**
 * FileService 接口
 *
 * 解耦 IPC handler 对具体类的依赖，便于：
 * - 单元测试：注入 mock 实现，不依赖真实文件系统
 * - 未来扩展：替换为支持远程文件系统 / 内存 FS 的实现
 */
export interface IFileService {
  /** 读取文件内容（UTF-8 解码，支持分批读取） */
  read(options: FileReadOptions): Promise<FileReadRes>;
  /** 写入文件（覆盖或追加） */
  write(options: FileWriteOptions): Promise<FileWriteRes>;
  /** 列出目录内容（递归深度可控） */
  list(options: FileListOptions): Promise<FileListRes>;
  /** 监听文件变更，返回 watcherId */
  watch(options: FileWatchOptions): Promise<FileWatchHandle>;
  /** 停止指定 watcher */
  unwatch(watcherId: string): boolean;
  /** 优雅关闭：停止所有 watcher 并释放资源 */
  dispose(): Promise<void>;
  /** 创建新文件（空文件，若已存在则报错） */
  createFile(options: FileCreateOptions): Promise<FileCreateRes>;
  /** 创建新目录（递归创建父目录） */
  createDir(options: FileCreateDirOptions): Promise<FileCreateDirRes>;
  /** 删除文件或目录（目录递归删除） */
  delete(options: FileDeleteOptions): Promise<FileDeleteRes>;
  /** 重命名/移动文件或目录 */
  rename(options: FileRenameOptions): Promise<FileRenameRes>;
}

/**
 * FileService 默认实现
 *
 * 内部维护 watcherId → { watcher, webContents } 映射，支持多窗口独立监听。
 *
 * 错误分类：
 * - ENOENT（文件不存在）：NOT_FOUND
 * - EACCES / EPERM（权限不足）：UNAUTHORIZED
 * - ENOSPC（磁盘满）：FS_DISK_FULL
 * - ENOTDIR（路径不是目录）：INVALID_INPUT
 * - EISDIR（对目录执行文件操作）：INVALID_INPUT
 * - 其他读错误：FS_READ_FAILED
 * - 其他写错误：FS_WRITE_FAILED
 */
class FileService implements IFileService {
  /**
   * 活跃 watcher Map：watcherId → watcher 上下文
   *
   * 每个 watcher 独立关联一个 webContents，避免：
   * - 多窗口同时监听同一目录时互相干扰
   * - 单个 webContents 销毁后影响其他窗口的监听
   */
  private readonly watchers = new Map<
    string,
    {
      readonly watcher: FSWatcher;
      readonly webContents: WebContents;
      /** webContents destroyed 监听清理函数（unwatch 时移除，避免监听累积） */
      readonly removeDestroyedListener: () => void;
    }
  >();

  /**
   * 读取文件内容（自动编码检测）
   *
   * 流程：
   * 1. 读取整个文件为 Buffer
   * 2. chardet 检测编码（Windows 场景支持 GBK/GB18030 等非 UTF-8 文件）
   * 3. UTF-8 同族直接解码；其他编码经 iconv-lite 转码
   * 4. 按换行符分割为行数组，应用 offset/limit 切片
   * 5. 返回切片后的内容 + 总行数 + 实际编码
   *
   * 注意：当前实现一次性读取整个文件到内存，超大文件（>100MB）可能 OOM。
   */
  async read(options: FileReadOptions): Promise<FileReadRes> {
    const { path, offset, limit } = options;
    // 基础校验：路径必须为绝对路径
    this.assertAbsolutePath(path);

    try {
      const buffer = await fs.readFile(path);
      // 编码检测：chardet 返回 null（ASCII/无法识别）→ 按 UTF-8 处理
      const detected = chardet.detect(buffer);
      const encoding = normalizeEncoding(detected);

      let content: string;
      if (encoding === 'utf-8') {
        content = buffer.toString('utf-8');
      } else {
        // 非 UTF-8（GBK/GB18030 等）：iconv-lite 转码，失败回退 UTF-8 并告警
        try {
          content = iconv.decode(buffer, encoding);
        } catch (decodeError) {
          logger.warn({ path, encoding, error: decodeError }, '编码转码失败，回退 UTF-8');
          content = buffer.toString('utf-8');
        }
      }

      // 按换行符分割（保留 \r\n 与 \n 两种情况）
      // 不使用 split('\n') 是为了避免行尾 \r 残留影响渲染层渲染
      const lines = content.split(/\r?\n/);
      const totalLines = lines.length;

      // 应用 offset/limit 切片
      const start = offset ?? 0;
      // offset 超出范围时返回空字符串（不视为错误）
      if (start >= totalLines) {
        return { content: '', totalLines, encoding };
      }
      const end = limit === undefined ? totalLines : Math.min(start + limit, totalLines);
      const sliced = lines.slice(start, end);
      // 重新拼接为字符串（用 \n 统一行尾，避免 \r\n 混杂）
      return { content: sliced.join('\n'), totalLines, encoding };
    } catch (error) {
      throw this.classifyReadError(error);
    }
  }

  /**
   * 写入文件
   *
   * append=false：覆盖写入（默认）
   * append=true：追加写入（在文件末尾追加）
   * createDirs=true：自动创建父目录（避免 ENOENT）
   */
  async write(options: FileWriteOptions): Promise<FileWriteRes> {
    const { path, content, append, createDirs } = options;
    this.assertAbsolutePath(path);

    try {
      // 自动创建父目录
      if (createDirs) {
        await fs.mkdir(dirname(path), { recursive: true });
      }

      // 写入文件（覆盖或追加）
      // Buffer.byteLength 计算 UTF-8 字节数（与文件系统实际写入一致）
      const buffer = Buffer.from(content, 'utf-8');
      if (append) {
        // O_APPEND 模式：文件不存在时会创建
        // 使用 { flag: 'a' } 而非 fs.appendFile，便于统一错误处理
        await fs.writeFile(path, buffer, { flag: 'a' });
      } else {
        await fs.writeFile(path, buffer);
      }

      return { bytesWritten: buffer.byteLength };
    } catch (error) {
      throw this.classifyWriteError(error);
    }
  }

  /**
   * 列出目录内容
   *
   * 递归读取目录，返回 FileEntry 数组。
   * depth 控制递归深度：
   * - 1：仅列出直接子项
   * - N：递归 N 层
   *
   * includeHidden=false：跳过点开头文件/目录（.git, .vscode 等）
   */
  async list(options: FileListOptions): Promise<FileListRes> {
    const { path, depth, includeHidden } = options;
    this.assertAbsolutePath(path);

    try {
      const entries: FileEntry[] = [];
      await this.listRecursive(path, depth, includeHidden, entries);
      return { entries };
    } catch (error) {
      throw this.classifyReadError(error);
    }
  }

  /**
   * 递归列出目录内容的内部实现
   *
   * @param currentPath 当前正在遍历的目录
   * @param remainingDepth 剩余深度（0 时停止递归）
   * @param includeHidden 是否包含隐藏文件
   * @param output 输出数组（递归填充）
   */
  private async listRecursive(
    currentPath: string,
    remainingDepth: number,
    includeHidden: boolean,
    output: FileEntry[],
  ): Promise<void> {
    // 深度耗尽，停止递归
    if (remainingDepth <= 0) {
      return;
    }

    const items = await fs.readdir(currentPath, { withFileTypes: true });
    for (const item of items) {
      // 跳过隐藏文件（除非显式要求包含）
      if (!includeHidden && item.name.startsWith('.')) {
        continue;
      }

      const itemPath = join(currentPath, item.name);
      const stats = await fs.stat(itemPath);

      // 根据 dirent 类型映射 FileEntry.type
      // 注意：isSymbolicLink() 时 stats 仍是 lstat 结果（不解析目标）
      let type: FileEntry['type'];
      if (item.isSymbolicLink()) {
        type = 'symlink';
      } else if (item.isDirectory()) {
        type = 'directory';
      } else {
        type = 'file';
      }

      output.push({
        name: item.name,
        path: itemPath,
        type,
        size: stats.size,
        // Unix timestamp（毫秒）
        modifiedAt: stats.mtimeMs,
      });

      // 递归子目录
      if (item.isDirectory()) {
        await this.listRecursive(itemPath, remainingDepth - 1, includeHidden, output);
      }
    }
  }

  /**
   * 监听文件变更
   *
   * 基于 chokidar v5，监听指定目录及其子目录。
   * 事件映射：
   * - chokidar 'add' / 'addDir' → file:watch 'create'
   * - chokidar 'change' → file:watch 'modify'
   * - chokidar 'unlink' / 'unlinkDir' → file:watch 'delete'
   * - chokidar 不直接支持 'rename'，rename 会被拆分为 unlink + add
   *
   * 默认忽略：
   * - 点开头文件/目录（.git, .vscode 等）
   * - node_modules 目录（避免大型依赖库频繁变更）
   *
   * 注意：chokidar 默认 ignoreInitial=false 会触发初始扫描事件，
   * 这里显式设置 ignoreInitial: true 避免大量初始推送。
   */
  async watch(options: FileWatchOptions): Promise<FileWatchHandle> {
    const { path, webContents } = options;
    this.assertAbsolutePath(path);

    const watcherId = randomUUID();
    // 忽略隐藏文件和 node_modules（与 list 默认行为一致）
    // 注意：chokidar v5 ignored 接受 string | RegExp | 函数 | 数组
    const watcher = watch(path, {
      ignoreInitial: true,
      ignored: (testPath: string, stats?: Stats) => {
        // 目录直接放行（chokidar 会递归扫描，由子项 filter）
        if (stats?.isDirectory()) {
          return false;
        }
        // 跳过 node_modules 与点开头文件
        // L1 修复：chokidar 在 Windows 上传入的 testPath 可能混合使用 \\ 和 /
        // （内部路径标准化不彻底，尤其是 UNC 路径或符号链接场景），
        // 单独用 sep（'\\' on Windows）split 会漏掉以 / 分隔的路径，
        // 导致 node_modules / .git 等目录的子文件未被正确过滤。
        // 用正则 [\\/] 同时匹配两种分隔符，跨平台兼容。
        const normalized = testPath.split(/[\\/]/).pop() ?? '';
        return normalized === 'node_modules' || normalized.startsWith('.');
      },
      depth: 10,
    });

    // 监听 'all' 事件统一处理（避免为每个事件单独绑定）
    // 'all' 事件签名：(eventName: string, path: string, stats?: Stats)
    watcher.on('all', (eventName: string, changedPath: string) => {
      this.handleWatchEvent(watcherId, eventName, changedPath, webContents);
    });

    // 监听 error 事件，避免未捕获异常
    // chokidar v5 的 error 事件签名为 (err: unknown) => void，与 Node EventEmitter 一致
    watcher.on('error', (error: unknown) => {
      logger.error({ watcherId, error }, 'FileService watcher 异常');
    });

    // 监听 ready 事件，标记 watcher 已就绪
    watcher.on('ready', () => {
      logger.info({ watcherId, path }, 'FileService watcher 已就绪');
    });

    // P1 修复：watcher 生命周期绑定 webContents——窗口销毁（macOS 关窗不退出 /
    // 渲染层崩溃）时自动回收 watcher，此前只能靠渲染层恰好调用 watchStop，
    // 否则 chokidar 句柄泄漏并持续推送到已销毁的 webContents
    const onDestroyed = (): void => {
      logger.warn({ watcherId }, 'webContents 已销毁，自动回收 watcher');
      this.unwatch(watcherId);
    };
    const removeDestroyedListener = (): void => {
      webContents.removeListener('destroyed', onDestroyed);
    };
    webContents.once('destroyed', onDestroyed);

    this.watchers.set(watcherId, { watcher, webContents, removeDestroyedListener });
    logger.info({ watcherId, path }, 'FileService watcher 已注册');

    // 等待 chokidar 就绪再返回（真实竞态修复：ignoreInitial: true 下，
    // ready 之前创建的文件会被当作初始状态吞掉 add 事件——调用方在
    // watch() resolve 后立刻创建文件会丢事件，单测暴露）
    await new Promise<void>((resolve, reject) => {
      // optionsReady 为 Node 20.13+ 的 FSWatcher 属性（@types/node 版本差异——类型断言）
      const watcherWithReady = watcher as FSWatcher & { optionsReady?: boolean };
      if (watcherWithReady.optionsReady) {
        resolve();
        return;
      }
      watcher.once('ready', () => resolve());
      watcher.once('error', (error: unknown) => reject(error));
    });

    return { watcherId };
  }

  /**
   * 停止指定 watcher
   *
   * @returns 是否成功停止（watcherId 不存在时返回 false）
   */
  unwatch(watcherId: string): boolean {
    const ctx = this.watchers.get(watcherId);
    if (ctx === undefined) {
      return false;
    }
    // 移除 destroyed 监听（避免窗口存活时反复 watch/unwatch 累积监听器）
    ctx.removeDestroyedListener();
    // void 表示不等待 close 完成（close 是异步的，但调用即视为已停止）
    void ctx.watcher.close();
    this.watchers.delete(watcherId);
    logger.info({ watcherId }, 'FileService watcher 已停止');
    return true;
  }

  /**
   * 优雅关闭：停止所有 watcher
   *
   * 应用退出时调用，避免 watcher 句柄泄漏导致进程不退出。
   */
  async dispose(): Promise<void> {
    const ctxs = Array.from(this.watchers.values());
    if (ctxs.length === 0) {
      return;
    }

    // 并行关闭所有 watcher
    await Promise.all(
      ctxs.map(async (ctx) => {
        try {
          await ctx.watcher.close();
        } catch (error) {
          // close 失败不阻塞 dispose 流程，仅记录日志
          logger.warn({ error }, 'FileService watcher 关闭失败');
        }
      }),
    );
    this.watchers.clear();
    logger.info({}, 'FileService 所有 watcher 已关闭');
  }

  /**
   * 创建新文件
   *
   * 创建空文件，若文件已存在则抛 ALREADY_EXISTS 错误（不覆盖）。
   * createDirs=true 时自动创建父目录。
   */
  async createFile(options: FileCreateOptions): Promise<FileCreateRes> {
    const { path, createDirs } = options;
    this.assertAbsolutePath(path);

    try {
      if (createDirs) {
        await fs.mkdir(dirname(path), { recursive: true });
      }
      // 使用 'x' 标志：文件已存在时抛 EEXIST，避免覆盖已有文件
      // fs.open 写入空内容后立即关闭，实现「创建空文件」语义
      const handle = await fs.open(path, 'wx');
      await handle.close();
      return { path: resolve(path) };
    } catch (error) {
      throw this.classifyWriteError(error);
    }
  }

  /**
   * 创建新目录
   *
   * 递归创建父目录（与 mkdir -p 语义一致）。
   * 目录已存在时不报错（recursive=true 容错）。
   */
  async createDir(options: FileCreateDirOptions): Promise<FileCreateDirRes> {
    const { path } = options;
    this.assertAbsolutePath(path);

    try {
      await fs.mkdir(path, { recursive: true });
      return { path: resolve(path) };
    } catch (error) {
      throw this.classifyWriteError(error);
    }
  }

  /**
   * 删除文件或目录
   *
   * recursive=true（默认）：目录递归删除（rm -rf 语义）
   * recursive=false：仅删除空目录或文件，目录非空时抛 ENOTEMPTY
   */
  async delete(options: FileDeleteOptions): Promise<FileDeleteRes> {
    const { path, recursive } = options;
    this.assertAbsolutePath(path);

    try {
      // P0 修复：recursive 必填（schema 与 options 类型均已收紧），
      // 移除静默 rm -rf 默认——递归删除必须由调用方显式声明
      await fs.rm(path, { recursive, force: false });
      return { deleted: true };
    } catch (error) {
      throw this.classifyWriteError(error);
    }
  }

  /**
   * 重命名/移动文件或目录
   *
   * overwrite=true（默认 false）：目标已存在时覆盖
   * overwrite=false：目标已存在时抛 EEXIST，避免误覆盖
   */
  async rename(options: FileRenameOptions): Promise<FileRenameRes> {
    const { oldPath, newPath, overwrite } = options;
    this.assertAbsolutePath(oldPath);
    this.assertAbsolutePath(newPath);

    try {
      // 目标已存在时处理：overwrite=false 抛错，overwrite=true 先删除目标
      try {
        await fs.access(newPath);
        // newPath 存在
        if (!overwrite) {
          throw new AppError(ErrorCode.ALREADY_EXISTS, '目标路径已存在', { newPath });
        }
        await fs.rm(newPath, { recursive: true, force: true });
      } catch (accessError) {
        // access 抛 ENOENT 表示目标不存在，是期望情况，直接继续 rename
        const nodeErr = accessError as { code?: string };
        if (nodeErr.code !== 'ENOENT') {
          throw accessError;
        }
      }

      await fs.rename(oldPath, newPath);
      return { path: resolve(newPath) };
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      throw this.classifyWriteError(error);
    }
  }

  /**
   * 处理 chokidar 事件并推送 file:watch:event 事件到渲染层
   *
   * @param watcherId watcher 唯一 ID（用于渲染层过滤事件来源）
   * @param eventName chokidar 事件名（'add' / 'addDir' / 'change' / 'unlink' / 'unlinkDir'）
   * @param changedPath 变更的文件路径（绝对路径）
   * @param webContents 接收事件的 webContents
   */
  private handleWatchEvent(
    watcherId: string,
    eventName: string,
    changedPath: string,
    webContents: WebContents,
  ): void {
    // webContents 销毁后停止推送
    if (webContents.isDestroyed()) {
      logger.warn({ watcherId }, 'webContents 已销毁，停止推送 watch 事件');
      return;
    }

    // chokidar 事件名映射到 file:watch:event payload type
    let type: FileWatchEventPayload['type'];
    switch (eventName) {
      case 'add':
      case 'addDir':
        type = 'create';
        break;
      case 'change':
        type = 'modify';
        break;
      case 'unlink':
      case 'unlinkDir':
        type = 'delete';
        break;
      default:
        // 其他事件（'raw' 等）忽略
        return;
    }

    // payload 携带 watcherId，渲染层用此 id 过滤事件来源
    // R2：统一出口 emitEvent（dev 契约校验 + isDestroyed 防御）
    const payload: FileWatchEventPayload = { watcherId, type, path: changedPath };
    emitEvent(webContents, IPC_DEFINITIONS.file.subscribeWatchEvent, payload);
  }

  /**
   * 断言路径为绝对路径
   *
   * 相对路径在多窗口场景下有歧义（每个窗口的 cwd 可能不同），
   * 强制要求绝对路径避免误操作。
   */
  private assertAbsolutePath(path: string): void {
    if (!path || path.length === 0) {
      throw new AppError(ErrorCode.INVALID_INPUT, '路径不能为空');
    }
    // resolve 会把相对路径转为绝对路径（基于 cwd），因此判断是否已是绝对路径
    // 用 resolve(path) === path 判断（Windows 下会标准化盘符大小写）
    if (resolve(path) !== path) {
      throw new AppError(ErrorCode.INVALID_INPUT, '路径必须是绝对路径');
    }
  }

  /**
   * 分类读取错误：把 Node.js 原生 errno 映射到 AppError
   *
   * @param error 原始错误（通常是 Node.js 系统错误，含 code 字段如 'ENOENT'）
   */
  private classifyReadError(error: unknown): AppError {
    return this.classifyFsError(error, ErrorCode.FS_READ_FAILED);
  }

  /**
   * 分类写入错误：把 Node.js 原生 errno 映射到 AppError
   */
  private classifyWriteError(error: unknown): AppError {
    return this.classifyFsError(error, ErrorCode.FS_WRITE_FAILED);
  }

  /**
   * 统一的 FS 错误分类：处理 Node.js errno
   *
   * @param error 原始错误
   * @param fallbackCode 兜底错误码（FS_READ_FAILED 或 FS_WRITE_FAILED）
   */
  private classifyFsError(error: unknown, fallbackCode: ErrorCode): AppError {
    // AppError 直接透传（避免嵌套包装）
    if (error instanceof AppError) {
      return error;
    }

    // Node.js 系统错误的 code 字段（如 'ENOENT', 'EACCES'）
    const nodeError = error as { code?: string; message?: string };
    switch (nodeError.code) {
      case 'ENOENT':
        // 文件或目录不存在
        return new AppError(ErrorCode.NOT_FOUND, '文件或目录不存在', error);
      case 'EEXIST':
        // 文件或目录已存在（createFile 的 wx 标志 / rename 目标冲突）
        return new AppError(ErrorCode.ALREADY_EXISTS, '文件或目录已存在', error);
      case 'EACCES':
      case 'EPERM':
        // 权限不足（读/写/执行权限被拒绝）
        return new AppError(ErrorCode.UNAUTHORIZED, '权限不足', error);
      case 'ENOSPC':
        // 磁盘空间不足
        return new AppError(ErrorCode.FS_DISK_FULL, '磁盘空间不足', error);
      case 'ENOTDIR':
        // 路径不是目录（对文件执行了目录操作）
        return new AppError(ErrorCode.INVALID_INPUT, '路径不是目录', error);
      case 'EISDIR':
        // 是目录（对目录执行了文件操作）
        return new AppError(ErrorCode.INVALID_INPUT, '路径是目录，不能作为文件操作', error);
      default:
        // 其他错误用 fallbackCode 包装
        return new AppError(fallbackCode, nodeError.message ?? '文件操作失败', error);
    }
  }
}

/** FileService 单例（内部按具体实现类持有，外部暴露为 IFileService 接口） */
let fileService: FileService | null = null;

/**
 * 获取 FileService 单例
 *
 * 整个应用生命周期共享一个实例，内部 Map 管理 watcher。
 *
 * 返回类型为 IFileService 接口而非具体类：
 * - 强制调用方面向接口编程，不依赖 FileService 内部细节
 * - ServiceContainer 注入到 IPC handler 时类型一致
 */
export function getFileService(): IFileService {
  if (fileService === null) {
    fileService = new FileService();
  }
  return fileService;
}

/**
 * 重置 FileService（仅测试用）
 *
 * 调用 dispose 停止所有 watcher，并清空单例缓存。
 */
export async function resetFileService(): Promise<void> {
  if (fileService !== null) {
    await fileService.dispose();
    fileService = null;
  }
}
