// src/main/infra/update/update-cache.test.ts
// 更新缓存模块单测：目录解析（真实临时目录，绝不触碰真实缓存）/ 占用统计 / 清理
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  clearUpdateCache,
  measureDirRecursive,
  readUpdateCacheInfo,
  resolveUpdaterCacheDir,
} from './update-cache';

describe('update-cache', () => {
  let root: string;
  let resourcesPath: string;
  let cacheRoot: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'update-cache-test-'));
    resourcesPath = join(root, 'resources');
    cacheRoot = join(root, 'cache-root');
    await mkdir(resourcesPath, { recursive: true });
    await mkdir(cacheRoot, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  describe('resolveUpdaterCacheDir', () => {
    it('读取 app-update.yml 的 updaterCacheDirName 并拼到缓存根', async () => {
      await writeFile(
        join(resourcesPath, 'app-update.yml'),
        'provider: github\nupdaterCacheDirName: code-agent-desktop-updater\nchannel: latest\n',
      );
      expect(await resolveUpdaterCacheDir(resourcesPath, cacheRoot)).toBe(
        join(cacheRoot, 'code-agent-desktop-updater'),
      );
    });

    it('无 app-update.yml（开发模式）→ null（不猜路径）', async () => {
      expect(await resolveUpdaterCacheDir(resourcesPath, cacheRoot)).toBeNull();
    });

    it('yml 缺 updaterCacheDirName 键 → null', async () => {
      await writeFile(join(resourcesPath, 'app-update.yml'), 'provider: github\n');
      expect(await resolveUpdaterCacheDir(resourcesPath, cacheRoot)).toBeNull();
    });

    it('带引号的值也解析', async () => {
      await writeFile(join(resourcesPath, 'app-update.yml'), 'updaterCacheDirName: "my-updater"\n');
      expect(await resolveUpdaterCacheDir(resourcesPath, cacheRoot)).toBe(
        join(cacheRoot, 'my-updater'),
      );
    });
  });

  describe('measureDirRecursive', () => {
    it('递归统计文件数与字节数', async () => {
      const dir = join(cacheRoot, 'pending');
      await mkdir(join(dir, 'nested'), { recursive: true });
      await writeFile(join(dir, 'a.bin'), 'abc'); // 3 字节
      await writeFile(join(dir, 'nested', 'b.bin'), 'defg'); // 4 字节
      expect(await measureDirRecursive(dir)).toEqual({ bytes: 7, fileCount: 2 });
    });

    it('目录不存在 → 0（不抛错）', async () => {
      expect(await measureDirRecursive(join(cacheRoot, 'missing'))).toEqual({
        bytes: 0,
        fileCount: 0,
      });
    });
  });

  describe('readUpdateCacheInfo / clearUpdateCache', () => {
    it('解析到目录时返回占用；清理后目录消失且占用归零', async () => {
      await writeFile(join(resourcesPath, 'app-update.yml'), 'updaterCacheDirName: app-updater\n');
      const cacheDir = join(cacheRoot, 'app-updater');
      await mkdir(cacheDir, { recursive: true });
      await writeFile(join(cacheDir, 'installer.exe'), 'x'.repeat(10));

      const info = await readUpdateCacheInfo(resourcesPath, cacheRoot);
      expect(info).toEqual({ path: cacheDir, bytes: 10, fileCount: 1 });

      const cleared = await clearUpdateCache(resourcesPath, cacheRoot);
      expect(cleared).toEqual({ path: cacheDir, bytes: 0, fileCount: 0 });
      await expect(readFile(join(cacheDir, 'installer.exe'), 'utf8')).rejects.toThrow();
    });

    it('无法解析缓存目录 → path 为 null（清理为空操作）', async () => {
      expect(await readUpdateCacheInfo(resourcesPath, cacheRoot)).toEqual({
        path: null,
        bytes: 0,
        fileCount: 0,
      });
      expect(await clearUpdateCache(resourcesPath, cacheRoot)).toEqual({
        path: null,
        bytes: 0,
        fileCount: 0,
      });
    });
  });
});
