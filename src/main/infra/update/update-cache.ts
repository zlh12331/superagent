// src/main/infra/update/update-cache.ts
// 更新缓存的占用统计与清理
// ──────────────────────────────────────────────────────────────
// 路径解析必须与 electron-updater 一致，否则统计/清理的是别的目录：
// - 缓存根 = electron-updater 的 getAppCacheDir()：Windows LOCALAPPDATA /
//   macOS ~/Library/Caches / Linux XDG_CACHE_HOME 或 ~/.cache
// - 目录名 = app-update.yml 的 updaterCacheDirName（electron-builder 生成，
//   默认 <sanitizedName.toLowerCase()>-updater）
// 解析不到（开发模式无 app-update.yml / 读取失败 / 键缺失）→ path 为 null，
// 界面不展示该行——不猜路径、不误删。
//
// 注意（界面文案必须说明）：Windows 的 installer.exe 与 macOS 的 update.zip 是
// 差分更新的基线文件，清理后下次升级会退化为全量下载。
// ──────────────────────────────────────────────────────────────

import { readdir, readFile, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { UpdateCacheInfo } from '@code-agent/shared/main';

/** app-update.yml 中的缓存目录名（行首键，值为单个 token 或带引号） */
const CACHE_DIR_NAME_RE = /^updaterCacheDirName:\s*(.+?)\s*$/m;

/** electron-updater 的缓存根（对齐 AppAdapter.getAppCacheDir） */
function getAppCacheRoot(): string {
  if (process.platform === 'win32') {
    return process.env['LOCALAPPDATA'] ?? join(homedir(), 'AppData', 'Local');
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Caches');
  }
  return process.env['XDG_CACHE_HOME'] ?? join(homedir(), '.cache');
}

/**
 * 解析更新缓存目录
 *
 * @param resourcesPath 打包资源目录（process.resourcesPath；其中含 app-update.yml）
 * @param cacheRoot 缓存根（默认按平台推导；测试注入临时目录，避免触碰真实缓存）
 * @returns 缓存目录绝对路径；无法解析时为 null
 */
export async function resolveUpdaterCacheDir(
  resourcesPath: string,
  cacheRoot: string = getAppCacheRoot(),
): Promise<string | null> {
  let yml: string;
  try {
    yml = await readFile(join(resourcesPath, 'app-update.yml'), 'utf8');
  } catch {
    // 无 app-update.yml（开发模式）或读取失败：不展示、不清理
    return null;
  }
  const dirName = yml.match(CACHE_DIR_NAME_RE)?.[1]?.replace(/^['"]|['"]$/g, '');
  if (dirName === undefined || dirName === '') {
    return null;
  }
  return join(cacheRoot, dirName);
}

/**
 * 统计目录占用（递归）
 *
 * 目录不存在或读取失败 → 计 0（不抛错：调用方展示"当前占用"，失败即视为无缓存）。
 * 单文件 stat 失败跳过，不让统计整体失败。
 */
export async function measureDirRecursive(dir: string): Promise<{
  readonly bytes: number;
  readonly fileCount: number;
}> {
  // 读取失败（不存在/无权限）视为无缓存：不抛错，调用方只展示占用
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => null);
  if (entries === null) {
    return { bytes: 0, fileCount: 0 };
  }
  let bytes = 0;
  let fileCount = 0;
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = await measureDirRecursive(full);
      bytes += nested.bytes;
      fileCount += nested.fileCount;
      continue;
    }
    try {
      const info = await stat(full);
      bytes += info.size;
      fileCount += 1;
    } catch {
      // 单文件不可读（权限/竞态删除）：跳过
    }
  }
  return { bytes, fileCount };
}

/** 读取更新缓存信息（path 为 null 表示无法解析，界面隐藏该行） */
export async function readUpdateCacheInfo(
  resourcesPath: string,
  cacheRoot?: string,
): Promise<UpdateCacheInfo> {
  const dir =
    cacheRoot === undefined
      ? await resolveUpdaterCacheDir(resourcesPath)
      : await resolveUpdaterCacheDir(resourcesPath, cacheRoot);
  if (dir === null) {
    return { path: null, bytes: 0, fileCount: 0 };
  }
  const measured = await measureDirRecursive(dir);
  return { path: dir, bytes: measured.bytes, fileCount: measured.fileCount };
}

/**
 * 清理更新缓存（删除缓存目录本身，electron-updater 会按需重建）
 *
 * 差分基线随之消失：下次升级退化为全量下载（界面需先确认并说明）。
 */
export async function clearUpdateCache(
  resourcesPath: string,
  cacheRoot?: string,
): Promise<UpdateCacheInfo> {
  const dir =
    cacheRoot === undefined
      ? await resolveUpdaterCacheDir(resourcesPath)
      : await resolveUpdaterCacheDir(resourcesPath, cacheRoot);
  if (dir === null) {
    return { path: null, bytes: 0, fileCount: 0 };
  }
  await rm(dir, { recursive: true, force: true });
  return { path: dir, bytes: 0, fileCount: 0 };
}
