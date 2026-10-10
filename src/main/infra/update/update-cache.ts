import { readdir, readFile, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

import type { UpdateCacheInfo } from '@code-agent/shared/main';

const CACHE_DIR_NAME_RE = /^updaterCacheDirName:\s*(.+?)\s*$/m;

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
