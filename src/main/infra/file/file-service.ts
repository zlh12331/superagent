// file-service.ts：文件服务——读/写/列举/chokidar 监听/建删改名，渲染层文件树与编辑器后端
// 边界：工作区路径校验不在这里（ipc 层守卫后传入）；编码自动探测 + 超限截断在本层做
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
import { DEFAULT_TREE_IGNORE_PATTERNS, matchIgnorePattern } from './tree-ignore';

const UTF8_LIKE_ENCODINGS = new Set(['UTF-8', 'ASCII']);

// 单次读取上限 2MB（防超大文件打爆 IPC 通道）；编码探测只采样头部 64KB 足够判 BOM/字符分布
const MAX_READ_BYTES = 2 * 1024 * 1024;
const CHARDET_SAMPLE_BYTES = 64 * 1024;

// 监听噪音过滤：node_modules 与点开头条目不推事件（文件树也不展示，推了也没人消费）
function shouldIgnoreWatchPath(testPath: string, stats?: Stats): boolean {
  if (stats?.isDirectory()) {
    return false;
  }
  const normalized = testPath.split(/[\\/]/).pop() ?? '';
  return normalized === 'node_modules' || normalized.startsWith('.');
}

function findExistingWatcher(
  watchers: ReadonlyMap<string, { readonly path: string; readonly webContents: WebContents }>,
  path: string,
  webContents: WebContents,
): string | null {
  for (const [id, entry] of watchers) {
    if (entry.path === path && entry.webContents === webContents) {
      return id;
    }
  }
  return null;
}

function normalizeEncoding(detected: string | null): string {
  if (detected === null || UTF8_LIKE_ENCODINGS.has(detected)) {
    return 'utf-8';
  }
  return detected.toLowerCase();
}

export interface FileReadOptions {
  readonly path: string;
  readonly offset: number | undefined;
  readonly limit: number | undefined;
}

export interface FileWriteOptions {
  readonly path: string;
  readonly content: string;
  readonly append: boolean;
  readonly createDirs: boolean;
}

export interface FileListOptions {
  readonly path: string;
  readonly depth: number;
  readonly includeHidden: boolean;
  readonly ignorePatterns?: readonly string[];
}

export interface FileWatchOptions {
  readonly path: string;
  readonly webContents: WebContents;
}

export interface FileWatchHandle {
  readonly watcherId: string;
}

export interface FileCreateOptions {
  readonly path: string;
  readonly createDirs: boolean;
}

export interface FileCreateDirOptions {
  readonly path: string;
}

export interface FileDeleteOptions {
  readonly path: string;
  readonly recursive: boolean;
}

export interface FileRenameOptions {
  readonly oldPath: string;
  readonly newPath: string;
  readonly overwrite: boolean;
}

/** 文件服务接口（IPC handler 消费；watch 返回句柄 id，unwatch 凭 id 解绑） */
export interface IFileService {
  read(options: FileReadOptions): Promise<FileReadRes>;
  write(options: FileWriteOptions): Promise<FileWriteRes>;
  list(options: FileListOptions): Promise<FileListRes>;
  watch(options: FileWatchOptions): Promise<FileWatchHandle>;
  unwatch(watcherId: string): boolean;
  dispose(): Promise<void>;
  createFile(options: FileCreateOptions): Promise<FileCreateRes>;
  createDir(options: FileCreateDirOptions): Promise<FileCreateDirRes>;
  delete(options: FileDeleteOptions): Promise<FileDeleteRes>;
  rename(options: FileRenameOptions): Promise<FileRenameRes>;
}

class FileService implements IFileService {
  private readonly watchers = new Map<
    string,
    {
      readonly watcher: FSWatcher;
      readonly webContents: WebContents;
      readonly path: string;
      readonly removeDestroyedListener: () => void;
    }
  >();

  async read(options: FileReadOptions): Promise<FileReadRes> {
    const { path, offset, limit } = options;
    this.assertAbsolutePath(path);

    try {
      const stat = await fs.stat(path);
      if (stat.size > MAX_READ_BYTES) {
        throw new AppError(
          ErrorCode.FS_READ_FAILED,
          `文件过大（${(stat.size / (1024 * 1024)).toFixed(1)}MB），超过读取上限 ${MAX_READ_BYTES / (1024 * 1024)}MB`,
        );
      }
      const buffer = await fs.readFile(path);
      const detectBuffer =
        buffer.length > CHARDET_SAMPLE_BYTES ? buffer.subarray(0, CHARDET_SAMPLE_BYTES) : buffer;
      const detected = chardet.detect(detectBuffer);
      const encoding = normalizeEncoding(detected);

      let content: string;
      if (encoding === 'utf-8') {
        content = buffer.toString('utf-8');
      } else {
        try {
          content = iconv.decode(buffer, encoding);
        } catch (decodeError) {
          logger.warn({ path, encoding, error: decodeError }, '编码转码失败，回退 UTF-8');
          content = buffer.toString('utf-8');
        }
      }

      const lines = content.split(/\r?\n/);
      const totalLines = lines.length;

      const start = offset ?? 0;
      if (start >= totalLines) {
        return { content: '', totalLines, encoding };
      }
      const end = limit === undefined ? totalLines : Math.min(start + limit, totalLines);
      const sliced = lines.slice(start, end);
      return { content: sliced.join('\n'), totalLines, encoding };
    } catch (error) {
      throw this.classifyReadError(error);
    }
  }

  async write(options: FileWriteOptions): Promise<FileWriteRes> {
    const { path, content, append, createDirs } = options;
    this.assertAbsolutePath(path);

    try {
      if (createDirs) {
        await fs.mkdir(dirname(path), { recursive: true });
      }

      const buffer = Buffer.from(content, 'utf-8');
      if (append) {
        await fs.writeFile(path, buffer, { flag: 'a' });
      } else {
        await fs.writeFile(path, buffer);
      }

      return { bytesWritten: buffer.byteLength };
    } catch (error) {
      throw this.classifyWriteError(error);
    }
  }

  async list(options: FileListOptions): Promise<FileListRes> {
    const { path, depth, includeHidden } = options;
    this.assertAbsolutePath(path);
    const ignorePatterns = [...DEFAULT_TREE_IGNORE_PATTERNS, ...(options.ignorePatterns ?? [])];

    try {
      const entries: FileEntry[] = [];
      await this.listRecursive(path, depth, includeHidden, entries, ignorePatterns);
      return { entries };
    } catch (error) {
      throw this.classifyReadError(error);
    }
  }

  private async listRecursive(
    currentPath: string,
    remainingDepth: number,
    includeHidden: boolean,
    output: FileEntry[],
    ignorePatterns: readonly string[],
  ): Promise<void> {
    if (remainingDepth <= 0) {
      return;
    }

    const items = await fs.readdir(currentPath, { withFileTypes: true });
    for (const item of items) {
      if (!includeHidden && item.name.startsWith('.')) {
        continue;
      }
      if (matchIgnorePattern(item.name, ignorePatterns)) {
        continue;
      }

      const itemPath = join(currentPath, item.name);
      const stats = await fs.stat(itemPath);

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
        modifiedAt: Math.floor(stats.mtimeMs),
      });

      if (item.isDirectory()) {
        await this.listRecursive(
          itemPath,
          remainingDepth - 1,
          includeHidden,
          output,
          ignorePatterns,
        );
      }
    }
  }

  async watch(options: FileWatchOptions): Promise<FileWatchHandle> {
    const { path, webContents } = options;
    this.assertAbsolutePath(path);

    const existingId = findExistingWatcher(this.watchers, path, webContents);
    if (existingId !== null) return { watcherId: existingId };
    const watcherId = randomUUID();
    const watcher = watch(path, {
      ignoreInitial: true,
      ignored: shouldIgnoreWatchPath,
      depth: 10,
      ...(process.env['FILE_WATCH_USE_POLLING'] === '1' ? { usePolling: true } : {}),
    });

    watcher.on('all', (eventName: string, changedPath: string) => {
      this.handleWatchEvent(watcherId, eventName, changedPath, webContents);
    });

    watcher.on('error', (error: unknown) => {
      logger.error({ watcherId, error }, 'FileService watcher 异常');
    });

    watcher.on('ready', () => {
      logger.info({ watcherId, path }, 'FileService watcher 已就绪');
    });

    const onDestroyed = (): void => {
      logger.warn({ watcherId }, 'webContents 已销毁，自动回收 watcher');
      this.unwatch(watcherId);
    };
    const removeDestroyedListener = (): void => {
      webContents.removeListener('destroyed', onDestroyed);
    };
    webContents.once('destroyed', onDestroyed);

    this.watchers.set(watcherId, { watcher, webContents, path, removeDestroyedListener });
    logger.info({ watcherId, path }, 'FileService watcher 已注册');

    await new Promise<void>((resolve, reject) => {
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

  unwatch(watcherId: string): boolean {
    const ctx = this.watchers.get(watcherId);
    if (ctx === undefined) {
      return false;
    }
    ctx.removeDestroyedListener();
    void ctx.watcher.close();
    this.watchers.delete(watcherId);
    logger.info({ watcherId }, 'FileService watcher 已停止');
    return true;
  }

  async dispose(): Promise<void> {
    const ctxs = Array.from(this.watchers.values());
    if (ctxs.length === 0) {
      return;
    }

    await Promise.all(
      ctxs.map(async (ctx) => {
        try {
          await ctx.watcher.close();
        } catch (error) {
          logger.warn({ error }, 'FileService watcher 关闭失败');
        }
      }),
    );
    this.watchers.clear();
    logger.info({}, 'FileService 所有 watcher 已关闭');
  }

  async createFile(options: FileCreateOptions): Promise<FileCreateRes> {
    const { path, createDirs } = options;
    this.assertAbsolutePath(path);

    try {
      if (createDirs) {
        await fs.mkdir(dirname(path), { recursive: true });
      }
      const handle = await fs.open(path, 'wx');
      await handle.close();
      return { path: resolve(path) };
    } catch (error) {
      throw this.classifyWriteError(error);
    }
  }

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

  async delete(options: FileDeleteOptions): Promise<FileDeleteRes> {
    const { path, recursive } = options;
    this.assertAbsolutePath(path);

    try {
      await fs.rm(path, { recursive, force: false });
      return { deleted: true };
    } catch (error) {
      throw this.classifyWriteError(error);
    }
  }

  async rename(options: FileRenameOptions): Promise<FileRenameRes> {
    const { oldPath, newPath, overwrite } = options;
    this.assertAbsolutePath(oldPath);
    this.assertAbsolutePath(newPath);

    try {
      try {
        await fs.access(newPath);
        if (!overwrite) {
          throw new AppError(ErrorCode.ALREADY_EXISTS, '目标路径已存在', { newPath });
        }
        await fs.rm(newPath, { recursive: true, force: true });
      } catch (accessError) {
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

  private handleWatchEvent(
    watcherId: string,
    eventName: string,
    changedPath: string,
    webContents: WebContents,
  ): void {
    if (webContents.isDestroyed()) {
      logger.warn({ watcherId }, 'webContents 已销毁，停止推送 watch 事件');
      return;
    }

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
        return;
    }

    const payload: FileWatchEventPayload = { watcherId, type, path: changedPath };
    emitEvent(webContents, IPC_DEFINITIONS.file.subscribeWatchEvent, payload);
  }

  private assertAbsolutePath(path: string): void {
    if (!path || path.length === 0) {
      throw new AppError(ErrorCode.INVALID_INPUT, '路径不能为空');
    }
    if (resolve(path) !== path) {
      throw new AppError(ErrorCode.INVALID_INPUT, '路径必须是绝对路径');
    }
  }

  private classifyReadError(error: unknown): AppError {
    return this.classifyFsError(error, ErrorCode.FS_READ_FAILED);
  }

  private classifyWriteError(error: unknown): AppError {
    return this.classifyFsError(error, ErrorCode.FS_WRITE_FAILED);
  }

  private classifyFsError(error: unknown, fallbackCode: ErrorCode): AppError {
    if (error instanceof AppError) {
      return error;
    }

    const nodeError = error as { code?: string; message?: string };
    switch (nodeError.code) {
      case 'ENOENT':
        return new AppError(ErrorCode.NOT_FOUND, '文件或目录不存在', error);
      case 'EEXIST':
        return new AppError(ErrorCode.ALREADY_EXISTS, '文件或目录已存在', error);
      case 'EACCES':
      case 'EPERM':
        return new AppError(ErrorCode.UNAUTHORIZED, '权限不足', error);
      case 'ENOSPC':
        return new AppError(ErrorCode.FS_DISK_FULL, '磁盘空间不足', error);
      case 'ENOTDIR':
        return new AppError(ErrorCode.INVALID_INPUT, '路径不是目录', error);
      case 'EISDIR':
        return new AppError(ErrorCode.INVALID_INPUT, '路径是目录，不能作为文件操作', error);
      default:
        return new AppError(fallbackCode, nodeError.message ?? '文件操作失败', error);
    }
  }
}

let fileService: FileService | null = null;

export function getFileService(): IFileService {
  if (fileService === null) {
    fileService = new FileService();
  }
  return fileService;
}

export async function resetFileService(): Promise<void> {
  if (fileService !== null) {
    await fileService.dispose();
    fileService = null;
  }
}
