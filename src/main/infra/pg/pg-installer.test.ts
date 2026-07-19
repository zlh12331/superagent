// src/main/infra/pg/pg-installer.test.ts
// pg-installer 单元测试
//
// 测试策略：
// 1. vi.mock('node:fs') 替换 existsSync（用于 isPgInitialized）
// 2. vi.mock('node:child_process') 替换 spawn（用于 initdb）
// 3. vi.mock('electron') 替换 app（config 模块与 app-data 模块均依赖 electron）
// 4. 静态 import 被测模块（避免 vitest 4 dynamic import hoisting 问题，详见计划注意事项 #9）

import { AppError } from '@novel-writer/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Vitest 4 的 vi.mock 会被 hoist 到文件顶部，工厂函数内不能直接引用外部 const
// 必须用 vi.hoisted 导出 mock 对象（参考 pg-controller.test.ts / client.test.ts）
const { mockExistsSync, mockSpawn, mockApp } = vi.hoisted(() => ({
  // existsSync：默认返回 false（数据目录未初始化）
  mockExistsSync: vi.fn(),
  // spawn：返回 mock child process，具体行为由测试用例设置
  mockSpawn: vi.fn(),
  // app：config 模块与 app-data 模块依赖 electron app
  mockApp: {
    isPackaged: false,
    getPath: vi.fn((name: string) => `C:/test-userdata/${name}`),
    // getAppPath：pg-installer 在 dev 环境用 app.getAppPath() 找项目内便携版 PG
    getAppPath: vi.fn(() => 'F:/TraeProjects/1'),
  },
}));

vi.mock('node:fs', () => ({ existsSync: mockExistsSync }));
vi.mock('node:child_process', () => ({ spawn: mockSpawn }));
vi.mock('electron', () => ({ app: mockApp }));

// 静态导入被测模块：vi.mock 已 hoist 到文件顶部，mock 此时已生效
import { resetConfigCache } from '../../config';
import {
  ensureInstalled,
  getPgBinaryPath,
  getPgDataDir,
  initdb,
  isPgInitialized,
  isPortablePgAvailable,
  switchVersion,
} from './pg-installer';

/**
 * Mock ChildProcess 工厂
 *
 * 支持事件触发：emitExit / emitStderr / emit
 * 用于模拟 initdb 进程的 exit / error / stdout / stderr 事件
 *
 * 注意：on(event, cb) 会覆盖式保存 listener，每个事件仅支持 1 个 listener
 * （pg-installer.ts 中只注册一次 exit/error/data，足够使用）
 */
function createMockChild() {
  const handlers: Record<string, (...args: unknown[]) => void> = {};
  return {
    stdout: {
      on: (_event: string, cb: (...args: unknown[]) => void) => {
        handlers.stdout = cb;
      },
    },
    stderr: {
      on: (_event: string, cb: (...args: unknown[]) => void) => {
        handlers.stderr = cb;
      },
    },
    on: (event: string, cb: (...args: unknown[]) => void) => {
      handlers[event] = cb;
    },
    kill: vi.fn(),
    pid: 12345,
    /** 触发 on(event, ...) 注册的事件回调 */
    emit: (event: string, ...args: unknown[]) => handlers[event]?.(...args),
    /** 触发 stderr 的 data 事件（initdb 失败时用于收集错误信息） */
    emitStderr: (text: string) => handlers.stderr?.(Buffer.from(text)),
    /** 触发 exit 事件（code=0 成功；非 0 失败） */
    emitExit: (code: number, signal: string | null = null) => handlers.exit?.(code, signal),
  };
}

describe('pg-installer', () => {
  beforeEach(() => {
    // mockReset 而非 clearAllMocks，确保完全隔离（计划注意事项 #6）
    mockExistsSync.mockReset();
    mockSpawn.mockReset();
    mockApp.isPackaged = false;
    resetConfigCache();
    // 清理 pg 新字段相关 env，确保默认值生效
    delete process.env.PG_VERSION;
    delete process.env.PG_RESOURCES_DIR;
    delete process.env.PG_INITDB_TIMEOUT;
  });

  afterEach(() => {
    resetConfigCache();
  });

  describe('getPgBinaryPath', () => {
    it('便携版不存在时 dev 环境应 fallback 到系统 PATH "postgres"', () => {
      // mockApp.isPackaged = false → config.isDev = true
      // existsSync 默认返回 false → 便携版不存在
      mockExistsSync.mockReturnValue(false);
      expect(getPgBinaryPath()).toBe('postgres');
    });

    it('便携版存在时 dev 环境应返回便携版绝对路径', () => {
      mockExistsSync.mockReturnValue(true);
      const path = getPgBinaryPath();
      // 应返回 <projectRoot>/resources/pg/18.4/bin/postgres.exe
      expect(path).toContain('resources');
      expect(path).toContain('pg');
      expect(path).toContain('18.4');
      expect(path).toContain('postgres.exe');
      // 应通过 existsSync 检查便携版是否存在
      expect(mockExistsSync).toHaveBeenCalledWith(expect.stringContaining('postgres.exe'));
    });

    it('应接受版本参数（17.10 便携版存在时返回 17.10 路径）', () => {
      mockExistsSync.mockReturnValue(true);
      const path = getPgBinaryPath('17.10');
      expect(path).toContain('17.10');
      expect(path).toContain('postgres.exe');
    });
  });

  describe('isPortablePgAvailable', () => {
    it('便携版 postgres.exe 存在时应返回 true', () => {
      // existsSync 返回 true → 便携版已下载
      mockExistsSync.mockReturnValue(true);
      expect(isPortablePgAvailable('17.10')).toBe(true);
      // 应检查指定版本的 postgres.exe 路径
      expect(mockExistsSync).toHaveBeenCalledWith(expect.stringContaining('17.10'));
      expect(mockExistsSync).toHaveBeenCalledWith(expect.stringContaining('postgres.exe'));
    });

    it('便携版 postgres.exe 不存在时应返回 false', () => {
      // existsSync 返回 false → 便携版未下载
      mockExistsSync.mockReturnValue(false);
      expect(isPortablePgAvailable('17.10')).toBe(false);
    });

    it('默认版本应为 18.4', () => {
      mockExistsSync.mockReturnValue(true);
      isPortablePgAvailable();
      // 应检查 18.4 版本的 postgres.exe
      expect(mockExistsSync).toHaveBeenCalledWith(expect.stringContaining('18.4'));
    });
  });

  describe('getPgDataDir', () => {
    it('应返回 userData 下的 pgdata-<version> 路径', () => {
      const path = getPgDataDir();
      // mockApp.getPath('userData') 返回 'C:/test-userdata/userData'
      expect(path).toContain('pgdata-18.4');
    });

    it('应根据版本参数返回不同路径', () => {
      const path = getPgDataDir('17.10');
      expect(path).toContain('pgdata-17.10');
    });
  });

  describe('isPgInitialized', () => {
    it('数据目录存在 PG_VERSION 文件应返回 true', () => {
      mockExistsSync.mockReturnValue(true);
      expect(isPgInitialized()).toBe(true);
      // 应检查 PG_VERSION 文件
      expect(mockExistsSync).toHaveBeenCalledWith(expect.stringContaining('PG_VERSION'));
    });

    it('数据目录不存在 PG_VERSION 文件应返回 false', () => {
      mockExistsSync.mockReturnValue(false);
      expect(isPgInitialized()).toBe(false);
    });
  });

  describe('initdb', () => {
    it('应成功执行 initdb（exit code 0）', async () => {
      const child = createMockChild();
      mockSpawn.mockReturnValue(child);

      const promise = initdb();
      // 触发 exit 事件（code=0 表示成功）
      child.emitExit(0);

      await expect(promise).resolves.toBeUndefined();
      expect(mockSpawn).toHaveBeenCalled();
    });

    it('initdb 失败（非 0 退出码）应抛 AppError(PG_INIT_FAILED)', async () => {
      const child = createMockChild();
      mockSpawn.mockReturnValue(child);

      const promise = initdb();
      // 触发 stderr 输出（被收集到错误信息中）
      child.emitStderr('permission denied');
      // 触发 exit 事件（code=1 表示失败）
      child.emitExit(1);

      // 验证错误为 AppError 实例且 code = PG_INIT_FAILED
      await expect(promise).rejects.toBeInstanceOf(AppError);
      // 二次断言 code（同一已 reject 的 promise 可被多次 await）
      await expect(promise).rejects.toMatchObject({ code: 'PG_INIT_FAILED' });
    });

    it('initdb 进程错误应抛 AppError(PG_INIT_FAILED)', async () => {
      const child = createMockChild();
      mockSpawn.mockReturnValue(child);

      const promise = initdb();
      // 模拟进程 spawn 失败（如 initdb 不存在，触发 error 事件）
      child.emit('error', new Error('ENOENT'));

      await expect(promise).rejects.toBeInstanceOf(AppError);
    });
  });

  describe('ensureInstalled', () => {
    it('已初始化时应跳过 initdb', async () => {
      // isPgInitialized 返回 true → ensureInstalled 直接 resolve，不调用 spawn
      mockExistsSync.mockReturnValue(true);
      await ensureInstalled();
      expect(mockSpawn).not.toHaveBeenCalled();
    });

    it('未初始化时应调用 initdb', async () => {
      // isPgInitialized 返回 false → 调用 initdb
      mockExistsSync.mockReturnValue(false);
      const child = createMockChild();
      mockSpawn.mockReturnValue(child);

      const promise = ensureInstalled();
      child.emitExit(0);

      await expect(promise).resolves.toBeUndefined();
      expect(mockSpawn).toHaveBeenCalled();
    });
  });

  describe('switchVersion', () => {
    it('切换到 17.10 应确保该版本数据目录已初始化', async () => {
      // 已初始化 → 跳过 initdb
      mockExistsSync.mockReturnValue(true);
      await switchVersion('17.10');
      // 应检查 pgdata-17.10/PG_VERSION 文件
      expect(mockExistsSync).toHaveBeenCalledWith(expect.stringContaining('pgdata-17.10'));
    });
  });
});
