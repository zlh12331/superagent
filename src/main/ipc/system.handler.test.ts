import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockApp } = vi.hoisted(() => ({
  mockApp: {
    getPath: vi.fn((name: string) => `/tmp/${name}`),
    getVersion: vi.fn(() => '1.0.0-test'),
    isPackaged: false,
  },
}));

vi.mock('electron', () => ({ app: mockApp }));

import { logsHandlers, systemHandlers } from './system.handler';

let tempDir: string;

describe('system.handler', () => {
  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'code-agent-system-test-'));
    mockApp.getPath.mockImplementation((name: string) =>
      name === 'logs' ? tempDir : `/tmp/${name}`,
    );
  });

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    try {
      rmSync(join(tempDir, 'main.log'), { force: true });
    } catch {}
  });

  describe('getStatus', () => {
    it('返回完整运行时状态字段', async () => {
      const result = await systemHandlers.getStatus(undefined, {} as never);
      expect(result).toMatchObject({
        appVersion: '1.0.0-test',
        platform: process.platform,
        isPackaged: false,
        pid: process.pid,
      });
      expect(result.uptimeSeconds).toBeGreaterThanOrEqual(0);
      expect(result.memory.rss).toBeGreaterThan(0);
      expect(typeof result.timestamp).toBe('string');
    });
  });

  describe('read（logs:read）', () => {
    it('读取日志文件最近行（正序）', async () => {
      const lines = ['[info] line 1', '[warn] line 2', '[error] line 3'];
      writeFileSync(join(tempDir, 'main.log'), lines.join('\n'), 'utf8');

      const result = await logsHandlers.read({ lines: 10 }, {} as never);
      expect(result.lines).toEqual(lines);
      expect(result.total).toBe(3);
      expect(result.truncated).toBe(false);
    });

    it('lines 上限截断：超过 MAX_LINES 标记 truncated', async () => {
      writeFileSync(join(tempDir, 'main.log'), '[info] x\n', 'utf8');
      const result = await logsHandlers.read({ lines: 9999 }, {} as never);
      expect(result.truncated).toBe(true);
    });

    it('level 过滤：只返回匹配级别', async () => {
      const lines = ['[info] a', '[error] b', '[info] c'];
      writeFileSync(join(tempDir, 'main.log'), lines.join('\n'), 'utf8');

      const result = await logsHandlers.read({ lines: 10, level: 'error' }, {} as never);
      expect(result.lines).toEqual(['[error] b']);
    });

    it('文件不存在：返回空结果不抛错', async () => {
      const result = await logsHandlers.read({ lines: 10 }, {} as never);
      expect(Array.isArray(result.lines)).toBe(true);
      expect(result.total).toBe(0);
    });
  });
});
