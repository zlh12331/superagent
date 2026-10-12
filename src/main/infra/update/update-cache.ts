// update-cache.ts：electron-updater 缓存目录定位/度量/清理 + 差分基线一致性修剪
// 目录名真源 = 打包的 app-update.yml（updaterCacheDirName），不硬编码——yml 改了这里自动跟
import { readdir, readFile, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

import type { UpdateCacheInfo } from '@code-agent/shared/main';

const CACHE_DIR_NAME_RE = /^updaterCacheDirName:\s*(.+?)\s*$/m;

// 目录名白名单（拼进系统缓存路径用，防 yml 注入路径穿越）
const CACHE_DIR_NAME_SAFE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function getAppCacheRoot(): string {
  if (process.platform === 'win32') {
    return process.env['LOCALAPPDATA'] ?? join(homedir(), 'AppData', 'Local');
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Caches');
  }
  return process.env['XDG_CACHE_HOME'] ?? join(homedir(), '.cache');
}

/** 从 app-update.yml 解析 updater 缓存目录（yml 缺失/目录名非法 → null） */
export async function resolveUpdaterCacheDir(
  resourcesPath: string,
  cacheRoot: string = getAppCacheRoot(),
  ymlFileName: string = 'app-update.yml',
): Promise<string | null> {
  let yml: string;
  try {
    yml = await readFile(join(resourcesPath, ymlFileName), 'utf8');
  } catch {
    return null;
  }
  const dirName = yml.match(CACHE_DIR_NAME_RE)?.[1]?.replace(/^['"]|['"]$/g, '');
  if (dirName === undefined || dirName === '' || !CACHE_DIR_NAME_SAFE_RE.test(dirName)) {
    return null;
  }
  return join(cacheRoot, dirName);
}

export async function measureDirRecursive(dir: string): Promise<{
  readonly bytes: number;
  readonly fileCount: number;
}> {
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
    } catch {}
  }
  return { bytes, fileCount };
}

/** 缓存度量（递归累计字节与文件数；设置面「清理更新缓存」展示用） */
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

/** 清空更新缓存目录（递归强删；设置面入口） */
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

/**
 * 差分基线一致性修剪：blockmap 记录的安装包总大小与缓存内 installer.exe 实际大小不符时
 * 删掉旧 blockmap（1.6.x 事故教训——陈旧基线会让差分更新静默失败）
 *
 * @returns pruned=清了陈旧基线 / consistent=一致 / absent=文件缺失无从校验
 */
export type BaselinePruneResult = 'pruned' | 'consistent' | 'absent';

export async function pruneStaleDifferentialBaseline(
  cacheDir: string,
): Promise<BaselinePruneResult> {
  const blockMapPath = join(cacheDir, 'current.blockmap');
  const installerPath = join(cacheDir, 'installer.exe');
  const [installerInfo, blockMapTotal] = await Promise.all([
    stat(installerPath).catch(() => null),
    readBlockMapTotalSize(blockMapPath),
  ]);
  if (installerInfo === null) {
    return 'absent';
  }
  if (blockMapTotal === null) {
    return 'absent';
  }
  if (blockMapTotal === installerInfo.size) {
    return 'consistent';
  }
  await rm(blockMapPath, { force: true });
  return 'pruned';
}

async function readBlockMapTotalSize(blockMapPath: string): Promise<number | null> {
  try {
    const raw = await readFile(blockMapPath);
    const parsed: unknown = JSON.parse(gunzipSync(raw).toString('utf8'));
    const files = (parsed as { files?: unknown }).files;
    if (!Array.isArray(files) || files.length === 0) {
      return null;
    }
    const sizes = (files[0] as { sizes?: unknown }).sizes;
    if (!Array.isArray(sizes) || sizes.length === 0) {
      return null;
    }
    let total = 0;
    for (const size of sizes) {
      if (typeof size !== 'number') {
        return null;
      }
      total += size;
    }
    return total;
  } catch {
    return null;
  }
}
