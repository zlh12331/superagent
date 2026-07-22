// src/main/infra/storage/app-data.test.ts
// app-data 路径管理单测
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Vitest 4 的 vi.mock 会被 hoist，工厂函数内不能引用外部 const
// 必须用 vi.hoisted 导出 mock 函数
const { mockGetPath } = vi.hoisted(() => ({
  mockGetPath: vi.fn((name: string) => `/tmp/test-userdata/${name}`),
}));

vi.mock('electron', () => ({
  app: {
    getPath: mockGetPath,
    isPackaged: false,
  },
}));

import {
  getBackupsPath,
  getCachePath,
  getKeychainPath,
  getLogsPath,
  getUserDataPath,
} from './app-data';

// mockGetPath('userData') 的返回值
// 注意：使用 path.join 构建期望值，确保跨平台路径分隔符一致
const MOCK_USER_DATA = '/tmp/test-userdata/userData';

describe('app-data', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('getUserDataPath 返回 userData 基路径', () => {
    const path = getUserDataPath();
    expect(mockGetPath).toHaveBeenCalledWith('userData');
    expect(path).toBe(MOCK_USER_DATA);
  });

  it('getLogsPath 返回 logs 子目录', () => {
    const path = getLogsPath();
    // 使用 path.join 构建期望值，跨平台兼容（Windows 用 \，Unix 用 /）
    expect(path).toBe(join(MOCK_USER_DATA, 'logs'));
  });

  it('getBackupsPath 返回 backups 子目录', () => {
    const path = getBackupsPath();
    expect(path).toBe(join(MOCK_USER_DATA, 'backups'));
  });

  it('getCachePath 返回 cache 子目录', () => {
    const path = getCachePath();
    expect(path).toBe(join(MOCK_USER_DATA, 'cache'));
  });

  it('getKeychainPath 返回 keychain 文件路径', () => {
    const path = getKeychainPath();
    expect(path).toBe(join(MOCK_USER_DATA, 'keychain.dat'));
  });
});
