// src/main/infra/services.smoke.test.ts
// 主进程 5 个 service 的 smoke test
// ──────────────────────────────────────────────────────────────
// 目标：验证单例获取、接口方法存在、dispose 不抛错
// 不验证具体行为（那需要 mock 外部依赖，属于单元测试范畴）
//
// 覆盖 service：
// - FileService（文件读写 + chokidar 监听）
// - GitService（git CLI 封装）
// - SearchService（ripgrep 封装）
// - CodebaseService（codegraph CLI 封装）
// - TerminalService（node-pty 终端池）
// ──────────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest';
import { getCodebaseService } from './codebase/codebase-service';
import { getFileService } from './file/file-service';
import { getGitService } from './git/git-service';
import { getSearchService } from './search/search-service';
import { getTerminalService } from './terminal/terminal-service';

describe('service smoke tests', () => {
  describe('FileService', () => {
    it('getFileService 返回单例实例', () => {
      const a = getFileService();
      const b = getFileService();
      expect(a).toBe(b);
    });

    it('接口方法存在', () => {
      const svc = getFileService();
      expect(typeof svc.read).toBe('function');
      expect(typeof svc.write).toBe('function');
      expect(typeof svc.list).toBe('function');
      expect(typeof svc.watch).toBe('function');
      expect(typeof svc.unwatch).toBe('function');
      expect(typeof svc.dispose).toBe('function');
    });

    it('dispose 不抛错', async () => {
      const svc = getFileService();
      await expect(svc.dispose()).resolves.not.toThrow();
    });
  });

  describe('GitService', () => {
    it('getGitService 返回单例实例', () => {
      const a = getGitService();
      const b = getGitService();
      expect(a).toBe(b);
    });

    it('接口方法存在', () => {
      const svc = getGitService();
      expect(typeof svc.status).toBe('function');
      expect(typeof svc.diff).toBe('function');
      expect(typeof svc.dispose).toBe('function');
    });

    it('dispose 不抛错', async () => {
      const svc = getGitService();
      await expect(svc.dispose()).resolves.not.toThrow();
    });
  });

  describe('SearchService', () => {
    it('getSearchService 返回单例实例', () => {
      const a = getSearchService();
      const b = getSearchService();
      expect(a).toBe(b);
    });

    it('接口方法存在', () => {
      const svc = getSearchService();
      expect(typeof svc.grep).toBe('function');
      expect(typeof svc.glob).toBe('function');
      expect(typeof svc.dispose).toBe('function');
    });

    it('dispose 不抛错', async () => {
      const svc = getSearchService();
      await expect(svc.dispose()).resolves.not.toThrow();
    });
  });

  describe('CodebaseService', () => {
    it('getCodebaseService 返回单例实例', () => {
      const a = getCodebaseService();
      const b = getCodebaseService();
      expect(a).toBe(b);
    });

    it('接口方法存在', () => {
      const svc = getCodebaseService();
      expect(typeof svc.query).toBe('function');
      expect(typeof svc.explore).toBe('function');
      expect(typeof svc.node).toBe('function');
      expect(typeof svc.callers).toBe('function');
      expect(typeof svc.callees).toBe('function');
      expect(typeof svc.impact).toBe('function');
      expect(typeof svc.dispose).toBe('function');
    });

    it('dispose 不抛错', async () => {
      const svc = getCodebaseService();
      await expect(svc.dispose()).resolves.not.toThrow();
    });
  });

  describe('TerminalService', () => {
    it('getTerminalService 返回单例实例', () => {
      const a = getTerminalService();
      const b = getTerminalService();
      expect(a).toBe(b);
    });

    it('接口方法存在', () => {
      const svc = getTerminalService();
      expect(typeof svc.create).toBe('function');
      expect(typeof svc.input).toBe('function');
      expect(typeof svc.resize).toBe('function');
      expect(typeof svc.kill).toBe('function');
      expect(typeof svc.dispose).toBe('function');
    });

    it('dispose 不抛错', async () => {
      const svc = getTerminalService();
      await expect(svc.dispose()).resolves.not.toThrow();
    });
  });
});
