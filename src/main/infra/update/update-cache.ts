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
import { gunzipSync } from 'node:zlib';

import type { UpdateCacheInfo } from '@code-agent/shared/main';

/** app-update.yml 中的缓存目录名（行首键，值为单个 token 或带引号） */
const CACHE_DIR_NAME_RE = /^updaterCacheDirName:\s*(.+?)\s*$/m;

/**
 * 目录名白名单：仅允许字母数字/点/下划线/连字符
 *
 * 该值虽由我们打包时生成（app-update.yml 随应用分发），此处仍做白名单校验——
 * 纵深防御：拒绝路径穿越（如 `../evil`）与任意形态的值，保证派生路径必然
 * 落在平台缓存根之下。
 */
const CACHE_DIR_NAME_SAFE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

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
 * @param resourcesPath 含配置文件的目录（打包版 process.resourcesPath；开发版 app.getAppPath()）
 * @param cacheRoot 缓存根（默认按平台推导；测试注入临时目录，避免触碰真实缓存）
 * @param ymlFileName 配置文件名（打包版 app-update.yml；开发版 dev-app-update.yml）
 * @returns 缓存目录绝对路径；无法解析时为 null
 */
export async function resolveUpdaterCacheDir(
  resourcesPath: string,
  cacheRoot: string = getAppCacheRoot(),
  ymlFileName: string = 'app-update.yml',
): Promise<string | null> {
  let yml: string;
  try {
    yml = await readFile(join(resourcesPath, ymlFileName), 'utf8');
  } catch {
    // 无 app-update.yml（开发模式）或读取失败：不展示、不清理
    return null;
  }
  const dirName = yml.match(CACHE_DIR_NAME_RE)?.[1]?.replace(/^['"]|['"]$/g, '');
  if (dirName === undefined || dirName === '' || !CACHE_DIR_NAME_SAFE_RE.test(dirName)) {
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

/** 基线剔除结果：pruned=已剔除陈旧块图；consistent=与基准同版本；absent=无基线文件可用 */
export type BaselinePruneResult = 'pruned' | 'consistent' | 'absent';

/**
 * 剔除陈旧的差分基准块图
 *
 * 背景（2026-09-19 实测根因）：electron-updater 差分重建时，旧块图优先取自
 * 缓存根目录的 current.blockmap，而基准安装包是 NSIS 安装时写入的
 * installer.exe。两者版本错位时（如手动安装新版，或旧块图残留），重建必然
 * sha512 校验失败并回退全量——用户侧表现为「明明差分下完又重下一遍 300MB」。
 * 实测：块图=v1.2.0、基准包=v1.2.1 时 1019 个变更块全部错位，重建产物哈希
 * 与日志中的失败值逐字节一致。
 *
 * 处理：总块大小与 installer.exe 不一致即剔除块图（库随后会按当前版本从
 * release 重新下载匹配的旧块图，差分得以继续；剔除阻塞下载时最坏退化为
 * 与库原行为相同的全量下载）。块图无法解析同样剔除。
 *
 * @param cacheDir 更新缓存目录（resolveUpdaterCacheDir 的结果）
 */
export async function pruneStaleDifferentialBaseline(
  cacheDir: string,
): Promise<BaselinePruneResult> {
  const blockMapPath = join(cacheDir, 'current.blockmap');
  const installerPath = join(cacheDir, 'installer.exe');
  const [installerInfo, blockMapTotal] = await Promise.all([
    stat(installerPath).catch(() => null),
    readBlockMapTotalSize(blockMapPath),
  ]);
  // 无基准安装包（从未安装过/被清理）：差分本就无从谈起，不处理
  if (installerInfo === null) {
    return 'absent';
  }
  // 块图缺失：库会自行下载与当前版本匹配的旧块图，无需处理
  if (blockMapTotal === null) {
    return 'absent';
  }
  if (blockMapTotal === installerInfo.size) {
    return 'consistent';
  }
  await rm(blockMapPath, { force: true });
  return 'pruned';
}

/**
 * 读取块图描述的完整文件大小（sizes 求和）
 *
 * 块图为 gzip(JSON)；任何读取/解析失败返回 null（调用方视为不可用）。
 */
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
