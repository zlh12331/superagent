// src/main/config/config.test.ts
// config 单元测试（P2-8 环境分层：dev/prod/test）
//
// 测试要点：
// 1. 默认环境推断：APP_ENV > NODE_ENV > app.isPackaged
// 2. test 环境（NODE_ENV=test 自动触发）的特定默认值
// 3. APP_ENV 显式覆盖优先级最高
// 4. 从 process.env 读取配置覆盖默认值
// 5. getAppConfig 单例 + resetConfigCache 重置

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAppConfig, resetConfigCache } from './index';

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
  // 保存原始 env，测试后恢复（避免污染其他测试）
  // 注意：Vitest 自动设置 NODE_ENV=test，原始值就是 'test'
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // 每个测试前重置 env（保留原始值，但测试中可覆盖）
    process.env = { ...originalEnv };
    // 重置 mock 状态
    mockApp.isPackaged = false;
    // 删除 APP_ENV（避免上一个测试的设置污染当前测试）
    delete process.env['APP_ENV'];
    // 重置配置缓存，避免单例污染
    resetConfigCache();
    vi.clearAllMocks();
  });

  afterEach(() => {
    // 恢复原始 env
    process.env = originalEnv;
    mockApp.isPackaged = false;
  });

  it('默认环境（NODE_ENV=test）：appEnv=test, isDev=true, isTest=true', async () => {
    // 不设置 APP_ENV，保留 Vitest 自动设置的 NODE_ENV=test
    delete process.env['APP_ENV'];
    delete process.env['SENTRY_DSN'];
    delete process.env['DEEPSEEK_API_BASE'];

    const { loadConfig } = await import('../config/index');
    const config = loadConfig();

    // NODE_ENV=test → appEnv=test
    expect(config.appEnv).toBe('test');
    // test 环境视为开发环境特化（isDev=true）
    expect(config.isDev).toBe(true);
    expect(config.isTest).toBe(true);
    expect(config.isPackaged).toBe(false);
    // test 环境默认值
    expect(config.logLevel).toBe('error');
    expect(config.sentry.dsn).toBe('');
    expect(config.sentry.tracesSampleRate).toBe(0);
    expect(config.deepseek.timeout).toBe(5_000);
    // 默认 deepseek 配置
    expect(config.deepseek.apiBase).toBe('https://api.deepseek.com');
    expect(config.deepseek.model).toBe('deepseek-v4-flash');
  });

  it('从 process.env 读取配置覆盖默认值', async () => {
    process.env['SENTRY_DSN'] = 'http://test@example.com/1';
    process.env['DEEPSEEK_API_BASE'] = 'https://custom.api.com';
    process.env['LOG_LEVEL'] = 'debug';
    process.env['DEEPSEEK_TIMEOUT'] = '30000';

    const { loadConfig } = await import('../config/index');
    const config = loadConfig();

    expect(config.sentry.dsn).toBe('http://test@example.com/1');
    expect(config.deepseek.apiBase).toBe('https://custom.api.com');
    expect(config.logLevel).toBe('debug');
    expect(config.deepseek.timeout).toBe(30_000);
  });

  it('APP_ENV=production：isDev=false, isTest=false', async () => {
    // 显式设置 production，覆盖 NODE_ENV=test 的推断
    process.env['APP_ENV'] = 'production';
    // mockApp.isPackaged 仍为 false（证明 APP_ENV 优先级高于 isPackaged）

    const { loadConfig } = await import('../config/index');
    const config = loadConfig();

    expect(config.appEnv).toBe('production');
    expect(config.isDev).toBe(false);
    expect(config.isTest).toBe(false);
    expect(config.isPackaged).toBe(false);
    // production 默认 logLevel=info（非 test 环境）
    expect(config.logLevel).toBe('info');
    // production 默认 Sentry 采样率 0.1
    expect(config.sentry.tracesSampleRate).toBe(0.1);
    // production 默认 DeepSeek timeout=60s
    expect(config.deepseek.timeout).toBe(60_000);
  });

  it('APP_ENV=development：isDev=true, isTest=false', async () => {
    // 显式设置 development，覆盖 NODE_ENV=test 的推断
    process.env['APP_ENV'] = 'development';

    const { loadConfig } = await import('../config/index');
    const config = loadConfig();

    expect(config.appEnv).toBe('development');
    expect(config.isDev).toBe(true);
    expect(config.isTest).toBe(false);
    // development 默认 logLevel=debug
    expect(config.logLevel).toBe('debug');
    // development 默认 Sentry 采样率 0.1
    expect(config.sentry.tracesSampleRate).toBe(0.1);
    // development 默认 DeepSeek timeout=60s
    expect(config.deepseek.timeout).toBe(60_000);
  });

  it('app.isPackaged=true 且无 APP_ENV/NODE_ENV：appEnv=production', async () => {
    // 模拟生产打包：isPackaged=true，删除 APP_ENV 和 NODE_ENV 让推断走 isPackaged 路径
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
    // 即使 isPackaged=true，APP_ENV=development 也能覆盖
    mockApp.isPackaged = true;
    process.env['APP_ENV'] = 'development';

    const { loadConfig } = await import('../config/index');
    const config = loadConfig();

    // APP_ENV 优先级最高，覆盖 isPackaged 推断
    expect(config.appEnv).toBe('development');
    expect(config.isDev).toBe(true);
    // 但 isPackaged 仍是运行时事实（独立于 appEnv）
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
