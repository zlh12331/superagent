// src/main/__tests__/config.test.ts
// config 单元测试
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAppConfig, resetConfigCache } from '../config/index';

// Vitest 4 的 vi.mock 会被 hoist 到文件顶部，工厂函数内不能直接引用外部 const 变量
// 必须用 vi.hoisted 导出 mock 对象
const { mockApp } = vi.hoisted(() => ({
  mockApp: {
    isPackaged: false,
    getPath: vi.fn((name: string) => `/tmp/test-userdata/${name}`),
  },
}));

// config 模块 import { app } from 'electron'，必须 mock 否则在 Node 环境下会失败
vi.mock('electron', () => ({ app: mockApp }));

describe('appConfig', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // 每个测试前重置 env
    process.env = { ...originalEnv };
    // 重置 mock 状态
    mockApp.isPackaged = false;
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
    mockApp.isPackaged = false;
  });

  it('使用默认值生成配置', async () => {
    // 清空相关 env 变量
    delete process.env.SENTRY_DSN;
    delete process.env.DEEPSEEK_API_BASE;
    delete process.env.OLLAMA_URL;

    const { loadConfig } = await import('../config/index');
    const config = loadConfig();

    expect(config.isDev).toBe(true); // mockApp.isPackaged=false → isDev=true
    expect(config.sentry.dsn).toBe('');
    expect(config.deepseek.apiBase).toBe('https://api.deepseek.com');
    expect(config.deepseek.model).toBe('deepseek-v4-flash');
    expect(config.ollama.url).toBe('http://localhost:11434');
    expect(config.ollama.embedModel).toBe('nemotron-3-embed-1b-bf16');
    expect(config.ollama.embedDimensions).toBe(2048);
  });

  it('从 process.env 读取配置', async () => {
    process.env.SENTRY_DSN = 'http://test@example.com/1';
    process.env.DEEPSEEK_API_BASE = 'https://custom.api.com';
    process.env.OLLAMA_URL = 'http://192.168.1.100:11434';

    const { loadConfig } = await import('../config/index');
    const config = loadConfig();

    expect(config.sentry.dsn).toBe('http://test@example.com/1');
    expect(config.deepseek.apiBase).toBe('https://custom.api.com');
    expect(config.ollama.url).toBe('http://192.168.1.100:11434');
  });

  it('isPackaged=true 时 isDev=false', async () => {
    // 模拟生产环境（修改 mock 属性即可，loadConfig 每次读取 app.isPackaged）
    mockApp.isPackaged = true;

    const { loadConfig } = await import('../config/index');
    const config = loadConfig();

    expect(config.isDev).toBe(false);
    expect(config.isPackaged).toBe(true);
  });
});

describe('AppConfig - pg', () => {
  // 保存原始 env，afterEach 恢复，避免测试间 env 污染
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // 重置配置缓存，避免单例污染
    resetConfigCache();
  });

  afterEach(() => {
    // 恢复 env，确保后续测试不受影响
    process.env = { ...originalEnv };
  });

  it('应使用默认 pg 配置（DATABASE_URL 未设置时）', () => {
    delete process.env.DATABASE_URL;
    delete process.env.PG_PORT;
    delete process.env.PG_DATABASE;
    delete process.env.PG_DATA_DIR;
    delete process.env.PG_START_TIMEOUT;

    const config = getAppConfig();

    expect(config.pg.url).toBe('postgresql://nwa@localhost:5433/nwa');
    expect(config.pg.port).toBe(5433);
    expect(config.pg.database).toBe('nwa');
    expect(config.pg.dataDir).toBe('');
    expect(config.pg.startTimeout).toBe(30_000);
  });

  it('应从环境变量读取 pg 配置', () => {
    process.env.DATABASE_URL = 'postgresql://user:pass@host:6543/db';
    process.env.PG_PORT = '6543';
    process.env.PG_DATABASE = 'custom_db';
    process.env.PG_DATA_DIR = 'C:/custom/pgdata';
    process.env.PG_START_TIMEOUT = '60000';

    const config = getAppConfig();

    expect(config.pg.url).toBe('postgresql://user:pass@host:6543/db');
    expect(config.pg.port).toBe(6543);
    expect(config.pg.database).toBe('custom_db');
    expect(config.pg.dataDir).toBe('C:/custom/pgdata');
    expect(config.pg.startTimeout).toBe(60_000);

    delete process.env.DATABASE_URL;
    delete process.env.PG_PORT;
    delete process.env.PG_DATABASE;
    delete process.env.PG_DATA_DIR;
    delete process.env.PG_START_TIMEOUT;
  });

  it('应拒绝无效端口（0 / 负数 / 超过 65535）', () => {
    process.env.PG_PORT = '0';
    resetConfigCache();
    expect(() => getAppConfig()).toThrow();
    resetConfigCache();

    process.env.PG_PORT = '-1';
    expect(() => getAppConfig()).toThrow();
    resetConfigCache();

    process.env.PG_PORT = '70000';
    expect(() => getAppConfig()).toThrow();

    delete process.env.PG_PORT;
  });

  it('应拒绝无效 URL', () => {
    process.env.DATABASE_URL = 'not-a-url';
    resetConfigCache();
    expect(() => getAppConfig()).toThrow();
    delete process.env.DATABASE_URL;
  });

  it('应使用默认 version 与 initdbTimeout', () => {
    // 清空 pg 新字段相关 env，验证默认值
    delete process.env.PG_VERSION;
    delete process.env.PG_INITDB_TIMEOUT;
    delete process.env.PG_RESOURCES_DIR;
    resetConfigCache();

    const config = getAppConfig();

    expect(config.pg.version).toBe('18.4');
    expect(config.pg.initdbTimeout).toBe(60_000);
    expect(config.pg.resourcesDir).toBe('');
  });

  it('应从环境变量读取 version 与 initdbTimeout', () => {
    process.env.PG_VERSION = '17.10';
    process.env.PG_INITDB_TIMEOUT = '120000';
    process.env.PG_RESOURCES_DIR = 'C:/custom/pg';
    resetConfigCache();

    const config = getAppConfig();

    expect(config.pg.version).toBe('17.10');
    expect(config.pg.initdbTimeout).toBe(120_000);
    expect(config.pg.resourcesDir).toBe('C:/custom/pg');

    delete process.env.PG_VERSION;
    delete process.env.PG_INITDB_TIMEOUT;
    delete process.env.PG_RESOURCES_DIR;
  });
});
