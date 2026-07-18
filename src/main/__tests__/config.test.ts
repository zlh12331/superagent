// src/main/__tests__/config.test.ts
// config 单元测试
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
