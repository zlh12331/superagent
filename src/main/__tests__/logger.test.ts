// src/main/__tests__/logger.test.ts
// logger 单元测试
// 注意：electron-log 在测试环境 mock 为内存缓冲，验证日志格式与级别
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Vitest 4 的 vi.mock 会被 hoist 到文件顶部，工厂函数内不能直接引用外部 const 变量
// 必须用 vi.hoisted 导出 mock 对象，工厂函数才能引用
// 参考 https://vitest.dev/guide/mocking.html#hoisting
const { mockLog } = vi.hoisted(() => {
  const mockLog = {
    level: 'info',
    transports: {
      file: { level: 'info', maxRetries: 0, fileName: 'main.log' },
      console: { level: 'debug' },
    },
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    initialize: vi.fn(),
  };
  return { mockLog };
});

// mock electron-log，避免文件写入
vi.mock('electron-log', () => ({ default: mockLog }));

// mock electron app（用于 isPackaged 判断 + getPath）
vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: vi.fn(() => '/tmp/test-userdata') },
}));

import { initLogger, logger, registerGlobalErrorHandlers } from '../utils/logger';

describe('logger', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('暴露 info/warn/error/debug 方法', () => {
    expect(typeof logger.info).toBe('function');
    expect(typeof logger.warn).toBe('function');
    expect(typeof logger.error).toBe('function');
    expect(typeof logger.debug).toBe('function');
  });

  it('info 日志携带 traceId 字段', () => {
    initLogger();
    logger.info({ traceId: 'test-trace-123', channel: 'project:create' }, 'IPC 请求开始');
    expect(mockLog.info).toHaveBeenCalledWith(
      expect.objectContaining({
        traceId: 'test-trace-123',
        channel: 'project:create',
        message: 'IPC 请求开始',
      }),
    );
  });

  it('error 日志支持 Error 对象', () => {
    const err = new Error('测试错误');
    logger.error({ traceId: 't1' }, '操作失败', err);
    expect(mockLog.error).toHaveBeenCalled();
  });

  it('registerGlobalErrorHandlers 注册 process 事件', () => {
    const onSpy = vi.spyOn(process, 'on');
    registerGlobalErrorHandlers();
    expect(onSpy).toHaveBeenCalledWith('uncaughtException', expect.any(Function));
    expect(onSpy).toHaveBeenCalledWith('unhandledRejection', expect.any(Function));
    onSpy.mockRestore();
  });
});
