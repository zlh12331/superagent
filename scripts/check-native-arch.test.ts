// scripts/check-native-arch.test.ts
// 产物 resources 路径推导单测（macOS 与其余平台）
// ──────────────────────────────────────────────────────────────
// 覆盖动机（2026-09-20 首次 CD 实测事故）：resourcesDirOf 曾对 macOS 返回
// `<dir>/resources`（而实际是 `<dir>/<App>.app/Contents/Resources`），导致
// macOS job 报「已检查 0 个二进制」却仍然通过——一个静默漏洞：架构错配在 macOS
// 上完全不被检测。本用例用真实临时目录树锚定该路径推导。
// ──────────────────────────────────────────────────────────────

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resourcesDirOf } from './check-native-arch';

describe('resourcesDirOf', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'native-arch-resources-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  describe('macOS（.app 包内路径）', () => {
    it('mac-arm64：返回 <dir>/<App>.app/Contents/Resources（回归锚）', () => {
      const dir = join(root, 'mac-arm64');
      const appName = 'Code Agent Desktop.app';
      mkdirSync(join(dir, appName, 'Contents', 'Resources'), { recursive: true });

      const result = resourcesDirOf(dir);
      expect(result).toBe(join(dir, appName, 'Contents', 'Resources'));
      // 关键断言：不能回退成 <dir>/resources（那会让检查器一个都查不到）
      expect(result).not.toBe(join(dir, 'resources'));
    });

    it('mac（x64 默认目录名）同样解析到 .app 内', () => {
      const dir = join(root, 'mac');
      const appName = 'Code Agent Desktop.app';
      mkdirSync(join(dir, appName, 'Contents', 'Resources'), { recursive: true });

      expect(resourcesDirOf(dir)).toBe(join(dir, appName, 'Contents', 'Resources'));
    });

    it('mac-x64 也适用', () => {
      const dir = join(root, 'mac-x64');
      mkdirSync(join(dir, 'App.app', 'Contents', 'Resources'), { recursive: true });
      expect(resourcesDirOf(dir)).toBe(join(dir, 'App.app', 'Contents', 'Resources'));
    });

    it('无 .app（构建未完成/异常布局）→ 回退 <dir>/resources（不抛错）', () => {
      const dir = join(root, 'mac-arm64');
      mkdirSync(dir, { recursive: true });
      expect(resourcesDirOf(dir)).toBe(join(dir, 'resources'));
    });

    it('目录不存在 → 回退且不抛错', () => {
      expect(resourcesDirOf(join(root, 'mac-nonexistent'))).toBe(
        join(root, 'mac-nonexistent', 'resources'),
      );
    });
  });

  describe('Windows / Linux（直接 resources/）', () => {
    it('win-unpacked / win-arm64-unpacked → <dir>/resources', () => {
      for (const name of ['win-unpacked', 'win-arm64-unpacked']) {
        const dir = join(root, name);
        mkdirSync(join(dir, 'resources'), { recursive: true });
        expect(resourcesDirOf(dir), name).toBe(join(dir, 'resources'));
      }
    });

    it('linux-unpacked / linux-arm64-unpacked → <dir>/resources', () => {
      for (const name of ['linux-unpacked', 'linux-arm64-unpacked']) {
        const dir = join(root, name);
        mkdirSync(join(dir, 'resources'), { recursive: true });
        expect(resourcesDirOf(dir), name).toBe(join(dir, 'resources'));
      }
    });

    it('非 mac 目录即便含 .app 也不进入 macOS 分支（按目录名判定）', () => {
      const dir = join(root, 'linux-unpacked');
      mkdirSync(join(dir, 'Something.app', 'Contents', 'Resources'), { recursive: true });
      mkdirSync(join(dir, 'resources'), { recursive: true });
      expect(resourcesDirOf(dir)).toBe(join(dir, 'resources'));
    });
  });

  it('返回的路径以传入目录名为基础（不依赖 cwd）', () => {
    const dir = join(root, 'win-unpacked');
    mkdirSync(dir, { recursive: true });
    expect(basename(resourcesDirOf(dir))).toBe('resources');
    expect(resourcesDirOf(dir).startsWith(dir)).toBe(true);
  });

  it('真实场景：mac 目录内多个 .app 时取第一个（构建产物只应有一个）', () => {
    const dir = join(root, 'mac-arm64');
    mkdirSync(join(dir, 'A.app', 'Contents', 'Resources'), { recursive: true });
    writeFileSync(join(dir, 'readme.txt'), 'x');
    const result = resourcesDirOf(dir);
    expect(result.endsWith(join('Contents', 'Resources'))).toBe(true);
  });
});
