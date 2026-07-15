/**
 * Codex API — File system 域
 *
 * 文件操作：列出目录、读取文件、写入文件、文件树、模糊搜索、fs watch。
 *
 * 后端命令已实现（9 个 Tauri command）：
 * - fs_read_file — 读取文件内容（base64 编码返回）
 * - fs_write_file — 写入文件内容（base64 编码传入）
 * - fs_create_directory — 创建目录
 * - fs_get_metadata — 获取文件/目录元数据
 * - fs_read_directory — 列出目录内容
 * - fs_remove — 删除文件或目录
 * - fs_copy — 复制文件或目录
 * - fs_watch — 开始监听文件系统变更
 * - fs_unwatch — 停止监听文件系统变更
 *
 * 所有命令返回 JSON 字符串（避免 specta 递归类型栈溢出），
 * 前端调用后 `JSON.parse()` 得到结构化数据。
 * 通过 isTauri() 检测以支持纯浏览器开发模式。
 *
 * @see src/lib/tauri-bindings.ts — tauri-specta 自动生成的类型安全调用
 * @see src/lib/bindings.ts — tauri-specta 自动生成的类型定义
 * @see src/lib/codex/types.ts — FileEntry 类型
 * @see src/features/file-tree/types.ts — FileTreeNode / FuzzySearchResult 类型
 */

import { commands } from '@/lib/tauri-bindings'
import type {
  FsReadFileArgs,
  FsWriteFileArgs,
  FsCreateDirectoryArgs,
  FsGetMetadataArgs,
  FsReadDirectoryArgs,
  FsRemoveArgs,
  FsCopyArgs,
  FsWatchArgs,
  FsUnwatchArgs,
} from '@/lib/bindings'
import type { UnlistenFn } from '@tauri-apps/api/event'
import type { FileEntry } from './types'
import type {
  FileTreeNode,
  FuzzySearchResult,
} from '@/features/file-tree/types'
import { isTauri } from '@/lib/env'
// 集中式 mock 模块 — 浏览器开发模式的文件系统数据与统一事件监听
import { getMockData, universalListen } from './mock'

// ---------------------------------------------------------------------------
// Tauri 响应类型（对应 codex-rs app-server-protocol 中的结构体）
// ---------------------------------------------------------------------------

/** fs/readFile 响应（base64 编码的文件内容） */
interface FsReadFileResponse {
  dataBase64: string
}

/** fs/readDirectory 响应中的单条目 */
interface FsReadDirectoryEntry {
  fileName: string
  isDirectory: boolean
  isFile: boolean
}

/** fs/readDirectory 响应 */
interface FsReadDirectoryResponse {
  entries: FsReadDirectoryEntry[]
}

/** fs/getMetadata 响应 */
interface FsGetMetadataResponse {
  isDirectory: boolean
  isFile: boolean
  isSymlink: boolean
  createdAtMs: number
  modifiedAtMs: number
}

/** fs/watch 响应（返回规范化的监听路径） */
interface FsWatchResponse {
  path: string
}

// ---------------------------------------------------------------------------
// Base64 工具函数（用于 fs/readFile 和 fs/writeFile 的内容编解码）
// ---------------------------------------------------------------------------

/** 将 UTF-8 文本编码为 base64 字符串 */
function encodeBase64(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary)
}

/** 将 base64 字符串解码为 UTF-8 文本 */
function decodeBase64(b64: string): string {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return new TextDecoder().decode(bytes)
}

/**
 * 列出目录内容。
 *
 * Tauri 模式调用 `fs/readDirectory` 命令，
 * 浏览器模式返回 mock 数据。
 *
 * @param dirPath — 目录绝对路径
 */
export async function listDirectory(dirPath: string): Promise<FileEntry[]> {
  if (isTauri()) {
    const args: FsReadDirectoryArgs = { path: dirPath }
    const result = await commands.fsReadDirectory(args)
    if (result.status === 'error') {
      throw new Error(`fs/readDirectory failed: ${result.error.message}`)
    }
    const parsed: FsReadDirectoryResponse = JSON.parse(result.data)
    // 后端条目只包含 fileName/isDirectory/isFile，需前端拼接完整路径
    return parsed.entries.map(entry => ({
      path: `${dirPath}/${entry.fileName}`,
      name: entry.fileName,
      isDirectory: entry.isDirectory,
      size: 0,
      modifiedAt: Date.now(),
    }))
  }
  return getMockData().fileEntries
}

/**
 * 读取文件内容。
 *
 * Tauri 模式调用 `fs/readFile` 命令，后端返回 base64 编码的内容，
 * 前端解码为 UTF-8 文本。浏览器模式返回 mock 字符串。
 *
 * @param filePath — 文件绝对路径
 */
export async function readFile(filePath: string): Promise<string> {
  if (isTauri()) {
    const args: FsReadFileArgs = { path: filePath }
    const result = await commands.fsReadFile(args)
    if (result.status === 'error') {
      throw new Error(`fs/readFile failed: ${result.error.message}`)
    }
    const parsed: FsReadFileResponse = JSON.parse(result.data)
    return decodeBase64(parsed.dataBase64)
  }
  return '// mock file content'
}

/**
 * 写入文件内容。
 *
 * Tauri 模式调用 `fs/writeFile` 命令，前端将文本编码为 base64 后传入。
 * 浏览器模式为 no-op。
 *
 * @param filePath — 文件绝对路径
 * @param content — 文件内容（UTF-8 文本）
 */
export async function writeFile(
  filePath: string,
  content: string
): Promise<void> {
  if (isTauri()) {
    const args: FsWriteFileArgs = {
      path: filePath,
      dataBase64: encodeBase64(content),
    }
    const result = await commands.fsWriteFile(args)
    if (result.status === 'error') {
      throw new Error(`fs/writeFile failed: ${result.error.message}`)
    }
    return
  }
}

/** 获取文件树根节点（含递归子节点） */
export async function getFileTree(_rootPath?: string): Promise<FileTreeNode> {
  if (isTauri()) {
    // TODO[task17]: const result = await commands.getFileTree({ rootPath })
    // return result.data
    return getMockData().fileTree
  }
  return getMockData().fileTree
}

/**
 * 创建目录。
 *
 * Tauri 模式调用 `fs/createDirectory` 命令，可选是否递归创建父目录。
 * 浏览器模式为 no-op。
 *
 * @param dirPath — 目录绝对路径
 * @param recursive — 是否递归创建父目录（默认 false）
 */
export async function createDirectory(
  dirPath: string,
  recursive = false
): Promise<void> {
  if (isTauri()) {
    const args: FsCreateDirectoryArgs = { path: dirPath, recursive }
    const result = await commands.fsCreateDirectory(args)
    if (result.status === 'error') {
      throw new Error(`fs/createDirectory failed: ${result.error.message}`)
    }
    return
  }
}

/**
 * 复制文件或目录。
 *
 * Tauri 模式调用 `fs/copy` 命令，复制目录时需设置 `recursive`。
 * 浏览器模式为 no-op。
 *
 * @param sourcePath — 源路径
 * @param destinationPath — 目标路径
 * @param recursive — 复制目录时是否递归（默认 false）
 */
export async function copyPath(
  sourcePath: string,
  destinationPath: string,
  recursive = false
): Promise<void> {
  if (isTauri()) {
    const args: FsCopyArgs = { sourcePath, destinationPath, recursive }
    const result = await commands.fsCopy(args)
    if (result.status === 'error') {
      throw new Error(`fs/copy failed: ${result.error.message}`)
    }
    return
  }
}

/**
 * 删除文件或目录。
 *
 * Tauri 模式调用 `fs/remove` 命令，可选是否递归删除。
 * 浏览器模式为 no-op。
 *
 * @param path — 要删除的路径
 * @param recursive — 是否递归删除目录（默认 false）
 */
export async function removePath(
  path: string,
  recursive = false
): Promise<void> {
  if (isTauri()) {
    const args: FsRemoveArgs = { path, recursive }
    const result = await commands.fsRemove(args)
    if (result.status === 'error') {
      throw new Error(`fs/remove failed: ${result.error.message}`)
    }
    return
  }
}

/** 重命名文件或目录 */
export async function renamePath(
  _oldPath: string,
  _newPath: string
): Promise<void> {
  if (isTauri()) {
    // TODO[task17]: await commands.renamePath({ oldPath, newPath })
    return
  }
}

/** 模糊搜索文件（按 title 过滤，返回匹配结果） */
export async function fuzzyFileSearch(
  query: string
): Promise<FuzzySearchResult[]> {
  if (isTauri()) {
    // TODO[task17]: const result = await commands.fuzzyFileSearchStart({ query })
    // return result.data
    return getMockData().allFiles.filter(f =>
      f.title.toLowerCase().includes(query.toLowerCase())
    )
  }
  return getMockData().allFiles.filter(f =>
    f.title.toLowerCase().includes(query.toLowerCase())
  )
}

/** 文件系统变化事件 payload */
export interface FsWatchEvent {
  path: string
  kind: 'create' | 'modify' | 'remove'
}

/**
 * 监听文件系统变化（Tauri `fs/watch` 事件）
 *
 * 在 Tauri 环境下注册监听器；浏览器开发模式下返回空 unlisten。
 * 调用方应在组件卸载时调用返回的 unlisten 以避免泄漏。
 */
export async function onFsWatch(
  callback: (event: FsWatchEvent) => void
): Promise<UnlistenFn> {
  // 统一事件监听：Tauri 用原生 listen，浏览器用 mockEventBus
  return universalListen<FsWatchEvent>('fs/watch', callback)
}

// ---------------------------------------------------------------------------
// 以下函数对应没有 TODO 桩的后端命令（fs/getMetadata、fs/watch、fs/unwatch）
// ---------------------------------------------------------------------------

/**
 * 获取文件或目录的元数据。
 *
 * Tauri 模式调用 `fs/getMetadata` 命令，返回是否为目录/文件/符号链接
 * 以及创建和修改时间。浏览器模式返回 mock 元数据。
 *
 * @param path — 要查询的路径
 */
export async function getMetadata(path: string): Promise<FileEntry> {
  if (isTauri()) {
    const args: FsGetMetadataArgs = { path }
    const result = await commands.fsGetMetadata(args)
    if (result.status === 'error') {
      throw new Error(`fs/getMetadata failed: ${result.error.message}`)
    }
    const parsed: FsGetMetadataResponse = JSON.parse(result.data)
    const name = path.split('/').pop() ?? path
    return {
      path,
      name,
      isDirectory: parsed.isDirectory,
      size: 0,
      modifiedAt: parsed.modifiedAtMs,
    }
  }

  // 浏览器开发模式 — 返回 mock 元数据
  return {
    path,
    name: path.split('/').pop() ?? path,
    isDirectory: false,
    size: 0,
    modifiedAt: Date.now(),
  }
}

/**
 * 开始监听文件系统变更。
 *
 * Tauri 模式调用 `fs/watch` 命令，注册一个文件或目录的监听器。
 * 后续变更通过 `codex:notification` 事件推送 `FsChangedNotification`。
 * 浏览器模式为 no-op，返回传入的路径。
 *
 * @param watchId — 监听标识符（用于后续的 `unwatchPath`）
 * @param path — 要监听的文件或目录绝对路径
 * @returns 后端规范化的监听路径
 */
export async function watchPath(
  watchId: string,
  path: string
): Promise<string> {
  if (isTauri()) {
    const args: FsWatchArgs = { watchId, path }
    const result = await commands.fsWatch(args)
    if (result.status === 'error') {
      throw new Error(`fs/watch failed: ${result.error.message}`)
    }
    const parsed: FsWatchResponse = JSON.parse(result.data)
    return parsed.path
  }

  // 浏览器开发模式 — 返回传入的路径
  return path
}

/**
 * 停止监听文件系统变更。
 *
 * Tauri 模式调用 `fs/unwatch` 命令，取消之前通过 `watchPath` 注册的监听器。
 * 浏览器模式为 no-op。
 *
 * @param watchId — 之前通过 `watchPath` 注册的监听标识符
 */
export async function unwatchPath(watchId: string): Promise<void> {
  if (isTauri()) {
    const args: FsUnwatchArgs = { watchId }
    const result = await commands.fsUnwatch(args)
    if (result.status === 'error') {
      throw new Error(`fs/unwatch failed: ${result.error.message}`)
    }
    return
  }

  // 浏览器开发模式 — no-op
}
