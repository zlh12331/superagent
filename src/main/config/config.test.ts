// config.test.ts：config 模块契约测试——环境判定三层优先级（APP_ENV > NODE_ENV=test > app.isPackaged）、
// env 覆盖默认值、环境分级 logLevel、单例/重置语义
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAppConfig, resetConfigCache } from './index';

const { mockApp } = vi.hoisted(() => ({
  mockApp: {
    isPackaged: false,
    getPath: vi.fn((name: string) => `/tmp/test-userdata/${name}`),
  },
}));

vi.mock('electron', () => ({ app: mockApp }));

describe('appConfig', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    mockApp.isPackaged = false;
    delete process.env['APP_ENV'];
    resetConfigCache();
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
    mockApp.isPackaged = false;
  });

  it('默认环境（NODE_ENV=test）：appEnv=test, isDev=true, isTest=true', async () => {
    delete process.env['APP_ENV'];
    delete process.env['SENTRY_DSN'];
    delete process.env['DEEPSEEK_API_BASE'];

    const { loadConfig } = await import('../config/index');
    const config = loadConfig();

    expect(config.appEnv).toBe('test');
    expect(config.isDev).toBe(true);
    expect(config.isTest).toBe(true);
    expect(config.isPackaged).toBe(false);
    expect(config.logLevel).toBe('error');
    expect(config.providers.deepseek).toBe('https://api.deepseek.com');
    expect(config.providers.openai).toBe('https://api.openai.com');
    expect(config.providers.anthropic).toBe('https://api.anthropic.com');
    expect(config.providers.ollama).toBe('http://localhost:11434');
  });

  it('从 process.env 读取配置覆盖默认值', async () => {
    process.env['DEEPSEEK_API_BASE'] = 'https://custom.api.com';
    process.env['ANTHROPIC_API_BASE'] = 'https://custom-anthropic.api.com';
    process.env['LOG_LEVEL'] = 'debug';

    const { loadConfig } = await import('../config/index');
    const config = loadConfig();

    expect(config.providers.deepseek).toBe('https://custom.api.com');
    expect(config.providers.anthropic).toBe('https://custom-anthropic.api.com');
    expect(config.logLevel).toBe('debug');
  });

  it('APP_ENV=production：isDev=false, isTest=false', async () => {
    process.env['APP_ENV'] = 'production';

    const { loadConfig } = await import('../config/index');
    const config = loadConfig();

    expect(config.appEnv).toBe('production');
    expect(config.isDev).toBe(false);
    expect(config.isTest).toBe(false);
    expect(config.isPackaged).toBe(false);
    expect(config.logLevel).toBe('info');
    expect(config.providers.deepseek).toBe('https://api.deepseek.com');
  });

  it('APP_ENV=development：isDev=true, isTest=false', async () => {
    process.env['APP_ENV'] = 'development';

    const { loadConfig } = await import('../config/index');
    const config = loadConfig();

    expect(config.appEnv).toBe('development');
    expect(config.isDev).toBe(true);
    expect(config.isTest).toBe(false);
    expect(config.logLevel).toBe('debug');
  });

  it('app.isPackaged=true 且无 APP_ENV/NODE_ENV：appEnv=production', async () => {
    mockApp.isPackaged = true;
    delete process.env['APP_ENV'];
    delete process.env['NODE_ENV'];

    const { loadConfig } = await import('../config/index');
    const config = loadConfig();

    expect(config.appEnv).toBe('production');
    expect(config.isDev).toBe(false);
    expect(config.isPackaged).toBe(true);
  });

  it('APP_ENV 优先级高于 app.isPackaged', async () => {
    mockApp.isPackaged = true;
    process.env['APP_ENV'] = 'development';

    const { loadConfig } = await import('../config/index');
    const config = loadConfig();

    expect(config.appEnv).toBe('development');
    expect(config.isDev).toBe(true);
    expect(config.isPackaged).toBe(true);
  });

  it('getAppConfig 返回单例', () => {
    const a = getAppConfig();
    const b = getAppConfig();
    expect(a).toBe(b);
  });

  it('resetConfigCache 后 getAppConfig 返回新实例', () => {
    const a = getAppConfig();
    resetConfigCache();
    const b = getAppConfig();
    expect(a).not.toBe(b);
  });
});
